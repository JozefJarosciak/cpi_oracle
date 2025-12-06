use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    program::{invoke, invoke_signed},
    system_instruction,
};
use anchor_lang::system_program::System;

declare_id!("EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF");

// =========================
// Oracle (foreign) settings
// =========================
pub const ORACLE_PROGRAM_ID: Pubkey =
    pubkey!("LuS6XnQ3qNXqNQvAJ3akXnEJRBv9XNoUricjMgTyCxX");

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct OracleStateMirror {
    pub update_authority: Pubkey,
    pub btc: Triplet,
    pub eth: Triplet,
    pub sol: Triplet,
    pub decimals: u8,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct Triplet {
    pub param1: i64, pub param2: i64, pub param3: i64,
    pub ts1: i64,    pub ts2: i64,    pub ts3: i64,
}

// ===========================
// Guarded Transaction Config (for limit orders, slippage protection, etc.)
// ===========================

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct GuardConfig {
    pub price_limit_e6: i64,  // Max price for BUY, min price for SELL (0 = no limit)
}

impl GuardConfig {
    pub fn none() -> Self {
        Self { price_limit_e6: 0 }
    }

    pub fn has_limit(&self) -> bool {
        self.price_limit_e6 > 0
    }
}

// Slippage Protection Config (percentage-based tolerance)
// ===========================

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct SlippageConfig {
    pub max_slippage_bps: u16,  // Max acceptable slippage in basis points (e.g., 500 = 5%)
}

impl SlippageConfig {
    pub fn none() -> Self {
        Self { max_slippage_bps: 0 }
    }

    pub fn has_slippage_limit(&self) -> bool {
        self.max_slippage_bps > 0
    }
}

// Advanced Guard Config (comprehensive protection with all features)
// ===========================

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct AdvancedGuardConfig {
    // Absolute price limits
    pub price_limit_e6: i64,           // 0 = no limit; max for BUY, min for SELL

    // Slippage protection with quote
    pub max_slippage_bps: u16,         // 0 = no slippage check
    pub quote_price_e6: i64,           // Reference price for slippage calc
    pub quote_timestamp: i64,          // When quote was generated (unix seconds)

    // Max cost enforcement
    pub max_total_cost_e6: i64,        // 0 = no max cost (only for BUY)

    // Partial fill support
    pub allow_partial: bool,            // Allow partial execution?
    pub min_fill_shares_e6: i64,       // Minimum shares to execute (if partial)
}

// ===========================
// Limit Order (for dark pool limit orders)
// ===========================

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct LimitOrder {
    /// Market this order is for
    pub market: Pubkey,
    /// User who owns this order
    pub user: Pubkey,
    /// Action: 1=BUY, 2=SELL
    pub action: u8,
    /// Side: 1=YES, 2=NO
    pub side: u8,
    /// Desired shares (1e6 scale)
    pub shares_e6: i64,
    /// Limit price (1e6 scale) - max for BUY, min for SELL
    pub limit_price_e6: i64,
    /// Maximum cost (for BUY orders, 1e6 scale) - set to i64::MAX if no limit
    pub max_cost_e6: i64,
    /// Minimum proceeds (for SELL orders, 1e6 scale) - set to 0 if no limit
    pub min_proceeds_e6: i64,
    /// Unix timestamp when order expires
    pub expiry_ts: i64,
    /// Unique nonce to prevent replay attacks
    pub nonce: u64,
    /// Keeper fee in basis points (10 = 0.1%, 100 = 1%)
    pub keeper_fee_bps: u16,
    /// Minimum fill percentage (basis points) - 5000 = 50%
    pub min_fill_bps: u16,
}

impl AdvancedGuardConfig {
    pub fn none() -> Self {
        Self {
            price_limit_e6: 0,
            max_slippage_bps: 0,
            quote_price_e6: 0,
            quote_timestamp: 0,
            max_total_cost_e6: 0,
            allow_partial: false,
            min_fill_shares_e6: 0,
        }
    }

    pub fn has_any_guards(&self) -> bool {
        self.price_limit_e6 > 0 ||
        self.max_slippage_bps > 0 ||
        self.max_total_cost_e6 > 0
    }

    pub fn has_price_limit(&self) -> bool {
        self.price_limit_e6 > 0
    }

    pub fn has_slippage_guard(&self) -> bool {
        self.max_slippage_bps > 0 && self.quote_price_e6 > 0
    }

    pub fn has_cost_limit(&self) -> bool {
        // Only treat as active limit if it's a real constraint (not effectively unlimited)
        // MAX_SAFE_INTEGER in JS is 9007199254740991, so use that as threshold
        const EFFECTIVELY_UNLIMITED: i64 = 9_000_000_000_000_000; // 9 quadrillion (close to MAX_SAFE_INTEGER)
        self.max_total_cost_e6 > 0 && self.max_total_cost_e6 < EFFECTIVELY_UNLIMITED
    }
}

// ===========================
// Market (single) with LMSR + coverage + settlement
// ===========================

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq)]
pub enum MarketStatus { Premarket = 0, Open = 1, Stopped = 2 }

#[account]
pub struct Amm {
    // core
    pub bump: u8,
    pub decimals: u8,     // fixed point (6)
    pub b: i64,           // LMSR liquidity (1e6)
    pub fee_bps: u16,     // taker fee in bps

    // inventory (shares 1e6)
    pub q_yes: i64,
    pub q_no: i64,

    // fees accrued (1e6) - accounting mirror
    pub fees: i64,

    // coverage mirror (real lamports in vault_sol PDA)
    pub vault_e6: i64,

    // lifecycle
    pub status: u8,       // MarketStatus as u8
    pub winner: u8,       // 0=unknown, 1=YES, 2=NO

    // settlement snapshot
    pub w_total_e6: i64,  // total winning shares at stop
    pub pps_e6: i64,      // payout per winning share: min(1e6, floor(vault / W))

    // fee treasury (lamports)
    pub fee_dest: Pubkey,

    // bump for the system-owned SOL vault PDA
    pub vault_sol_bump: u8,

    // ---- NEW: oracle-based start/settle snapshots (all 1e6 fixed point) ----
    pub start_price_e6: i64,  // 0 until snapshotted
    pub start_ts: i64,        // oracle ts used for start snapshot
    pub settle_price_e6: i64, // 0 until settled-by-oracle
    pub settle_ts: i64,       // oracle ts used for settlement

    // Market timing
    pub market_end_slot: u64,   // Slot when market ends (0 = not set) - DEPRECATED, use market_end_time
    pub market_end_time: i64,   // Unix timestamp when market ends (0 = not set)
}
impl Amm {
    pub const SEED: &'static [u8] = b"amm_btc_v6";  // v6: added market_end_time for time-based trading lockout
    pub const VAULT_SOL_SEED: &'static [u8] = b"vault_sol";
    pub const SPACE: usize = core::mem::size_of::<Amm>();

    #[inline] pub fn status(&self) -> MarketStatus {
        match self.status {
            0 => MarketStatus::Premarket,
            1 => MarketStatus::Open,
            _ => MarketStatus::Stopped,
        }
    }
}

// Per-user position (PDA is per-market: [b"pos", amm, user])
#[account]
pub struct Position {
    pub owner: Pubkey,           // Session wallet address
    pub yes_shares_e6: i64,
    pub no_shares_e6: i64,
    pub master_wallet: Pubkey,   // Backpack wallet that authorized this session wallet
    pub vault_balance_e6: i64,   // User's SOL balance in vault (1e6 scale)
    pub vault_bump: u8,          // Bump for user_vault PDA
    pub used_nonces: Vec<u64>,   // Track used nonces for limit order replay protection (rolling window of last 100)
}
impl Position {
    pub const SEED: &'static [u8] = b"pos";
    pub const USER_VAULT_SEED: &'static [u8] = b"user_vault";
    // Note: SPACE is now dynamic due to Vec<u64>. Initial size + room for 100 nonces
    pub const SPACE: usize = 32 + 8 + 8 + 32 + 8 + 1 + 4 + (8 * 100);  // owner + yes + no + master_wallet + vault_balance + vault_bump + vec_len + (nonces)
    pub const MAX_NONCES: usize = 100; // Keep rolling window of last 100 nonces
}

// ---- Limits (all scaled 1e6) ----
const MIN_BUY_E6: i64   = 100_000;         // $0.10 min
const MIN_SELL_E6: i64  = 100_000;         // 0.100000 share min
const SPEND_MAX_E6: i64 = 50_000_000_000;  // $50,000 per trade
const DQ_MAX_E6: i64    = 50_000_000_000;  // 50,000,000 shares per trade

// ---- Market timing ----
const TRADING_LOCKOUT_SLOTS: u64 = 90;      // Lock trading 90 slots (~45 seconds) before market end - DEPRECATED
const TRADING_LOCKOUT_SECONDS: i64 = 45;    // Lock trading 45 seconds before market end

// ---- Events ----
#[event]
pub struct TradeSnapshot {
    pub side: u8,            // 1=YES, 2=NO
    pub action: u8,          // 1=BUY, 2=SELL
    pub net_e6: i64,         // BUY: net spend; SELL: net proceeds
    pub dq_e6: i64,          // BUY: shares minted; SELL: shares sold
    pub avg_price_e6: i64,   // average price per share (1e6)
    pub q_yes: i64,
    pub q_no: i64,
    pub vault_e6: i64,
    pub p_yes_e6: i64,
    pub fees_e6: i64,
}

#[event]
pub struct LimitOrderExecuted {
    pub user: Pubkey,
    pub keeper: Pubkey,
    pub action: u8,
    pub side: u8,
    pub shares_requested: i64,
    pub shares_executed: i64,
    pub limit_price: i64,
    pub execution_price: i64,
    pub keeper_fee_bps: u16,
    pub nonce: u64,
}

#[event]
pub struct OrderNonceCancelled {
    pub user: Pubkey,
    pub nonce: u64,
}

// ============================== Accounts ==============================

#[derive(Accounts)]
pub struct LogOracle<'info> {
    /// CHECK: read-only; we assert `owner == ORACLE_PROGRAM_ID` in the handler.
    #[account(owner = ORACLE_PROGRAM_ID)]
    pub oracle_state: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct InitAmm<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Amm::SPACE,
        seeds = [Amm::SEED],
        bump
    )]
    pub amm: Account<'info, Amm>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: fee treasury (lamports). We require `fee_dest.owner == System` in handler.
    #[account(mut)]
    pub fee_dest: UncheckedAccount<'info>,

    /// CHECK: system-owned 0-space vault PDA for SOL: seeds [VAULT_SOL_SEED, amm].
    /// We **do not** try to create this; it can simply receive lamports later.
    #[account(
        mut,
        seeds = [Amm::VAULT_SOL_SEED, amm.key().as_ref()],
        bump
    )]
    pub vault_sol: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Quote<'info> {
    #[account(seeds = [Amm::SEED], bump = amm.bump)]
    pub amm: Account<'info, Amm>,
}

#[derive(Accounts)]
pub struct InitPosition<'info> {
    #[account(seeds = [Amm::SEED], bump = amm.bump)]
    pub amm: Account<'info, Amm>,

    #[account(
        init,
        payer = master_wallet,
        space = 8 + Position::SPACE,
        seeds = [Position::SEED, amm.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub pos: Account<'info, Position>,

    /// CHECK: User vault PDA (system-owned, holds SOL)
    #[account(
        seeds = [Position::USER_VAULT_SEED, pos.key().as_ref()],
        bump
    )]
    pub user_vault: AccountInfo<'info>,

    #[account(mut)]
    pub user: Signer<'info>,
    /// CHECK: This is the master wallet (Backpack) that authorized the session wallet and pays for initialization
    #[account(mut)]
    pub master_wallet: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Trade<'info> {
    #[account(mut, seeds = [Amm::SEED], bump = amm.bump)]
    pub amm: Account<'info, Amm>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [Position::SEED, amm.key().as_ref(), user.key().as_ref()],
        bump,
        constraint = pos.owner == user.key() @ ReaderError::NotOwner
    )]
    pub pos: Account<'info, Position>,

    /// CHECK: User vault PDA (system-owned, holds user's SOL)
    #[account(
        mut,
        seeds = [Position::USER_VAULT_SEED, pos.key().as_ref()],
        bump = pos.vault_bump
    )]
    pub user_vault: AccountInfo<'info>,

    /// CHECK: writable lamport recipient for fees; address checked against `amm.fee_dest`.
    #[account(mut, address = amm.fee_dest)]
    pub fee_dest: UncheckedAccount<'info>,

    /// CHECK: writable SOL vault PDA (system-owned, 0 space) used as lamports pool.
    #[account(
        mut,
        seeds = [Amm::VAULT_SOL_SEED, amm.key().as_ref()],
        bump = amm.vault_sol_bump
    )]
    pub vault_sol: UncheckedAccount<'info>,

    /// CHECK: Oracle state account for reading BTC price and timestamp
    pub oracle_state: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct UserVault<'info> {
    #[account(seeds = [Amm::SEED], bump = amm.bump)]
    pub amm: Account<'info, Amm>,

    #[account(
        mut,
        seeds = [Position::SEED, amm.key().as_ref(), user.key().as_ref()],
        bump,
        constraint = pos.owner == user.key() @ ReaderError::NotOwner
    )]
    pub pos: Account<'info, Position>,

    /// CHECK: User vault PDA (system-owned, holds user's SOL)
    #[account(
        mut,
        seeds = [Position::USER_VAULT_SEED, pos.key().as_ref()],
        bump = pos.vault_bump
    )]
    pub user_vault: AccountInfo<'info>,

    pub user: Signer<'info>,

    /// Master wallet (Backpack) that funds the deposit
    #[account(mut)]
    pub master_wallet: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UserVaultTopup<'info> {
    #[account(seeds = [Amm::SEED], bump = amm.bump)]
    pub amm: Account<'info, Amm>,

    #[account(
        mut,
        seeds = [Position::SEED, amm.key().as_ref(), user.key().as_ref()],
        bump,
        constraint = pos.owner == user.key() @ ReaderError::NotOwner
    )]
    pub pos: Account<'info, Position>,

    /// CHECK: User vault PDA (system-owned, holds user's SOL)
    #[account(
        mut,
        seeds = [Position::USER_VAULT_SEED, pos.key().as_ref()],
        bump = pos.vault_bump
    )]
    pub user_vault: AccountInfo<'info>,

    /// CHECK: Session wallet that receives the topup (verified by PDA derivation)
    #[account(mut)]
    pub user: UncheckedAccount<'info>,

    /// Master wallet (Backpack) that authorizes the topup
    #[account(mut)]
    pub master_wallet: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UserVaultWithdraw<'info> {
    #[account(seeds = [Amm::SEED], bump = amm.bump)]
    pub amm: Account<'info, Amm>,

    #[account(
        mut,
        seeds = [Position::SEED, amm.key().as_ref(), user.key().as_ref()],
        bump,
        constraint = pos.owner == user.key() @ ReaderError::NotOwner
    )]
    pub pos: Account<'info, Position>,

    /// CHECK: User vault PDA (system-owned, holds user's SOL)
    #[account(
        mut,
        seeds = [Position::USER_VAULT_SEED, pos.key().as_ref()],
        bump = pos.vault_bump
    )]
    pub user_vault: AccountInfo<'info>,

    #[account(mut)]
    pub user: Signer<'info>,

    /// CHECK: Master wallet (Backpack) - must sign withdrawals
    #[account(mut)]
    pub master_wallet: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, seeds = [Amm::SEED], bump = amm.bump)]
    pub amm: Account<'info, Amm>,

    /// Admin signer - must be fee_dest to authorize admin operations
    #[account(
        constraint = admin.key() == amm.fee_dest @ ReaderError::NotOwner
    )]
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(mut, seeds = [Amm::SEED], bump = amm.bump)]
    pub amm: Account<'info, Amm>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [Position::SEED, amm.key().as_ref(), user.key().as_ref()],
        bump,
        constraint = pos.owner == user.key() @ ReaderError::NotOwner
    )]
    pub pos: Account<'info, Position>,

    /// CHECK: fee treasury (lamports) — no longer used as rent payer here.
    #[account(mut, address = amm.fee_dest)]
    pub fee_dest: UncheckedAccount<'info>,

    /// CHECK: writable SOL vault PDA (system-owned, 0 space)
    #[account(
        mut,
        seeds = [Amm::VAULT_SOL_SEED, amm.key().as_ref()],
        bump = amm.vault_sol_bump
    )]
    pub vault_sol: UncheckedAccount<'info>,

    /// CHECK: User's vault PDA that receives the payout
    #[account(
        mut,
        seeds = [Position::USER_VAULT_SEED, pos.key().as_ref()],
        bump = pos.vault_bump
    )]
    pub user_vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AdminRedeem<'info> {
    #[account(mut, seeds = [Amm::SEED], bump = amm.bump)]
    pub amm: Account<'info, Amm>,

    /// Admin signer (must be fee_dest)
    #[account(mut)]
    pub admin: Signer<'info>,

    /// The user who will receive the payout (NOT a signer)
    /// CHECK: derived from position owner
    #[account(mut)]
    pub user: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [Position::SEED, amm.key().as_ref(), user.key().as_ref()],
        bump,
        constraint = pos.owner == user.key() @ ReaderError::NotOwner
    )]
    pub pos: Account<'info, Position>,

    /// CHECK: fee treasury (lamports)
    #[account(mut, address = amm.fee_dest)]
    pub fee_dest: UncheckedAccount<'info>,

    /// CHECK: writable SOL vault PDA (system-owned, 0 space)
    #[account(
        mut,
        seeds = [Amm::VAULT_SOL_SEED, amm.key().as_ref()],
        bump = amm.vault_sol_bump
    )]
    pub vault_sol: UncheckedAccount<'info>,

    /// CHECK: User's vault PDA that receives the payout
    #[account(
        mut,
        seeds = [Position::USER_VAULT_SEED, pos.key().as_ref()],
        bump = pos.vault_bump
    )]
    pub user_vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminForceWithdraw<'info> {
    #[account(seeds = [Amm::SEED], bump = amm.bump)]
    pub amm: Account<'info, Amm>,

    /// Admin signer (must be fee_dest)
    #[account(
        constraint = admin.key() == amm.fee_dest @ ReaderError::NotOwner
    )]
    pub admin: Signer<'info>,

    /// The user who will receive the funds (NOT a signer)
    /// CHECK: derived from position owner
    #[account(mut)]
    pub user: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [Position::SEED, amm.key().as_ref(), user.key().as_ref()],
        bump,
        constraint = pos.owner == user.key() @ ReaderError::NotOwner
    )]
    pub pos: Account<'info, Position>,

    /// CHECK: User's vault PDA that holds the funds
    #[account(
        mut,
        seeds = [Position::USER_VAULT_SEED, pos.key().as_ref()],
        bump = pos.vault_bump
    )]
    pub user_vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminFixVaultBalance<'info> {
    #[account(seeds = [Amm::SEED], bump = amm.bump)]
    pub amm: Account<'info, Amm>,

    /// Admin signer (must be fee_dest)
    #[account(
        constraint = admin.key() == amm.fee_dest @ ReaderError::NotOwner
    )]
    pub admin: Signer<'info>,

    /// The user whose position to fix (NOT a signer)
    /// CHECK: derived from position owner
    pub user: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [Position::SEED, amm.key().as_ref(), user.key().as_ref()],
        bump,
        constraint = pos.owner == user.key() @ ReaderError::NotOwner
    )]
    pub pos: Account<'info, Position>,

    /// CHECK: User's vault PDA to read actual lamports from
    #[account(
        seeds = [Position::USER_VAULT_SEED, pos.key().as_ref()],
        bump = pos.vault_bump
    )]
    pub user_vault: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CloseAmm<'info> {
    #[account(
        mut,
        seeds = [Amm::SEED],
        bump = amm.bump,
        close = recipient
    )]
    pub amm: Account<'info, Amm>,
    #[account(mut)]
    pub recipient: Signer<'info>,
}

// ---- NEW: oracle snapshot / settlement contexts ----
#[derive(Accounts)]
pub struct SnapshotStart<'info> {
    #[account(mut, seeds = [Amm::SEED], bump = amm.bump)]
    pub amm: Account<'info, Amm>,
    /// CHECK: must be owned by the oracle program
    #[account(owner = ORACLE_PROGRAM_ID)]
    pub oracle_state: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct SettleByOracle<'info> {
    #[account(mut, seeds = [Amm::SEED], bump = amm.bump)]
    pub amm: Account<'info, Amm>,

    /// Admin signer - must be fee_dest to authorize settlement
    #[account(
        constraint = admin.key() == amm.fee_dest @ ReaderError::NotOwner
    )]
    pub admin: Signer<'info>,

    /// CHECK: must be owned by the oracle program
    #[account(owner = ORACLE_PROGRAM_ID)]
    pub oracle_state: AccountInfo<'info>,
}


#[derive(Accounts)]
pub struct WipePosition<'info> {
    #[account(mut, seeds = [Amm::SEED], bump = amm.bump)]
    pub amm: Account<'info, Amm>,

    /// Admin signer — we gate this to the AMM's fee_dest for safety
    pub admin: Signer<'info>,

    /// CHECK: used only for PDA seeds (owner pubkey)
    pub owner: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [Position::SEED, amm.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub pos: Account<'info, Position>,
}

#[derive(Accounts)]
pub struct MigratePosition<'info> {
    #[account(seeds = [Amm::SEED], bump = amm.bump)]
    pub amm: Account<'info, Amm>,

    /// Owner of the position (session wallet) - must sign
    #[account(mut)]
    pub owner: Signer<'info>,

    /// Master wallet (Backpack wallet) - receives vault balance
    /// CHECK: verified against old_position.master_wallet during migration
    #[account(mut)]
    pub master_wallet: UncheckedAccount<'info>,

    /// Old position account (97 bytes) - will be closed
    /// CHECK: We manually deserialize this account since it uses old layout
    #[account(
        mut,
        seeds = [Position::SEED, amm.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub old_position: UncheckedAccount<'info>,

    /// User vault PDA - holds the vault balance
    /// CHECK: Derived from old_position, used to transfer funds
    #[account(mut)]
    pub user_vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteLimitOrder<'info> {
    #[account(mut, seeds = [Amm::SEED], bump = amm.bump)]
    pub amm: Account<'info, Amm>,

    #[account(
        mut,
        seeds = [Position::SEED, amm.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub position: Account<'info, Position>,

    /// CHECK: User vault PDA (system-owned, holds user's SOL)
    #[account(
        mut,
        seeds = [Position::USER_VAULT_SEED, position.key().as_ref()],
        bump = position.vault_bump
    )]
    pub user_vault: AccountInfo<'info>,

    /// CHECK: writable lamport recipient for fees; address checked against `amm.fee_dest`.
    #[account(mut, address = amm.fee_dest)]
    pub fee_dest: UncheckedAccount<'info>,

    /// CHECK: writable SOL vault PDA (system-owned, 0 space) used as lamports pool.
    #[account(
        mut,
        seeds = [Amm::VAULT_SOL_SEED, amm.key().as_ref()],
        bump = amm.vault_sol_bump
    )]
    pub vault_sol: UncheckedAccount<'info>,

    /// CHECK: User whose order is being executed (order owner, not a signer, not modified)
    pub user: UncheckedAccount<'info>,

    /// Keeper who is executing the order (receives fee)
    #[account(mut)]
    pub keeper: Signer<'info>,

    /// CHECK: Instructions sysvar for Ed25519 signature verification
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelOrderNonce<'info> {
    #[account(
        mut,
        has_one = owner @ ReaderError::NotOwner
    )]
    pub position: Account<'info, Position>,

    #[account(mut)]
    pub owner: Signer<'info>,
}


// =========================== Program ===========================
#[program]
pub mod cpi_oracle {
    use super::*;

    // ---------- ORACLE print ----------
    pub fn log_oracle(ctx: Context<LogOracle>) -> Result<()> {
        let ai = &ctx.accounts.oracle_state;
        require_keys_eq!(*ai.owner, ORACLE_PROGRAM_ID, ReaderError::WrongOwner);

        let data = ai.try_borrow_data()?;
        require!(data.len() >= 8, ReaderError::DataTooSmall);
        let payload = &data[8..];
        let s = OracleStateMirror::try_from_slice(payload)
            .map_err(|_| error!(ReaderError::DeserializeFail))?;

        let scale = 10i64.pow(s.decimals as u32) as f64;
        let to_f = |v: i64| (v as f64)/scale;

        msg!("── ORACLE (dec={}): BTC {:.2} / {:.2} / {:.2}",
            s.decimals, to_f(s.btc.param1), to_f(s.btc.param2), to_f(s.btc.param3));
        Ok(())
    }

    // ---------- INIT market ----------
    pub fn init_amm(ctx: Context<InitAmm>, b: i64, fee_bps: u16) -> Result<()> {
        let amm = &mut ctx.accounts.amm;

        // Safety: require fee_dest is a System account
        let fee_owner: Pubkey = *ctx.accounts.fee_dest.to_account_info().owner;
        require_keys_eq!(fee_owner, System::id(), ReaderError::BadParam);

        amm.bump = ctx.bumps.amm;
        amm.decimals = 6;
        require!(b > 0, ReaderError::BadParam);
        amm.b = b;
        amm.fee_bps = fee_bps;
        amm.q_yes = 0;
        amm.q_no  = 0;
        amm.fees = 0;

        // CHANGED: Keep vault funds from previous market cycle
        // Read existing vault balance and sync vault_e6 accounting
        let vault_ai = ctx.accounts.vault_sol.to_account_info();
        let vault_lamports = vault_ai.lamports();
        amm.vault_e6 = lamports_to_e6(vault_lamports);

        amm.status = MarketStatus::Premarket as u8;
        amm.winner = 0;
        amm.w_total_e6 = 0;
        amm.pps_e6 = 0;
        amm.fee_dest = ctx.accounts.fee_dest.key();
        amm.vault_sol_bump = ctx.bumps.vault_sol;

        // NEW: init oracle snapshot fields
        amm.start_price_e6 = 0;
        amm.start_ts = 0;
        amm.settle_price_e6 = 0;
        amm.settle_ts = 0;

        // Init market timing (0 = not set, to be set by external bot)
        amm.market_end_slot = 0;

        msg!("✅ INIT: b={} (1e-6), fee_bps={}, status=Open, fee_dest={}, vault_e6={} ({} lamports carried over)",
             b, fee_bps, amm.fee_dest, amm.vault_e6, vault_lamports);
        Ok(())
    }

    // ---------- INIT position (per user & market) ----------
    pub fn init_position(ctx: Context<InitPosition>) -> Result<()> {
        let pos = &mut ctx.accounts.pos;
        pos.owner = ctx.accounts.user.key();
        pos.yes_shares_e6 = 0;
        pos.no_shares_e6 = 0;
        pos.master_wallet = ctx.accounts.master_wallet.key();
        pos.vault_balance_e6 = 0;
        pos.vault_bump = ctx.bumps.user_vault;
        pos.used_nonces = Vec::new();  // Initialize empty nonce list
        msg!("✅ Position initialized for {} (master: {}, vault: {})",
             pos.owner, pos.master_wallet, ctx.accounts.user_vault.key());
        Ok(())
    }

    // ---------- DEPOSIT (move SOL from master wallet directly into user vault) ----------
    pub fn deposit(ctx: Context<UserVault>, amount_lamports: u64) -> Result<()> {
        let pos = &mut ctx.accounts.pos;

        // SECURITY: Verify the master_wallet matches the stored one
        require_keys_eq!(
            ctx.accounts.master_wallet.key(),
            pos.master_wallet,
            ReaderError::Unauthorized
        );

        // Transfer SOL from master wallet (Backpack) directly to user_vault PDA
        invoke(
            &system_instruction::transfer(
                ctx.accounts.master_wallet.key,
                ctx.accounts.user_vault.key,
                amount_lamports,
            ),
            &[
                ctx.accounts.master_wallet.to_account_info(),
                ctx.accounts.user_vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        // Update vault balance tracking (convert lamports to e6 scale)
        let amount_e6 = lamports_to_e6(amount_lamports);
        pos.vault_balance_e6 += amount_e6;

        msg!("✅ Deposited {} lamports ({} e6) from master wallet to vault. New balance: {} e6",
             amount_lamports, amount_e6, pos.vault_balance_e6);

        Ok(())
    }

    // ---------- TOPUP SESSION WALLET (move SOL from user vault to session wallet for gas fees) ----------
    pub fn topup_session_wallet(ctx: Context<UserVaultTopup>, amount_lamports: u64) -> Result<()> {
        let pos = &mut ctx.accounts.pos;

        // SECURITY: Verify the master_wallet matches the stored one
        require_keys_eq!(
            ctx.accounts.master_wallet.key(),
            pos.master_wallet,
            ReaderError::Unauthorized
        );

        // Check vault balance
        let amount_e6 = lamports_to_e6(amount_lamports);
        require!(
            pos.vault_balance_e6 >= amount_e6,
            ReaderError::InsufficientBalance
        );

        let session_balance_before = ctx.accounts.user.lamports();
        msg!("💰 Session wallet balance before: {} lamports ({:.4} XNT)",
             session_balance_before, session_balance_before as f64 / 1e9);

        // Transfer SOL from user_vault PDA to session wallet using signed PDA
        let pos_key = pos.key();
        let seeds = &[
            Position::USER_VAULT_SEED,
            pos_key.as_ref(),
            &[pos.vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        invoke_signed(
            &system_instruction::transfer(
                ctx.accounts.user_vault.key,
                ctx.accounts.user.key,
                amount_lamports,
            ),
            &[
                ctx.accounts.user_vault.to_account_info(),
                ctx.accounts.user.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            signer_seeds,
        )?;

        // Update vault balance
        pos.vault_balance_e6 -= amount_e6;

        let session_balance_after = ctx.accounts.user.lamports();
        msg!("✅ Topped up {} lamports ({:.4} XNT) to session wallet. New balance: {} lamports ({:.4} XNT). Vault remaining: {} e6",
             amount_lamports, amount_lamports as f64 / 1e9, session_balance_after, session_balance_after as f64 / 1e9, pos.vault_balance_e6);

        Ok(())
    }

    // ---------- WITHDRAW (move SOL from user vault to master wallet ONLY) ----------
    pub fn withdraw(ctx: Context<UserVaultWithdraw>, amount_lamports: u64) -> Result<()> {
        let pos = &mut ctx.accounts.pos;

        // SECURITY: Verify signer is the master wallet
        require_keys_eq!(
            ctx.accounts.master_wallet.key(),
            pos.master_wallet,
            ReaderError::Unauthorized
        );

        // Check vault balance
        let amount_e6 = lamports_to_e6(amount_lamports);
        require!(
            pos.vault_balance_e6 >= amount_e6,
            ReaderError::InsufficientBalance
        );

        // Transfer SOL from user_vault PDA to master wallet using signed PDA
        let pos_key = pos.key();
        let seeds = &[
            Position::USER_VAULT_SEED,
            pos_key.as_ref(),
            &[pos.vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        invoke_signed(
            &system_instruction::transfer(
                ctx.accounts.user_vault.key,
                ctx.accounts.master_wallet.key,
                amount_lamports,
            ),
            &[
                ctx.accounts.user_vault.to_account_info(),
                ctx.accounts.master_wallet.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            signer_seeds,
        )?;

        // Update vault balance
        pos.vault_balance_e6 -= amount_e6;

        msg!("✅ Withdrew {} lamports ({} e6) to master wallet. Remaining: {} e6",
             amount_lamports, amount_e6, pos.vault_balance_e6);
        Ok(())
    }

    // ---------- QUOTE ----------
    pub fn quote(ctx: Context<Quote>) -> Result<()> {
        let amm = &ctx.accounts.amm;
        let p = lmsr_p_yes(amm);
        msg!("── QUOTE  pYes={:.6}  pNo={:.6}  skew={:.6}sh",
             p, 1.0 - p, sh((amm.q_yes - amm.q_no) as i64));
        msg!("          qYes={:.6}sh  qNo={:.6}sh  b={:.0}sh  vault=${:.6}  fees=${:.6}",
             sh(amm.q_yes), sh(amm.q_no), sh(amm.b), usd(amm.vault_e6), usd(amm.fees));
        if amm.start_price_e6 != 0 {
            msg!("          start=${:.6} (ts={})", (amm.start_price_e6 as f64)/1e6, amm.start_ts);
        }
        if amm.settle_price_e6 != 0 {
            msg!("          settle_at=${:.6} (ts={})", (amm.settle_price_e6 as f64)/1e6, amm.settle_ts);
        }
        Ok(())
    }

    // ---------- TRADE ----------
    /// side: 1=YES, 2=NO
    /// action: 1=BUY (amount=spend 1e6), 2=SELL (amount=shares 1e6)
    pub fn trade(ctx: Context<Trade>, side: u8, action: u8, amount: i64) -> Result<()> {
        let amm  = &mut ctx.accounts.amm;
        let pos  = &mut ctx.accounts.pos;
        let sys  = &ctx.accounts.system_program;

        require!(amount > 0, ReaderError::BadParam);
        let status = amm.status();
        require!(status == MarketStatus::Premarket || status == MarketStatus::Open, ReaderError::MarketClosed);

        // Check trading lockout using oracle timestamp (45 seconds before market end)
        if amm.market_end_time > 0 {
            // Read current time from oracle via CPI (returns milliseconds)
            let (_, oracle_ts_ms) = read_btc_price_e6(&ctx.accounts.oracle_state)?;
            let oracle_ts = oracle_ts_ms / 1000; // Convert milliseconds to seconds
            let lockout_start_time = amm.market_end_time - TRADING_LOCKOUT_SECONDS;
            let time_until_lockout = lockout_start_time.saturating_sub(oracle_ts);
            let time_until_end = amm.market_end_time.saturating_sub(oracle_ts);

            if oracle_ts >= lockout_start_time {
                msg!("LOCKED: ts={} lockout={} end={}", oracle_ts, lockout_start_time, amm.market_end_time);
                return err!(ReaderError::TradingLocked);
            }
            // No success logging - saves CU
        }

        match (side, action) {
            (1, 1) => { // BUY YES - amount is SHARES to buy (not spend)
                require!(amount >= MIN_SELL_E6 && amount <= DQ_MAX_E6, ReaderError::BadParam);

                // Calculate required spend for desired shares DIRECTLY (no binary search needed!)
                let desired_shares_e6 = amount;
                let spend_e6 = lmsr_buy_yes_for_shares(amm, desired_shares_e6)?;

                // Check user vault balance (needs spend_e6, not shares)
                require!(pos.vault_balance_e6 >= spend_e6, ReaderError::InsufficientBalance);

                // Calculate fee and net from spend
                let fee_e6 = ((spend_e6 as i128) * (amm.fee_bps as i128) / 10_000) as i64;
                let net_e6 = spend_e6.saturating_sub(fee_e6);

                // Update AMM state directly (no need for binary search since we know exact shares!)
                amm.fees = amm.fees.saturating_add(fee_e6);
                amm.q_yes = amm.q_yes.saturating_add(desired_shares_e6);
                amm.vault_e6 = amm.vault_e6.saturating_add(net_e6);
                pos.yes_shares_e6 = pos.yes_shares_e6.saturating_add(desired_shares_e6);

                // Average price = net spend / shares
                let avg_h = (net_e6 as f64) / (desired_shares_e6 as f64);

                // Transfer from user_vault PDA (using signed transfer)
                let pos_key = pos.key();
                let seeds: &[&[u8]] = &[
                    Position::USER_VAULT_SEED,
                    pos_key.as_ref(),
                    core::slice::from_ref(&pos.vault_bump),
                ];
                transfer_sol_signed(sys, &ctx.accounts.user_vault.to_account_info(), &ctx.accounts.vault_sol.to_account_info(), e6_to_lamports(net_e6), &[seeds])?;
                transfer_sol_signed(sys, &ctx.accounts.user_vault.to_account_info(), &ctx.accounts.fee_dest.to_account_info(), e6_to_lamports(fee_e6), &[seeds])?;

                // Update vault balance with actual spend
                pos.vault_balance_e6 -= spend_e6;

                // Optimized: single msg with integers only (no floats, no emit)
                msg!("BUY YES: spend={} shares={} qY={} qN={} vault={}",
                     spend_e6, desired_shares_e6, amm.q_yes, amm.q_no, amm.vault_e6);

                // Emit trade event for monitoring
                emit_trade(amm, 1, 1, spend_e6, desired_shares_e6, avg_h);
            }
            (2, 1) => { // BUY NO - amount is SHARES to buy (not spend)
                require!(amount >= MIN_SELL_E6 && amount <= DQ_MAX_E6, ReaderError::BadParam);

                // Calculate required spend for desired shares DIRECTLY (no binary search needed!)
                let desired_shares_e6 = amount;
                let spend_e6 = lmsr_buy_no_for_shares(amm, desired_shares_e6)?;

                // Check user vault balance (needs spend_e6, not shares)
                require!(pos.vault_balance_e6 >= spend_e6, ReaderError::InsufficientBalance);

                // Calculate fee and net from spend
                let fee_e6 = ((spend_e6 as i128) * (amm.fee_bps as i128) / 10_000) as i64;
                let net_e6 = spend_e6.saturating_sub(fee_e6);

                // Update AMM state directly (no need for binary search since we know exact shares!)
                amm.fees = amm.fees.saturating_add(fee_e6);
                amm.q_no = amm.q_no.saturating_add(desired_shares_e6);
                amm.vault_e6 = amm.vault_e6.saturating_add(net_e6);
                pos.no_shares_e6 = pos.no_shares_e6.saturating_add(desired_shares_e6);

                // Average price = net spend / shares
                let avg_h = (net_e6 as f64) / (desired_shares_e6 as f64);

                // Transfer from user_vault PDA (using signed transfer)
                let pos_key = pos.key();
                let seeds: &[&[u8]] = &[
                    Position::USER_VAULT_SEED,
                    pos_key.as_ref(),
                    core::slice::from_ref(&pos.vault_bump),
                ];
                transfer_sol_signed(sys, &ctx.accounts.user_vault.to_account_info(), &ctx.accounts.vault_sol.to_account_info(), e6_to_lamports(net_e6), &[seeds])?;
                transfer_sol_signed(sys, &ctx.accounts.user_vault.to_account_info(), &ctx.accounts.fee_dest.to_account_info(), e6_to_lamports(fee_e6), &[seeds])?;

                // Update vault balance with actual spend
                pos.vault_balance_e6 -= spend_e6;

                // Optimized: single msg with integers only (no floats, no emit)
                msg!("BUY NO: spend={} shares={} qY={} qN={} vault={}",
                     spend_e6, desired_shares_e6, amm.q_yes, amm.q_no, amm.vault_e6);

                // Emit trade event for monitoring
                emit_trade(amm, 2, 1, spend_e6, desired_shares_e6, avg_h);
            }
            (1, 2) => { // SELL YES → pay proceeds to user_vault
                require!(amount >= MIN_SELL_E6 && amount <= DQ_MAX_E6, ReaderError::BadParam);
                let sell_e6 = amount.min(pos.yes_shares_e6);
                require!(sell_e6 > 0, ReaderError::InsufficientShares);

                let (proceeds_e6, avg_h, sold_e6) = lmsr_sell_yes(amm, sell_e6)?;

                // Check actual vault_sol PDA balance (not the accounting mirror which can drift)
                let vault_sol_actual_lamports = ctx.accounts.vault_sol.lamports();
                let vault_sol_actual_e6 = lamports_to_e6(vault_sol_actual_lamports);
                msg!("SELL YES COVERAGE CHECK: vault_sol_ACTUAL={:.6} XNT, AMM_vault_e6_accounting={:.6} XNT (drift={:.6}), proceeds_needed={:.6} XNT",
                     usd(vault_sol_actual_e6), usd(amm.vault_e6), usd(vault_sol_actual_e6 - amm.vault_e6), usd(proceeds_e6));

                // Use ACTUAL vault balance for coverage check, not the drifted accounting mirror
                require!(vault_sol_actual_e6 >= proceeds_e6, ReaderError::NoCoverage);

                // Transfer from vault_sol to user_vault
                let amm_key = amm.key();
                let seeds: &[&[u8]] = &[
                    Amm::VAULT_SOL_SEED,
                    amm_key.as_ref(),
                    core::slice::from_ref(&amm.vault_sol_bump),
                ];
                transfer_sol_signed(sys, &ctx.accounts.vault_sol.to_account_info(), &ctx.accounts.user_vault.to_account_info(), e6_to_lamports(proceeds_e6), &[seeds])?;

                // Update vault balance
                pos.vault_balance_e6 += proceeds_e6;
                pos.yes_shares_e6 = pos.yes_shares_e6.saturating_sub(sold_e6.round() as i64);

                // Optimized: single msg with integers only (no floats, no emit)
                msg!("SELL YES: proceeds={} sold={} qY={} qN={} vault={}",
                     proceeds_e6, sold_e6.round() as i64, amm.q_yes, amm.q_no, amm.vault_e6);

                // Emit trade event for monitoring
                emit_trade(amm, 1, 2, proceeds_e6, sold_e6.round() as i64, avg_h);
            }
            (2, 2) => { // SELL NO → pay proceeds to user_vault
                require!(amount >= MIN_SELL_E6 && amount <= DQ_MAX_E6, ReaderError::BadParam);
                let sell_e6 = amount.min(pos.no_shares_e6);
                require!(sell_e6 > 0, ReaderError::InsufficientShares);

                let (proceeds_e6, avg_h, sold_e6) = lmsr_sell_no(amm, sell_e6)?;

                // Check actual vault_sol PDA balance (not the accounting mirror which can drift)
                let vault_sol_actual_lamports = ctx.accounts.vault_sol.lamports();
                let vault_sol_actual_e6 = lamports_to_e6(vault_sol_actual_lamports);
                msg!("SELL NO COVERAGE CHECK: vault_sol_ACTUAL={:.6} XNT, AMM_vault_e6_accounting={:.6} XNT (drift={:.6}), proceeds_needed={:.6} XNT",
                     usd(vault_sol_actual_e6), usd(amm.vault_e6), usd(vault_sol_actual_e6 - amm.vault_e6), usd(proceeds_e6));

                // Use ACTUAL vault balance for coverage check, not the drifted accounting mirror
                require!(vault_sol_actual_e6 >= proceeds_e6, ReaderError::NoCoverage);

                // Transfer from vault_sol to user_vault
                let amm_key = amm.key();
                let seeds: &[&[u8]] = &[
                    Amm::VAULT_SOL_SEED,
                    amm_key.as_ref(),
                    core::slice::from_ref(&amm.vault_sol_bump),
                ];
                transfer_sol_signed(sys, &ctx.accounts.vault_sol.to_account_info(), &ctx.accounts.user_vault.to_account_info(), e6_to_lamports(proceeds_e6), &[seeds])?;

                // Update vault balance
                pos.vault_balance_e6 += proceeds_e6;
                pos.no_shares_e6 = pos.no_shares_e6.saturating_sub(sold_e6.round() as i64);

                // Optimized: single msg with integers only (no floats, no emit)
                msg!("SELL NO: proceeds={} sold={} qY={} qN={} vault={}",
                     proceeds_e6, sold_e6.round() as i64, amm.q_yes, amm.q_no, amm.vault_e6);

                // Emit trade event for monitoring
                emit_trade(amm, 2, 2, proceeds_e6, sold_e6.round() as i64, avg_h);
            }
            _ => return err!(ReaderError::BadParam),
        }
        Ok(())
    }

    // ---------- TRADE WITH GUARDS (limit orders, etc.) ----------
    pub fn trade_guarded(
        ctx: Context<Trade>,
        side: u8,
        action: u8,
        amount: i64,
        guard: GuardConfig
    ) -> Result<()> {
        let amm  = &mut ctx.accounts.amm;
        let pos  = &mut ctx.accounts.pos;
        let sys  = &ctx.accounts.system_program;

        require!(amount > 0, ReaderError::BadParam);
        let status = amm.status();
        require!(status == MarketStatus::Premarket || status == MarketStatus::Open, ReaderError::MarketClosed);

        // Check trading lockout (same as regular trade)
        if amm.market_end_time > 0 {
            let (_, oracle_ts_ms) = read_btc_price_e6(&ctx.accounts.oracle_state)?;
            let oracle_ts = oracle_ts_ms / 1000;
            let lockout_start_time = amm.market_end_time - TRADING_LOCKOUT_SECONDS;

            if oracle_ts >= lockout_start_time {
                msg!("LOCKED: ts={} lockout={} end={}", oracle_ts, lockout_start_time, amm.market_end_time);
                return err!(ReaderError::TradingLocked);
            }
        }

        // For BUY: Calculate price per share BEFORE execution, check against limit
        // For SELL: Calculate price per share BEFORE execution, check against limit
        match (side, action) {
            (1, 1) => { // BUY YES with limit
                require!(amount >= MIN_SELL_E6 && amount <= DQ_MAX_E6, ReaderError::BadParam);

                let desired_shares_e6 = amount;
                let spend_e6 = lmsr_buy_yes_for_shares(amm, desired_shares_e6)?;

                // Calculate price per share (before fees)
                let price_per_share_e6 = (spend_e6 * 1_000_000) / desired_shares_e6;

                // Check price limit if guard is set
                if guard.has_limit() {
                    msg!("🛡️ LIMIT CHECK BUY YES: price_per_share={:.6} limit={:.6}",
                         price_per_share_e6 as f64 / 1e6, guard.price_limit_e6 as f64 / 1e6);
                    require!(price_per_share_e6 <= guard.price_limit_e6, ReaderError::PriceLimitExceeded);
                }

                // Execute trade (same logic as regular trade)
                require!(pos.vault_balance_e6 >= spend_e6, ReaderError::InsufficientBalance);

                let fee_e6 = ((spend_e6 as i128) * (amm.fee_bps as i128) / 10_000) as i64;
                let net_e6 = spend_e6.saturating_sub(fee_e6);

                amm.fees = amm.fees.saturating_add(fee_e6);
                amm.q_yes = amm.q_yes.saturating_add(desired_shares_e6);
                amm.vault_e6 = amm.vault_e6.saturating_add(net_e6);
                pos.yes_shares_e6 = pos.yes_shares_e6.saturating_add(desired_shares_e6);

                let avg_h = (net_e6 as f64) / (desired_shares_e6 as f64);

                let pos_key = pos.key();
                let seeds: &[&[u8]] = &[
                    b"user_vault",
                    pos_key.as_ref(),
                    core::slice::from_ref(&pos.vault_bump),
                ];
                transfer_sol_signed(sys, &ctx.accounts.user_vault.to_account_info(), &ctx.accounts.vault_sol.to_account_info(), e6_to_lamports(spend_e6), &[seeds])?;

                pos.vault_balance_e6 = pos.vault_balance_e6.saturating_sub(spend_e6);

                msg!("✅ GUARDED BUY YES: shares={} spend={} price={:.6} qY={} qN={} vault={}",
                     desired_shares_e6, spend_e6, avg_h, amm.q_yes, amm.q_no, amm.vault_e6);
                emit_trade(amm, 1, 1, spend_e6, desired_shares_e6, avg_h);
            }
            (2, 1) => { // BUY NO with limit
                require!(amount >= MIN_SELL_E6 && amount <= DQ_MAX_E6, ReaderError::BadParam);

                let desired_shares_e6 = amount;
                let spend_e6 = lmsr_buy_no_for_shares(amm, desired_shares_e6)?;

                let price_per_share_e6 = (spend_e6 * 1_000_000) / desired_shares_e6;

                if guard.has_limit() {
                    msg!("🛡️ LIMIT CHECK BUY NO: price_per_share={:.6} limit={:.6}",
                         price_per_share_e6 as f64 / 1e6, guard.price_limit_e6 as f64 / 1e6);
                    require!(price_per_share_e6 <= guard.price_limit_e6, ReaderError::PriceLimitExceeded);
                }

                require!(pos.vault_balance_e6 >= spend_e6, ReaderError::InsufficientBalance);

                let fee_e6 = ((spend_e6 as i128) * (amm.fee_bps as i128) / 10_000) as i64;
                let net_e6 = spend_e6.saturating_sub(fee_e6);

                amm.fees = amm.fees.saturating_add(fee_e6);
                amm.q_no = amm.q_no.saturating_add(desired_shares_e6);
                amm.vault_e6 = amm.vault_e6.saturating_add(net_e6);
                pos.no_shares_e6 = pos.no_shares_e6.saturating_add(desired_shares_e6);

                let avg_h = (net_e6 as f64) / (desired_shares_e6 as f64);

                let pos_key = pos.key();
                let seeds: &[&[u8]] = &[
                    b"user_vault",
                    pos_key.as_ref(),
                    core::slice::from_ref(&pos.vault_bump),
                ];
                transfer_sol_signed(sys, &ctx.accounts.user_vault.to_account_info(), &ctx.accounts.vault_sol.to_account_info(), e6_to_lamports(spend_e6), &[seeds])?;

                pos.vault_balance_e6 = pos.vault_balance_e6.saturating_sub(spend_e6);

                msg!("✅ GUARDED BUY NO: shares={} spend={} price={:.6} qY={} qN={} vault={}",
                     desired_shares_e6, spend_e6, avg_h, amm.q_yes, amm.q_no, amm.vault_e6);
                emit_trade(amm, 2, 1, spend_e6, desired_shares_e6, avg_h);
            }
            (1, 2) => { // SELL YES with limit
                let sell_e6 = amount;
                require!(sell_e6 >= MIN_SELL_E6 && sell_e6 <= DQ_MAX_E6, ReaderError::BadParam);
                require!(pos.yes_shares_e6 >= sell_e6, ReaderError::InsufficientShares);

                let (proceeds_e6, avg_h, sold_e6) = lmsr_sell_yes(amm, sell_e6)?;

                let price_per_share_e6 = (proceeds_e6 * 1_000_000) / sold_e6.round() as i64;

                if guard.has_limit() {
                    msg!("🛡️ LIMIT CHECK SELL YES: price_per_share={:.6} limit={:.6}",
                         price_per_share_e6 as f64 / 1e6, guard.price_limit_e6 as f64 / 1e6);
                    require!(price_per_share_e6 >= guard.price_limit_e6, ReaderError::PriceLimitNotMet);
                }

                let vault_sol_actual_lamports = ctx.accounts.vault_sol.lamports();
                let vault_sol_actual_e6 = lamports_to_e6(vault_sol_actual_lamports);
                require!(vault_sol_actual_e6 >= proceeds_e6, ReaderError::NoCoverage);

                let amm_key = amm.key();
                let seeds: &[&[u8]] = &[
                    Amm::VAULT_SOL_SEED,
                    amm_key.as_ref(),
                    core::slice::from_ref(&amm.vault_sol_bump),
                ];
                transfer_sol_signed(sys, &ctx.accounts.vault_sol.to_account_info(), &ctx.accounts.user_vault.to_account_info(), e6_to_lamports(proceeds_e6), &[seeds])?;

                pos.vault_balance_e6 += proceeds_e6;
                pos.yes_shares_e6 = pos.yes_shares_e6.saturating_sub(sold_e6.round() as i64);

                msg!("✅ GUARDED SELL YES: proceeds={} sold={} price={:.6} qY={} qN={} vault={}",
                     proceeds_e6, sold_e6.round() as i64, avg_h, amm.q_yes, amm.q_no, amm.vault_e6);
                emit_trade(amm, 1, 2, proceeds_e6, sold_e6.round() as i64, avg_h);
            }
            (2, 2) => { // SELL NO with limit
                let sell_e6 = amount;
                require!(sell_e6 >= MIN_SELL_E6 && sell_e6 <= DQ_MAX_E6, ReaderError::BadParam);
                require!(pos.no_shares_e6 >= sell_e6, ReaderError::InsufficientShares);

                let (proceeds_e6, avg_h, sold_e6) = lmsr_sell_no(amm, sell_e6)?;

                let price_per_share_e6 = (proceeds_e6 * 1_000_000) / sold_e6.round() as i64;

                if guard.has_limit() {
                    msg!("🛡️ LIMIT CHECK SELL NO: price_per_share={:.6} limit={:.6}",
                         price_per_share_e6 as f64 / 1e6, guard.price_limit_e6 as f64 / 1e6);
                    require!(price_per_share_e6 >= guard.price_limit_e6, ReaderError::PriceLimitNotMet);
                }

                let vault_sol_actual_lamports = ctx.accounts.vault_sol.lamports();
                let vault_sol_actual_e6 = lamports_to_e6(vault_sol_actual_lamports);
                require!(vault_sol_actual_e6 >= proceeds_e6, ReaderError::NoCoverage);

                let amm_key = amm.key();
                let seeds: &[&[u8]] = &[
                    Amm::VAULT_SOL_SEED,
                    amm_key.as_ref(),
                    core::slice::from_ref(&amm.vault_sol_bump),
                ];
                transfer_sol_signed(sys, &ctx.accounts.vault_sol.to_account_info(), &ctx.accounts.user_vault.to_account_info(), e6_to_lamports(proceeds_e6), &[seeds])?;

                pos.vault_balance_e6 += proceeds_e6;
                pos.no_shares_e6 = pos.no_shares_e6.saturating_sub(sold_e6.round() as i64);

                msg!("✅ GUARDED SELL NO: proceeds={} sold={} price={:.6} qY={} qN={} vault={}",
                     proceeds_e6, sold_e6.round() as i64, avg_h, amm.q_yes, amm.q_no, amm.vault_e6);
                emit_trade(amm, 2, 2, proceeds_e6, sold_e6.round() as i64, avg_h);
            }
            _ => return err!(ReaderError::BadParam),
        }
        Ok(())
    }

    // ---------- TRADE WITH SLIPPAGE PROTECTION (percentage-based tolerance) ----------
    pub fn trade_with_slippage(
        ctx: Context<Trade>,
        side: u8,
        action: u8,
        amount: i64,
        slippage: SlippageConfig,
    ) -> Result<()> {
        // Calculate current market price based on LMSR
        let amm = &ctx.accounts.amm;
        let current_price_e6 = if side == 1 { // YES
            calculate_yes_price(amm)
        } else { // NO
            calculate_no_price(amm)
        };

        // Calculate price limit based on slippage tolerance
        let price_limit_e6 = if slippage.has_slippage_limit() {
            if action == 1 { // BUY: allow price to go UP by slippage%
                let max_increase = (current_price_e6 as i128 * slippage.max_slippage_bps as i128) / 10_000;
                (current_price_e6 as i128 + max_increase) as i64
            } else { // SELL: allow price to go DOWN by slippage%
                let max_decrease = (current_price_e6 as i128 * slippage.max_slippage_bps as i128) / 10_000;
                (current_price_e6 as i128 - max_decrease).max(0) as i64
            }
        } else {
            0 // No slippage protection
        };

        msg!("💫 SLIPPAGE CHECK: current_price={:.6} tolerance={}bps limit={:.6}",
             current_price_e6 as f64 / 1e6,
             slippage.max_slippage_bps,
             price_limit_e6 as f64 / 1e6);

        // Convert slippage config to guard config and call trade_guarded
        let guard = GuardConfig { price_limit_e6 };
        trade_guarded(ctx, side, action, amount, guard)
    }

    // ---------- TRADE WITH ADVANCED GUARDS (comprehensive protection) ----------
    pub fn trade_advanced(
        ctx: Context<Trade>,
        side: u8,
        action: u8,
        amount: i64,
        guards: AdvancedGuardConfig,
    ) -> Result<()> {
        let amm = &mut ctx.accounts.amm;
        let pos = &mut ctx.accounts.pos;
        let sys = &ctx.accounts.system_program;

        require!(amount > 0, ReaderError::BadParam);
        let status = amm.status();
        require!(status == MarketStatus::Premarket || status == MarketStatus::Open, ReaderError::MarketClosed);

        // Check trading lockout
        if amm.market_end_time > 0 {
            let (_, oracle_ts_ms) = read_btc_price_e6(&ctx.accounts.oracle_state)?;
            let oracle_ts = oracle_ts_ms / 1000;
            let lockout_start_time = amm.market_end_time - TRADING_LOCKOUT_SECONDS;

            if oracle_ts >= lockout_start_time {
                msg!("LOCKED: ts={} lockout={} end={}", oracle_ts, lockout_start_time, amm.market_end_time);
                return err!(ReaderError::TradingLocked);
            }
        }

        // Validate guards and get executable shares (may be less than requested if partial fills enabled)
        let shares_to_execute = validate_advanced_guards(action, side, amount, &guards, amm)?;

        // Execute the trade with validated shares
        match (side, action) {
            (1, 1) => { // BUY YES
                require!(shares_to_execute >= MIN_SELL_E6 && shares_to_execute <= DQ_MAX_E6, ReaderError::BadParam);

                let spend_e6 = lmsr_buy_yes_for_shares(amm, shares_to_execute)?;
                require!(pos.vault_balance_e6 >= spend_e6, ReaderError::InsufficientBalance);

                let fee_e6 = ((spend_e6 as i128) * (amm.fee_bps as i128) / 10_000) as i64;
                let net_e6 = spend_e6.saturating_sub(fee_e6);

                amm.fees = amm.fees.saturating_add(fee_e6);
                amm.q_yes = amm.q_yes.saturating_add(shares_to_execute);
                amm.vault_e6 = amm.vault_e6.saturating_add(net_e6);
                pos.yes_shares_e6 = pos.yes_shares_e6.saturating_add(shares_to_execute);

                let avg_h = (net_e6 as f64) / (shares_to_execute as f64);

                let pos_key = pos.key();
                let seeds: &[&[u8]] = &[
                    b"user_vault",
                    pos_key.as_ref(),
                    core::slice::from_ref(&pos.vault_bump),
                ];
                transfer_sol_signed(sys, &ctx.accounts.user_vault.to_account_info(), &ctx.accounts.vault_sol.to_account_info(), e6_to_lamports(net_e6), &[seeds])?;
                transfer_sol_signed(sys, &ctx.accounts.user_vault.to_account_info(), &ctx.accounts.fee_dest.to_account_info(), e6_to_lamports(fee_e6), &[seeds])?;

                pos.vault_balance_e6 -= spend_e6;

                msg!("ADV BUY YES: requested={} executed={} spend={} qY={} qN={} vault={}",
                     amount, shares_to_execute, spend_e6, amm.q_yes, amm.q_no, amm.vault_e6);

                emit_trade(amm, 1, 1, spend_e6, shares_to_execute, avg_h);
            }
            (2, 1) => { // BUY NO
                require!(shares_to_execute >= MIN_SELL_E6 && shares_to_execute <= DQ_MAX_E6, ReaderError::BadParam);

                let spend_e6 = lmsr_buy_no_for_shares(amm, shares_to_execute)?;
                require!(pos.vault_balance_e6 >= spend_e6, ReaderError::InsufficientBalance);

                let fee_e6 = ((spend_e6 as i128) * (amm.fee_bps as i128) / 10_000) as i64;
                let net_e6 = spend_e6.saturating_sub(fee_e6);

                amm.fees = amm.fees.saturating_add(fee_e6);
                amm.q_no = amm.q_no.saturating_add(shares_to_execute);
                amm.vault_e6 = amm.vault_e6.saturating_add(net_e6);
                pos.no_shares_e6 = pos.no_shares_e6.saturating_add(shares_to_execute);

                let avg_h = (net_e6 as f64) / (shares_to_execute as f64);

                let pos_key = pos.key();
                let seeds: &[&[u8]] = &[
                    b"user_vault",
                    pos_key.as_ref(),
                    core::slice::from_ref(&pos.vault_bump),
                ];
                transfer_sol_signed(sys, &ctx.accounts.user_vault.to_account_info(), &ctx.accounts.vault_sol.to_account_info(), e6_to_lamports(net_e6), &[seeds])?;
                transfer_sol_signed(sys, &ctx.accounts.user_vault.to_account_info(), &ctx.accounts.fee_dest.to_account_info(), e6_to_lamports(fee_e6), &[seeds])?;

                pos.vault_balance_e6 -= spend_e6;

                msg!("ADV BUY NO: requested={} executed={} spend={} qY={} qN={} vault={}",
                     amount, shares_to_execute, spend_e6, amm.q_yes, amm.q_no, amm.vault_e6);

                emit_trade(amm, 2, 1, spend_e6, shares_to_execute, avg_h);
            }
            (1, 2) => { // SELL YES
                require!(shares_to_execute >= MIN_SELL_E6 && shares_to_execute <= DQ_MAX_E6, ReaderError::BadParam);
                let sell_e6 = shares_to_execute.min(pos.yes_shares_e6);
                require!(sell_e6 > 0, ReaderError::InsufficientShares);

                let (proceeds_e6, avg_h, sold_e6) = lmsr_sell_yes(amm, sell_e6)?;

                let vault_sol_actual_lamports = ctx.accounts.vault_sol.lamports();
                let vault_sol_actual_e6 = lamports_to_e6(vault_sol_actual_lamports);
                require!(vault_sol_actual_e6 >= proceeds_e6, ReaderError::NoCoverage);

                let amm_key = amm.key();
                let seeds: &[&[u8]] = &[
                    Amm::VAULT_SOL_SEED,
                    amm_key.as_ref(),
                    core::slice::from_ref(&amm.vault_sol_bump),
                ];
                transfer_sol_signed(sys, &ctx.accounts.vault_sol.to_account_info(), &ctx.accounts.user_vault.to_account_info(), e6_to_lamports(proceeds_e6), &[seeds])?;

                pos.vault_balance_e6 += proceeds_e6;
                pos.yes_shares_e6 = pos.yes_shares_e6.saturating_sub(sold_e6.round() as i64);

                msg!("ADV SELL YES: requested={} executed={} proceeds={} qY={} qN={} vault={}",
                     amount, sold_e6.round() as i64, proceeds_e6, amm.q_yes, amm.q_no, amm.vault_e6);
            }
            (2, 2) => { // SELL NO
                require!(shares_to_execute >= MIN_SELL_E6 && shares_to_execute <= DQ_MAX_E6, ReaderError::BadParam);
                let sell_e6 = shares_to_execute.min(pos.no_shares_e6);
                require!(sell_e6 > 0, ReaderError::InsufficientShares);

                let (proceeds_e6, avg_h, sold_e6) = lmsr_sell_no(amm, sell_e6)?;

                let vault_sol_actual_lamports = ctx.accounts.vault_sol.lamports();
                let vault_sol_actual_e6 = lamports_to_e6(vault_sol_actual_lamports);
                require!(vault_sol_actual_e6 >= proceeds_e6, ReaderError::NoCoverage);

                let amm_key = amm.key();
                let seeds: &[&[u8]] = &[
                    Amm::VAULT_SOL_SEED,
                    amm_key.as_ref(),
                    core::slice::from_ref(&amm.vault_sol_bump),
                ];
                transfer_sol_signed(sys, &ctx.accounts.vault_sol.to_account_info(), &ctx.accounts.user_vault.to_account_info(), e6_to_lamports(proceeds_e6), &[seeds])?;

                pos.vault_balance_e6 += proceeds_e6;
                pos.no_shares_e6 = pos.no_shares_e6.saturating_sub(sold_e6.round() as i64);

                msg!("ADV SELL NO: requested={} executed={} proceeds={} qY={} qN={} vault={}",
                     amount, sold_e6.round() as i64, proceeds_e6, amm.q_yes, amm.q_no, amm.vault_e6);
            }
            _ => return err!(ReaderError::BadParam),
        }

        Ok(())
    }

    // ---------- CLOSE POSITION (sell all YES and NO shares) ----------
    pub fn close_position(ctx: Context<Trade>) -> Result<()> {
        let amm = &mut ctx.accounts.amm;
        let pos = &mut ctx.accounts.pos;
        let sys = &ctx.accounts.system_program;

        let status = amm.status();
        require!(status == MarketStatus::Premarket || status == MarketStatus::Open, ReaderError::MarketClosed);

        // Check trading lockout using oracle timestamp (45 seconds before market end)
        if amm.market_end_time > 0 {
            // Read current time from oracle via CPI (returns milliseconds)
            let (_, oracle_ts_ms) = read_btc_price_e6(&ctx.accounts.oracle_state)?;
            let oracle_ts = oracle_ts_ms / 1000; // Convert milliseconds to seconds
            let lockout_start_time = amm.market_end_time - TRADING_LOCKOUT_SECONDS;
            let time_until_lockout = lockout_start_time.saturating_sub(oracle_ts);
            let time_until_end = amm.market_end_time.saturating_sub(oracle_ts);

            if oracle_ts >= lockout_start_time {
                msg!("🚫 CLOSE POSITION LOCKED: Oracle time {} >= lockout start {} (market ends at {})",
                     oracle_ts, lockout_start_time, amm.market_end_time);
                msg!("   Time until market end: {} seconds", time_until_end);
                return err!(ReaderError::TradingLocked);
            } else {
                msg!("✅ Close Position Lockout Check PASSED: Oracle time {} < lockout start {}",
                     oracle_ts, lockout_start_time);
                msg!("   Time until lockout: {} seconds | Time until market end: {} seconds",
                     time_until_lockout, time_until_end);
            }
        }

        msg!("🔒 [CLOSE POSITION] Starting position closure");
        msg!("   YES shares: {:.6} ({} e6)", pos.yes_shares_e6 as f64 / 1e6, pos.yes_shares_e6);
        msg!("   NO shares: {:.6} ({} e6)", pos.no_shares_e6 as f64 / 1e6, pos.no_shares_e6);
        msg!("   Vault balance before: {:.6} XNT", pos.vault_balance_e6 as f64 / 1e7);

        let mut total_proceeds_e6 = 0i64;

        // Sell all YES shares if any
        if pos.yes_shares_e6 > 0 {
            let sell_yes_e6 = pos.yes_shares_e6;
            msg!("💰 Selling {} YES shares ({:.6})", sell_yes_e6, sell_yes_e6 as f64 / 1e6);

            let (proceeds_e6, avg_h, sold_e6) = lmsr_sell_yes(amm, sell_yes_e6)?;

            // Check actual vault_sol PDA balance
            let vault_sol_actual_lamports = ctx.accounts.vault_sol.lamports();
            let vault_sol_actual_e6 = lamports_to_e6(vault_sol_actual_lamports);
            msg!("   Coverage check: vault={:.6} XNT, needed={:.6} XNT",
                 usd(vault_sol_actual_e6), usd(proceeds_e6));

            require!(vault_sol_actual_e6 >= proceeds_e6, ReaderError::NoCoverage);

            // Transfer from vault_sol to user_vault
            let amm_key = amm.key();
            let seeds: &[&[u8]] = &[
                Amm::VAULT_SOL_SEED,
                amm_key.as_ref(),
                core::slice::from_ref(&amm.vault_sol_bump),
            ];
            transfer_sol_signed(sys, &ctx.accounts.vault_sol.to_account_info(), &ctx.accounts.user_vault.to_account_info(), e6_to_lamports(proceeds_e6), &[seeds])?;

            pos.yes_shares_e6 = pos.yes_shares_e6.saturating_sub(sold_e6.round() as i64);
            total_proceeds_e6 += proceeds_e6;

            msg!("✅ Sold {:.6} YES shares for {:.6} XNT (avg price: {:.6})",
                 sold_e6, usd(proceeds_e6), avg_h);
            emit_trade(amm, 1, 2, proceeds_e6, sold_e6.round() as i64, avg_h);
        }

        // Sell all NO shares if any
        if pos.no_shares_e6 > 0 {
            let sell_no_e6 = pos.no_shares_e6;
            msg!("💰 Selling {} NO shares ({:.6})", sell_no_e6, sell_no_e6 as f64 / 1e6);

            let (proceeds_e6, avg_h, sold_e6) = lmsr_sell_no(amm, sell_no_e6)?;

            // Check actual vault_sol PDA balance
            let vault_sol_actual_lamports = ctx.accounts.vault_sol.lamports();
            let vault_sol_actual_e6 = lamports_to_e6(vault_sol_actual_lamports);
            msg!("   Coverage check: vault={:.6} XNT, needed={:.6} XNT",
                 usd(vault_sol_actual_e6), usd(proceeds_e6));

            require!(vault_sol_actual_e6 >= proceeds_e6, ReaderError::NoCoverage);

            // Transfer from vault_sol to user_vault
            let amm_key = amm.key();
            let seeds: &[&[u8]] = &[
                Amm::VAULT_SOL_SEED,
                amm_key.as_ref(),
                core::slice::from_ref(&amm.vault_sol_bump),
            ];
            transfer_sol_signed(sys, &ctx.accounts.vault_sol.to_account_info(), &ctx.accounts.user_vault.to_account_info(), e6_to_lamports(proceeds_e6), &[seeds])?;

            pos.no_shares_e6 = pos.no_shares_e6.saturating_sub(sold_e6.round() as i64);
            total_proceeds_e6 += proceeds_e6;

            msg!("✅ Sold {:.6} NO shares for {:.6} XNT (avg price: {:.6})",
                 sold_e6, usd(proceeds_e6), avg_h);
            emit_trade(amm, 2, 2, proceeds_e6, sold_e6.round() as i64, avg_h);
        }

        // Update vault balance
        pos.vault_balance_e6 += total_proceeds_e6;

        msg!("✅ [CLOSE POSITION] Position closed successfully");
        msg!("   Total proceeds: {:.6} XNT ({} e6)", total_proceeds_e6 as f64 / 1e7, total_proceeds_e6);
        msg!("   Vault balance after: {:.6} XNT ({} e6)", pos.vault_balance_e6 as f64 / 1e7, pos.vault_balance_e6);
        msg!("   Remaining YES shares: {}", pos.yes_shares_e6);
        msg!("   Remaining NO shares: {}", pos.no_shares_e6);

        Ok(())
    }

    // ---------- STOP ----------
    pub fn stop_market(ctx: Context<AdminOnly>) -> Result<()> {
        let amm = &mut ctx.accounts.amm;
        let status = amm.status();
        require!(status == MarketStatus::Premarket || status == MarketStatus::Open, ReaderError::WrongState);
        amm.status = MarketStatus::Stopped as u8;
        msg!("⏹️  Market STOPPED");
        Ok(())
    }


    pub fn wipe_position(ctx: Context<WipePosition>) -> Result<()> {
        // simple admin guard: only the configured fee_dest can wipe positions
        require_keys_eq!(ctx.accounts.admin.key(), ctx.accounts.amm.fee_dest, ReaderError::NotOwner);

        let pos = &mut ctx.accounts.pos;
        pos.yes_shares_e6 = 0;
        pos.no_shares_e6  = 0;

        msg!("🧹 wiped position for {}", ctx.accounts.owner.key());
        Ok(())
    }

    /// Migrate old position account (97 bytes) to new layout (901 bytes)
    /// Reads vault balance from old layout, transfers to master wallet, closes old account
    pub fn migrate_position_v1_to_v2(ctx: Context<MigratePosition>) -> Result<()> {
        let position_info = ctx.accounts.old_position.to_account_info();
        let data = position_info.data.borrow();

        // Verify this is the old 97-byte layout
        require!(data.len() == 97, ReaderError::BadParam);

        // Old Position layout (97 bytes):
        // discriminator(8) + owner(32) + yes_shares(8) + no_shares(8) + master_wallet(32) + vault_balance_e6(8) + vault_bump(1)

        // Parse fields from old layout
        let owner_bytes = &data[8..40];
        let yes_shares_bytes = &data[40..48];
        let no_shares_bytes = &data[48..56];
        let master_wallet_bytes = &data[56..88];
        let vault_balance_bytes = &data[88..96];
        let vault_bump = data[96]; // Last byte

        let owner = Pubkey::try_from(owner_bytes).map_err(|_| error!(ReaderError::BadParam))?;
        let yes_shares_e6 = i64::from_le_bytes(yes_shares_bytes.try_into().unwrap());
        let no_shares_e6 = i64::from_le_bytes(no_shares_bytes.try_into().unwrap());
        let master_wallet = Pubkey::try_from(master_wallet_bytes).map_err(|_| error!(ReaderError::BadParam))?;
        let vault_balance_e6 = i64::from_le_bytes(vault_balance_bytes.try_into().unwrap());

        // Verify owner matches
        require_keys_eq!(owner, ctx.accounts.owner.key(), ReaderError::NotOwner);
        require_keys_eq!(master_wallet, ctx.accounts.master_wallet.key(), ReaderError::NotOwner);

        msg!("📦 Migrating position for {}", owner);
        msg!("   Old layout: 97 bytes");
        msg!("   YES shares: {}", yes_shares_e6);
        msg!("   NO shares: {}", no_shares_e6);
        msg!("   Vault balance: {} e6 (${:.6})", vault_balance_e6, vault_balance_e6 as f64 / 1e6);
        msg!("   Master wallet: {}", master_wallet);

        // Warn if user has shares
        if yes_shares_e6 != 0 || no_shares_e6 != 0 {
            msg!("⚠️  WARNING: Position has shares! YES={} NO={}", yes_shares_e6, no_shares_e6);
            msg!("   These shares will be LOST after migration!");
        }

        // Transfer vault balance to master wallet if any
        if vault_balance_e6 > 0 {
            let vault_lamports = (vault_balance_e6 as u64) * LAMPORTS_PER_E6;

            msg!("💸 Transferring {} lamports ({:.6} XNT) from user_vault to master_wallet",
                 vault_lamports, vault_balance_e6 as f64 / 1e6);

            // Transfer from user_vault PDA to master_wallet
            let pos_key = ctx.accounts.old_position.key();
            let seeds: &[&[u8]] = &[
                Position::USER_VAULT_SEED,
                pos_key.as_ref(),
                &[vault_bump],
            ];
            let signer_seeds = &[&seeds[..]];

            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.user_vault.to_account_info(),
                    to: ctx.accounts.master_wallet.to_account_info(),
                },
                signer_seeds,
            );
            anchor_lang::system_program::transfer(cpi_ctx, vault_lamports)?;

            msg!("✅ Vault balance transferred to master wallet");
        } else {
            msg!("   No vault balance to transfer");
        }

        // Close the old position account - return rent to owner
        let position_lamports = position_info.lamports();

        msg!("🗑️  Closing old position account, returning {} lamports rent to {}",
             position_lamports, owner);

        // Transfer lamports from position to owner
        **position_info.try_borrow_mut_lamports()? = 0;
        **ctx.accounts.owner.to_account_info().try_borrow_mut_lamports()? += position_lamports;

        msg!("✅ Migration complete! User can now call init_position to create new 901-byte account");

        Ok(())
    }



    // ---------- SETTLE (manual winner: 1=YES, 2=NO) ----------
    pub fn settle_market(ctx: Context<AdminOnly>, winner: u8) -> Result<()> {
        let amm = &mut ctx.accounts.amm;
        require!(amm.status() == MarketStatus::Stopped, ReaderError::WrongState);
        require!(winner == 1 || winner == 2, ReaderError::BadParam);
        amm.winner = winner;

        // Snapshot W (total winning shares at stop)
        let w = if winner == 1 { amm.q_yes } else { amm.q_no };
        amm.w_total_e6 = w.max(0);

        // pps = min(1e6, floor((vault - reserve) / W)) with exact integers
        let pps_e6 = if amm.w_total_e6 <= 0 {
            0
        } else {
            // CRITICAL FIX: Exclude the 1 XNT reserve from payout pool
            // This ensures all winners get paid before the reserve kicks in
            let reserve_e6: i64 = lamports_to_e6(MIN_VAULT_LAMPORTS);
            let distributable_e6 = (amm.vault_e6 - reserve_e6).max(0);
            let num: i128 = (distributable_e6 as i128) * 1_000_000i128;
            let den: i128 = amm.w_total_e6 as i128;
            let floored: i64 = (num / den) as i64;
            floored.min(1_000_000)
        };
        amm.pps_e6 = pps_e6;
        // Market stays in STOPPED state - users can redeem, then admin can reinit to PREMARKET

        msg!("✅ SETTLED winner={}  W={}  vault=${:.6}  pps={:.6} - Market stays STOPPED for redemptions",
             winner, amm.w_total_e6, usd(amm.vault_e6), (pps_e6 as f64)/1_000_000.0);
        Ok(())
    }

/// If true, we wipe (set to zero) the user's Position even when coverage/reserve makes pay=0.
/// If false, we keep the Position intact when pay=0 so the user can try again later.
const WIPE_ON_PAY_ZERO: bool = true;

pub fn redeem(ctx: Context<Redeem>) -> Result<()> {
    let sys  = &ctx.accounts.system_program;

    // Must be stopped (settlement values calculated)
    require!(ctx.accounts.amm.status() == MarketStatus::Stopped, ReaderError::WrongState);
    // And winner must be determined
    require!(ctx.accounts.amm.winner != 0, ReaderError::WrongState);

    // ---- read-only views
    let pos_ro = &ctx.accounts.pos;
    let amm_ro = &ctx.accounts.amm;

    // winning side balance for this user
    let (win_sh_e6, _lose_sh_e6) = match amm_ro.winner {
        1 => (pos_ro.yes_shares_e6, pos_ro.no_shares_e6),
        2 => (pos_ro.no_shares_e6,  pos_ro.yes_shares_e6),
        _ => (0, 0),
    };

    // nothing to do → wipe anyway (so we don't carry state into next run) and return
    if win_sh_e6 <= 0 {
        let pos_mut = &mut ctx.accounts.pos;
        pos_mut.yes_shares_e6 = 0;
        pos_mut.no_shares_e6  = 0;
        msg!("No winning shares to redeem; position wiped.");
        return Ok(());
    }

    // Theoretical payout at snapshot pps (bounded by mirror)
    let w_snap  = amm_ro.w_total_e6.max(0);
    let win_clip = if win_sh_e6 < 0 { 0 } else { win_sh_e6.min(w_snap) };
    let theoretical_e6: i64 =
        ((win_clip as i128) * (amm_ro.pps_e6 as i128) / 1_000_000i128) as i64;

    // Mirror coverage bound (accounting units)
    let mirror_bound_e6 = theoretical_e6.min(amm_ro.vault_e6.max(0));

    // Lamports availability bound (keep >= 1 SOL)
    let vault_ai = &ctx.accounts.vault_sol.to_account_info();
    let vault_lamports_now = vault_ai.lamports();
    let available_lamports = vault_lamports_now.saturating_sub(MIN_VAULT_LAMPORTS);
    let mirror_bound_lamports = e6_to_lamports(mirror_bound_e6);
    let pay_lamports = mirror_bound_lamports.min(available_lamports);

    if pay_lamports == 0 {
        msg!("⚠️  Reserve/coverage bound: pay=0 (vault={}, keep_reserve={})",
             vault_lamports_now, MIN_VAULT_LAMPORTS);

        // ---- wipe position here if you want a clean slate next run
        if WIPE_ON_PAY_ZERO {
            let pos_mut = &mut ctx.accounts.pos;
            pos_mut.yes_shares_e6 = 0;
            pos_mut.no_shares_e6  = 0;
            msg!("Position wiped despite zero payout (WIPE_ON_PAY_ZERO=true).");
        } else {
            msg!("Leaving position intact (WIPE_ON_PAY_ZERO=false).");
        }
        return Ok(());
    }

    // Convert actual lamports paid back to e6 for mirror accounting
    let pay_e6_effective = lamports_to_e6(pay_lamports);

    // Pay to user_vault PDA (not session wallet)
    let amm_key = ctx.accounts.amm.key();
    let seeds: &[&[u8]] = &[
        Amm::VAULT_SOL_SEED,
        amm_key.as_ref(),
        core::slice::from_ref(&ctx.accounts.amm.vault_sol_bump),
    ];
    transfer_sol_signed(
        sys,
        &ctx.accounts.vault_sol.to_account_info(),
        &ctx.accounts.user_vault.to_account_info(),
        pay_lamports,
        &[seeds],
    )?;

    // ---- mutate mirrors and WIPE position
    let amm_mut = &mut ctx.accounts.amm;
    amm_mut.vault_e6 = amm_mut.vault_e6.saturating_sub(pay_e6_effective);

    let pos_mut = &mut ctx.accounts.pos;
    pos_mut.yes_shares_e6 = 0;
    pos_mut.no_shares_e6  = 0;
    // Update user vault balance tracking
    pos_mut.vault_balance_e6 = pos_mut.vault_balance_e6.saturating_add(pay_e6_effective);

    let kept = vault_ai.lamports(); // after transfer
    msg!(
        "💸 REDEEM pay={} lamports ({:.9} SOL) to user_vault; kept_reserve={} lamports; pps={:.6}, winner={}; vault_balance={} e6",
        pay_lamports,
        (pay_lamports as f64)/1e9,
        kept.min(MIN_VAULT_LAMPORTS),
        (amm_mut.pps_e6 as f64)/1_000_000.0,
        amm_mut.winner,
        pos_mut.vault_balance_e6
    );
    Ok(())
}

    // ---------- ADMIN REDEEM (force redeem on behalf of user) ----------
    pub fn admin_redeem(ctx: Context<AdminRedeem>) -> Result<()> {
        let sys = &ctx.accounts.system_program;

        // Only fee_dest can call this
        require_keys_eq!(ctx.accounts.admin.key(), ctx.accounts.amm.fee_dest, ReaderError::NotOwner);

        // Must be stopped (settlement values calculated)
        require!(ctx.accounts.amm.status() == MarketStatus::Stopped, ReaderError::WrongState);
        // And winner must be determined
        require!(ctx.accounts.amm.winner != 0, ReaderError::WrongState);

        // ---- read-only views
        let pos_ro = &ctx.accounts.pos;
        let amm_ro = &ctx.accounts.amm;

        // winning side balance for this user
        let (win_sh_e6, _lose_sh_e6) = match amm_ro.winner {
            1 => (pos_ro.yes_shares_e6, pos_ro.no_shares_e6),
            2 => (pos_ro.no_shares_e6,  pos_ro.yes_shares_e6),
            _ => (0, 0),
        };

        // nothing to do → wipe anyway and return
        if win_sh_e6 <= 0 {
            let pos_mut = &mut ctx.accounts.pos;
            pos_mut.yes_shares_e6 = 0;
            pos_mut.no_shares_e6  = 0;
            msg!("ADMIN_REDEEM: No winning shares; position wiped.");
            return Ok(());
        }

        // Theoretical payout at snapshot pps (bounded by mirror)
        let w_snap = amm_ro.w_total_e6.max(0);
        let win_clip = if win_sh_e6 < 0 { 0 } else { win_sh_e6.min(w_snap) };
        let theoretical_e6: i64 =
            ((win_clip as i128) * (amm_ro.pps_e6 as i128) / 1_000_000i128) as i64;

        // Mirror coverage bound
        let mirror_bound_e6 = theoretical_e6.min(amm_ro.vault_e6.max(0));

        // Lamports availability bound (keep >= 1 SOL)
        let vault_ai = &ctx.accounts.vault_sol.to_account_info();
        let vault_lamports_now = vault_ai.lamports();
        let available_lamports = vault_lamports_now.saturating_sub(MIN_VAULT_LAMPORTS);
        let mirror_bound_lamports = e6_to_lamports(mirror_bound_e6);
        let pay_lamports = mirror_bound_lamports.min(available_lamports);

        if pay_lamports == 0 {
            msg!("⚠️  ADMIN_REDEEM: Reserve/coverage bound: pay=0 (vault={}, keep_reserve={})",
                 vault_lamports_now, MIN_VAULT_LAMPORTS);

            if WIPE_ON_PAY_ZERO {
                let pos_mut = &mut ctx.accounts.pos;
                pos_mut.yes_shares_e6 = 0;
                pos_mut.no_shares_e6  = 0;
                msg!("Position wiped despite zero payout.");
            }
            return Ok(());
        }

        // Convert actual lamports paid back to e6 for mirror accounting
        let pay_e6_effective = lamports_to_e6(pay_lamports);

        // Pay to user_vault PDA (not session wallet)
        let amm_key = ctx.accounts.amm.key();
        let seeds: &[&[u8]] = &[
            Amm::VAULT_SOL_SEED,
            amm_key.as_ref(),
            core::slice::from_ref(&ctx.accounts.amm.vault_sol_bump),
        ];
        transfer_sol_signed(
            sys,
            &ctx.accounts.vault_sol.to_account_info(),
            &ctx.accounts.user_vault.to_account_info(),
            pay_lamports,
            &[seeds],
        )?;

        // ---- mutate mirrors and WIPE position
        let amm_mut = &mut ctx.accounts.amm;
        amm_mut.vault_e6 = amm_mut.vault_e6.saturating_sub(pay_e6_effective);

        let pos_mut = &mut ctx.accounts.pos;
        pos_mut.yes_shares_e6 = 0;
        pos_mut.no_shares_e6  = 0;
        // Update user vault balance tracking
        pos_mut.vault_balance_e6 = pos_mut.vault_balance_e6.saturating_add(pay_e6_effective);

        let kept = vault_ai.lamports();
        msg!(
            "💸 ADMIN_REDEEM user={} pay={} lamports ({:.9} SOL) to user_vault; kept_reserve={} lamports; vault_balance={} e6",
            ctx.accounts.user.key(),
            pay_lamports,
            (pay_lamports as f64)/1e9,
            kept.min(MIN_VAULT_LAMPORTS),
            pos_mut.vault_balance_e6
        );
        Ok(())
    }

    // ---------- ADMIN FORCE WITHDRAW (emergency withdrawal without master_wallet) ----------
    /// Allows admin (fee_dest) to withdraw funds from user_vault directly to user's wallet
    /// without requiring master_wallet signature. For emergency recovery scenarios.
    pub fn admin_force_withdraw(ctx: Context<AdminForceWithdraw>, amount_lamports: u64) -> Result<()> {
        let pos = &mut ctx.accounts.pos;
        let sys = &ctx.accounts.system_program;

        // Check vault has enough balance
        let vault_lamports = ctx.accounts.user_vault.lamports();
        require!(vault_lamports >= amount_lamports, ReaderError::InsufficientBalance);

        // Update position's vault balance tracking
        let amount_e6 = lamports_to_e6(amount_lamports);
        pos.vault_balance_e6 = pos.vault_balance_e6.saturating_sub(amount_e6);

        // Transfer from user_vault PDA to user's wallet using signed PDA
        let pos_key = pos.key();
        let seeds: &[&[u8]] = &[
            Position::USER_VAULT_SEED,
            pos_key.as_ref(),
            core::slice::from_ref(&pos.vault_bump),
        ];

        transfer_sol_signed(
            sys,
            &ctx.accounts.user_vault.to_account_info(),
            &ctx.accounts.user.to_account_info(),
            amount_lamports,
            &[seeds],
        )?;

        msg!(
            "🔓 ADMIN_FORCE_WITHDRAW: {} lamports ({:.9} SOL) from user_vault to user {}. Remaining vault_balance: {} e6",
            amount_lamports,
            (amount_lamports as f64) / 1e9,
            ctx.accounts.user.key(),
            pos.vault_balance_e6
        );
        Ok(())
    }

    // ---------- ADMIN FIX VAULT BALANCE (sync tracking field to actual lamports) ----------
    /// Allows admin (fee_dest) to fix the vault_balance_e6 tracking field
    /// by syncing it to the actual lamports in the user_vault PDA.
    pub fn admin_fix_vault_balance(ctx: Context<AdminFixVaultBalance>) -> Result<()> {
        let pos = &mut ctx.accounts.pos;
        let vault_lamports = ctx.accounts.user_vault.lamports();

        let old_balance_e6 = pos.vault_balance_e6;
        let new_balance_e6 = lamports_to_e6(vault_lamports);

        pos.vault_balance_e6 = new_balance_e6;

        msg!(
            "🔧 ADMIN_FIX_VAULT_BALANCE: user={} old_balance={} e6 -> new_balance={} e6 (from {} lamports)",
            ctx.accounts.user.key(),
            old_balance_e6,
            new_balance_e6,
            vault_lamports
        );
        Ok(())
    }

    // ---------- CLOSE AMM (new) ----------
    pub fn close_amm(ctx: Context<CloseAmm>) -> Result<()> {
        msg!("🧹 AMM account closed to recipient {}", ctx.accounts.recipient.key());
        Ok(())
    }

    // ---------- NEW: SNAPSHOT the start BTC price ----------
    pub fn snapshot_start(ctx: Context<SnapshotStart>) -> Result<()> {
        let amm = &mut ctx.accounts.amm;
        require!(amm.status() == MarketStatus::Premarket, ReaderError::WrongState);
        require!(amm.start_price_e6 == 0, ReaderError::AlreadySnapshotted);

        let (price_e6, ts) = read_btc_price_e6(&ctx.accounts.oracle_state)?;
        assert_fresh(ts)?;

        amm.start_price_e6 = price_e6;
        amm.start_ts = ts;

        // Transition from PREMARKET to OPEN
        amm.status = MarketStatus::Open as u8;

        msg!("📸 SNAPSHOT start BTC=${:.6} (ts={}) - Market now OPEN", (price_e6 as f64)/1e6, ts);
        Ok(())
    }

    // ---------- SET MARKET END TIME (for trading lockout) ----------
    pub fn set_market_end_slot(ctx: Context<AdminOnly>, market_end_slot: u64, market_end_time: i64) -> Result<()> {
        let amm = &mut ctx.accounts.amm;
        require!(market_end_time > 0, ReaderError::BadParam);

        amm.market_end_slot = market_end_slot;  // Keep for backwards compatibility
        amm.market_end_time = market_end_time;

        msg!("⏰ Market end time set to: {} (unix timestamp)", market_end_time);
        msg!("   Trading locks at: {} (45 seconds before close)", market_end_time - TRADING_LOCKOUT_SECONDS);
        msg!("   Market end slot (legacy): {}", market_end_slot);
        Ok(())
    }

    // ---------- NEW: settle by comparing current BTC to snapshot ----------
    /// ge_wins_yes=true  => YES wins on tie (>=). false => YES only if strictly greater.
    pub fn settle_by_oracle(ctx: Context<SettleByOracle>, ge_wins_yes: bool) -> Result<()> {
        let amm = &mut ctx.accounts.amm;

        require!(amm.status() == MarketStatus::Stopped, ReaderError::WrongState);
        require!(amm.start_price_e6 != 0, ReaderError::NotSnapshotted);

        let (curr_e6, ts) = read_btc_price_e6(&ctx.accounts.oracle_state)?;
        assert_fresh(ts)?;

        let start = amm.start_price_e6;

        // DEBUG: Log price comparison before determining winner
        msg!("🔍 SETTLE DEBUG: start_price={} curr_price={} ge_wins_yes={} comparison={}",
             start, curr_e6, ge_wins_yes, if ge_wins_yes { curr_e6 >= start } else { curr_e6 > start });

        let winner = if ge_wins_yes {
            if curr_e6 >= start { 1 } else { 2 }
        } else {
            if curr_e6 >  start { 1 } else { 2 }
        };

        amm.settle_price_e6 = curr_e6;
        amm.settle_ts = ts;

        // Reuse settlement math
        require!(winner == 1 || winner == 2, ReaderError::BadParam);
        amm.winner = winner;
        let w = if winner == 1 { amm.q_yes } else { amm.q_no };
        amm.w_total_e6 = w.max(0);

        let pps_e6 = if amm.w_total_e6 <= 0 {
            0
        } else {
            // CRITICAL FIX: Exclude the 1 XNT reserve from payout pool
            // This ensures all winners get paid before the reserve kicks in
            let reserve_e6: i64 = lamports_to_e6(MIN_VAULT_LAMPORTS);
            let distributable_e6 = (amm.vault_e6 - reserve_e6).max(0);
            let num: i128 = (distributable_e6 as i128) * 1_000_000i128;
            let den: i128 = amm.w_total_e6 as i128;
            let floored: i64 = (num / den) as i64;
            floored.min(1_000_000)
        };
        amm.pps_e6 = pps_e6;
        // Market stays in STOPPED state - users can redeem, then admin can reinit to PREMARKET

        msg!(
          "✅ SETTLED_BY_ORACLE winner={} start=${:.6}@{} curr=${:.6}@{}  W={}  vault=${:.6}  pps={:.6} - Market stays STOPPED for redemptions",
          winner,
          (start as f64)/1e6, amm.start_ts,
          (curr_e6 as f64)/1e6, ts,
          amm.w_total_e6,
          (amm.vault_e6 as f64)/1e6,
          (pps_e6 as f64)/1e6
        );
        Ok(())
    }

    // ---------- EXECUTE LIMIT ORDER (dark pool off-chain signed orders) ----------
    /// Execute a user's signed limit order
    ///
    /// Validates signature, checks price condition, and executes trade on behalf of user.
    /// Keeper receives fee for executing.
    pub fn execute_limit_order(
        ctx: Context<ExecuteLimitOrder>,
        order: LimitOrder,
        signature: [u8; 64],
    ) -> Result<()> {
        let amm = &ctx.accounts.amm;
        let position = &mut ctx.accounts.position;
        let clock = Clock::get()?;

        msg!("🔍 Executing limit order for user {}", order.user);

        // === VALIDATION PHASE ===

        // 1. Verify Ed25519 signature using instructions sysvar
        verify_ed25519_signature(&order, &signature, &ctx.accounts.instructions.to_account_info())?;
        msg!("✅ Signature verified");

        // 2. Verify order matches this market
        require_keys_eq!(order.market, amm.key(), ReaderError::WrongMarket);

        // 3. Verify order owner matches position owner
        require_keys_eq!(order.user, position.owner, ReaderError::WrongUser);

        // 4. Check order not expired
        require!(
            order.expiry_ts > clock.unix_timestamp,
            ReaderError::OrderExpired
        );
        msg!("⏱️  Order valid until {}", order.expiry_ts);

        // 5. Check nonce not already used
        require!(
            !position.used_nonces.contains(&order.nonce),
            ReaderError::NonceAlreadyUsed
        );

        // 6. Check market is open (allow both Premarket and Open)
        let status = amm.status();
        require!(
            status == MarketStatus::Premarket || status == MarketStatus::Open,
            ReaderError::MarketClosed
        );

        // === PRICE CHECK PHASE ===

        // Calculate current price for this action/side
        let current_price = calculate_avg_price_for_one_share(order.action, order.side, amm)?;

        msg!("💰 Current price: {} | Limit: {}", current_price, order.limit_price_e6);

        // Verify price condition is favorable
        let price_ok = match order.action {
            1 => { // BUY: current price must be <= limit price
                current_price <= order.limit_price_e6
            }
            2 => { // SELL: current price must be >= limit price
                current_price >= order.limit_price_e6
            }
            _ => return err!(ReaderError::InvalidAction),
        };

        require!(price_ok, ReaderError::PriceConditionNotMet);
        msg!("✅ Price condition satisfied");

        // === EXECUTION PHASE ===

        // Build guards for partial fill logic (reuse existing code)
        let guards = AdvancedGuardConfig {
            price_limit_e6: order.limit_price_e6,
            max_slippage_bps: 0,
            quote_price_e6: current_price,
            quote_timestamp: clock.unix_timestamp,
            max_total_cost_e6: order.max_cost_e6,
            allow_partial: true,
            min_fill_shares_e6: (order.shares_e6 as i128 * order.min_fill_bps as i128 / 10000) as i64,
        };

        // Find max executable shares (uses Newton-Raphson or binary search)
        let executable_shares = find_max_executable_shares(
            order.action,
            order.side,
            order.shares_e6,
            &guards,
            amm,
        )?;

        msg!("📊 Executing {} of {} shares", executable_shares, order.shares_e6);

        // Reject orders that would execute 0 shares
        require!(executable_shares > 0, ReaderError::MinFillNotMet);

        // === TRADE EXECUTION PHASE ===

        let (net_e6, dq_e6, avg_price_e6) = match (order.action, order.side) {
            (1, 1) => {
                // BUY YES: Calculate spend needed for executable shares
                let spend_e6 = lmsr_buy_yes_for_shares(&amm, executable_shares)?;
                let (dq, avg_h) = lmsr_buy_yes(&mut ctx.accounts.amm, spend_e6)?;
                let avg_price = (spend_e6 as f64 / dq) as i64;

                // Update position
                position.yes_shares_e6 = position.yes_shares_e6.saturating_add(dq.round() as i64);

                msg!("✅ BUY YES executed: {} shares @ ${:.6}", dq.round() as i64, avg_h);
                (spend_e6, dq.round() as i64, avg_price)
            },
            (1, 2) => {
                // BUY NO: Calculate spend needed for executable shares
                let spend_e6 = lmsr_buy_no_for_shares(&amm, executable_shares)?;
                let (dq, avg_h) = lmsr_buy_no(&mut ctx.accounts.amm, spend_e6)?;
                let avg_price = (spend_e6 as f64 / dq) as i64;

                // Update position
                position.no_shares_e6 = position.no_shares_e6.saturating_add(dq.round() as i64);

                msg!("✅ BUY NO executed: {} shares @ ${:.6}", dq.round() as i64, avg_h);
                (spend_e6, dq.round() as i64, avg_price)
            },
            (2, 1) => {
                // SELL YES: Check user has enough shares
                require!(position.yes_shares_e6 >= executable_shares, ReaderError::InsufficientShares);

                let (proceeds_e6, avg_h, sold_e6) = lmsr_sell_yes(&mut ctx.accounts.amm, executable_shares)?;
                let avg_price = (proceeds_e6 as f64 / sold_e6) as i64;

                // Update position
                position.yes_shares_e6 = position.yes_shares_e6.saturating_sub(sold_e6.round() as i64);

                msg!("✅ SELL YES executed: {} shares @ ${:.6}", sold_e6.round() as i64, avg_h);
                (proceeds_e6, sold_e6.round() as i64, avg_price)
            },
            (2, 2) => {
                // SELL NO: Check user has enough shares
                require!(position.no_shares_e6 >= executable_shares, ReaderError::InsufficientShares);

                let (proceeds_e6, avg_h, sold_e6) = lmsr_sell_no(&mut ctx.accounts.amm, executable_shares)?;
                let avg_price = (proceeds_e6 as f64 / sold_e6) as i64;

                // Update position
                position.no_shares_e6 = position.no_shares_e6.saturating_sub(sold_e6.round() as i64);

                msg!("✅ SELL NO executed: {} shares @ ${:.6}", sold_e6.round() as i64, avg_h);
                (proceeds_e6, sold_e6.round() as i64, avg_price)
            },
            _ => return err!(ReaderError::InvalidAction),
        };

        msg!("📊 Trade completed: net={} dq={} avg_price={:.6}", net_e6, dq_e6, avg_price_e6 as f64 / 1e6);

        // === FUND TRANSFER PHASE ===

        let amm = &mut ctx.accounts.amm;
        let position = &mut ctx.accounts.position;

        // Calculate protocol fee (deducted from gross amount)
        let protocol_fee_e6 = (net_e6.abs() as i128 * amm.fee_bps as i128 / 10_000) as i64;
        let net_after_protocol_fee_e6 = if order.action == 1 {
            net_e6 + protocol_fee_e6  // BUY: add fee to total cost
        } else {
            net_e6 - protocol_fee_e6  // SELL: subtract fee from proceeds
        };

        let net_lamports = (net_after_protocol_fee_e6.abs() as u64) * LAMPORTS_PER_E6;
        let protocol_fee_lamports = (protocol_fee_e6 as u64) * LAMPORTS_PER_E6;

        if order.action == 1 {
            // === BUY ORDER: Transfer from user_vault to vault_sol ===

            // Check user has sufficient balance in vault
            require!(
                position.vault_balance_e6 >= net_after_protocol_fee_e6,
                ReaderError::InsufficientBalance
            );

            // Transfer from user_vault PDA to vault_sol PDA (signed transfer)
            let pos_key = position.key();
            let seeds: &[&[u8]] = &[
                Position::USER_VAULT_SEED,
                pos_key.as_ref(),
                &[position.vault_bump],
            ];
            let signer_seeds = &[&seeds[..]];

            transfer_sol_signed(
                &ctx.accounts.system_program,
                &ctx.accounts.user_vault,
                &ctx.accounts.vault_sol,
                net_lamports,
                signer_seeds,
            )?;

            // Update accounting
            position.vault_balance_e6 = position.vault_balance_e6.saturating_sub(net_after_protocol_fee_e6);
            amm.vault_e6 = amm.vault_e6.saturating_add(net_after_protocol_fee_e6);

            // Transfer protocol fee to fee_dest
            if protocol_fee_lamports > 0 {
                transfer_sol_signed(
                    &ctx.accounts.system_program,
                    &ctx.accounts.user_vault,
                    &ctx.accounts.fee_dest.to_account_info(),
                    protocol_fee_lamports,
                    signer_seeds,
                )?;

                position.vault_balance_e6 = position.vault_balance_e6.saturating_sub(protocol_fee_e6);
            }

            msg!("💰 BUY: Transferred {} lamports from user_vault to vault_sol", net_lamports);
            msg!("💰 Protocol fee: {} lamports to fee_dest", protocol_fee_lamports);
        } else {
            // === SELL ORDER: Transfer from vault_sol to user_vault ===

            // Get actual vault_sol balance
            let vault_sol_actual = ctx.accounts.vault_sol.lamports();
            let vault_sol_actual_e6 = (vault_sol_actual / LAMPORTS_PER_E6) as i64;

            // Check vault has sufficient coverage
            require!(vault_sol_actual_e6 >= net_after_protocol_fee_e6, ReaderError::NoCoverage);

            // Transfer from vault_sol PDA to user_vault PDA (signed transfer)
            let amm_key = amm.key();
            let seeds: &[&[u8]] = &[
                Amm::VAULT_SOL_SEED,
                amm_key.as_ref(),
                &[amm.vault_sol_bump],
            ];
            let signer_seeds = &[&seeds[..]];

            transfer_sol_signed(
                &ctx.accounts.system_program,
                &ctx.accounts.vault_sol,
                &ctx.accounts.user_vault,
                net_lamports,
                signer_seeds,
            )?;

            // Update accounting
            position.vault_balance_e6 = position.vault_balance_e6.saturating_add(net_after_protocol_fee_e6);
            amm.vault_e6 = amm.vault_e6.saturating_sub(net_after_protocol_fee_e6);

            // Transfer protocol fee to fee_dest
            if protocol_fee_lamports > 0 {
                transfer_sol_signed(
                    &ctx.accounts.system_program,
                    &ctx.accounts.vault_sol,
                    &ctx.accounts.fee_dest.to_account_info(),
                    protocol_fee_lamports,
                    signer_seeds,
                )?;

                amm.vault_e6 = amm.vault_e6.saturating_sub(protocol_fee_e6);
            }

            msg!("💰 SELL: Transferred {} lamports from vault_sol to user_vault", net_lamports);
            msg!("💰 Protocol fee: {} lamports to fee_dest", protocol_fee_lamports);
        }

        // === FEE PAYMENT PHASE ===

        // Calculate keeper fee from the net amount
        let keeper_fee_e6 = (net_e6.abs() as i128 * order.keeper_fee_bps as i128 / 10_000) as i64;
        let keeper_fee_lamports = (keeper_fee_e6 as u64) * LAMPORTS_PER_E6;

        // Transfer keeper fee from user_vault to keeper (using PDA signing)
        if keeper_fee_lamports > 0 {
            // Use user_vault PDA (which we control) instead of user's wallet
            let pos_key = position.key();
            let seeds: &[&[u8]] = &[
                Position::USER_VAULT_SEED,
                pos_key.as_ref(),
                &[position.vault_bump],
            ];
            let signer_seeds = &[&seeds[..]];

            transfer_sol_signed(
                &ctx.accounts.system_program,
                &ctx.accounts.user_vault,
                &ctx.accounts.keeper.to_account_info(),
                keeper_fee_lamports,
                signer_seeds,
            )?;

            // Update vault balance
            position.vault_balance_e6 = position.vault_balance_e6.saturating_sub(keeper_fee_e6);

            msg!("💸 Keeper fee paid: {} lamports to {}", keeper_fee_lamports, ctx.accounts.keeper.key);
        }

        // === CLEANUP PHASE ===

        // Mark nonce as used (replay protection with rolling window)
        // Remove oldest nonce BEFORE adding new one to stay at or below MAX_NONCES
        if position.used_nonces.len() >= Position::MAX_NONCES {
            position.used_nonces.remove(0);
        }
        position.used_nonces.push(order.nonce);

        // Emit event
        emit!(LimitOrderExecuted {
            user: order.user,
            keeper: *ctx.accounts.keeper.key,
            action: order.action,
            side: order.side,
            shares_requested: order.shares_e6,
            shares_executed: executable_shares,
            limit_price: order.limit_price_e6,
            execution_price: avg_price_e6,
            keeper_fee_bps: order.keeper_fee_bps,
            nonce: order.nonce,
        });

        msg!("✅ Limit order executed successfully!");
        Ok(())
    }

    // ---------- CANCEL ORDER NONCE (allow users to burn a nonce to prevent future execution) ----------
    pub fn cancel_order_nonce(
        ctx: Context<CancelOrderNonce>,
        nonce: u64,
    ) -> Result<()> {
        let position = &mut ctx.accounts.position;

        // Add nonce to used list (prevents execution)
        require!(
            !position.used_nonces.contains(&nonce),
            ReaderError::NonceAlreadyUsed
        );

        // Add nonce with rolling window cleanup
        if position.used_nonces.len() >= Position::MAX_NONCES {
            position.used_nonces.remove(0);
        }
        position.used_nonces.push(nonce);

        emit!(OrderNonceCancelled {
            user: position.owner,
            nonce,
        });

        msg!("✅ Order nonce {} cancelled for user {}", nonce, position.owner);
        Ok(())
    }
}

// ============================== Helpers & LMSR math ==============================

#[inline] fn sh(x: i64) -> f64 { (x as f64) / 1_000_000.0 }
// XNT amounts use lamports scale: 1 XNT = 10_000_000 e6 (due to LAMPORTS_PER_E6=100)
#[inline] fn usd(x: i64) -> f64 { (x as f64) / 10_000_000.0 }

#[inline]
fn lmsr_cost(amm: &Amm, qy: f64, qn: f64) -> f64 {
    let b = amm.b as f64 / 1_000_000.0;
    let a = qy / b;
    let c = qn / b;
    let m = a.max(c);
    let ea = (a - m).exp();
    let ec = (c - m).exp();
    b * (m + (ea + ec).ln())
}

#[inline]
fn lmsr_p_yes(amm: &Amm) -> f64 {
    let a = ((amm.q_yes as f64) / (amm.b as f64)).exp();
    let c = ((amm.q_no  as f64) / (amm.b as f64)).exp();
    a / (a + c)
}

// Helper: Calculate current YES price for slippage protection
fn calculate_yes_price(amm: &Amm) -> i64 {
    let b = amm.b as f64;
    let q_yes = amm.q_yes as f64;
    let q_no = amm.q_no as f64;
    let exp_yes = (q_yes / b).exp();
    let exp_no = (q_no / b).exp();
    let prob = exp_yes / (exp_yes + exp_no);
    (prob * 1e6) as i64
}

// Helper: Calculate current NO price for slippage protection
fn calculate_no_price(amm: &Amm) -> i64 {
    let b = amm.b as f64;
    let q_yes = amm.q_yes as f64;
    let q_no = amm.q_no as f64;
    let exp_yes = (q_yes / b).exp();
    let exp_no = (q_no / b).exp();
    let prob = exp_no / (exp_yes + exp_no);
    (prob * 1e6) as i64
}

// Helper: Calculate proceeds from selling YES shares (without mutating AMM)
fn calculate_sell_yes_proceeds(amm: &Amm, shares_e6: i64) -> i64 {
    let sell_e6 = shares_e6.min(amm.q_yes);
    if sell_e6 <= 0 {
        return 0;
    }

    let pre = lmsr_cost(amm, sh(amm.q_yes), sh(amm.q_no));
    let post = lmsr_cost(amm, sh(amm.q_yes - sell_e6), sh(amm.q_no));
    let mut gross_h = pre - post;
    if !gross_h.is_finite() || gross_h < 0.0 {
        gross_h = 0.0;
    }

    let gross_e6_f = gross_h * 1_000_000.0;
    let fee_e6_f = (gross_e6_f * (amm.fee_bps as f64) / 10_000.0).max(0.0);
    let net_e6_f = (gross_e6_f - fee_e6_f).max(0.0);

    net_e6_f.round() as i64
}

// Helper: Calculate proceeds from selling NO shares (without mutating AMM)
fn calculate_sell_no_proceeds(amm: &Amm, shares_e6: i64) -> i64 {
    let sell_e6 = shares_e6.min(amm.q_no);
    if sell_e6 <= 0 {
        return 0;
    }

    let pre = lmsr_cost(amm, sh(amm.q_yes), sh(amm.q_no));
    let post = lmsr_cost(amm, sh(amm.q_yes), sh(amm.q_no - sell_e6));
    let mut gross_h = pre - post;
    if !gross_h.is_finite() || gross_h < 0.0 {
        gross_h = 0.0;
    }

    let gross_e6_f = gross_h * 1_000_000.0;
    let fee_e6_f = (gross_e6_f * (amm.fee_bps as f64) / 10_000.0).max(0.0);
    let net_e6_f = (gross_e6_f - fee_e6_f).max(0.0);

    net_e6_f.round() as i64
}

// ---- Advanced Guard Validation ----

/// Check if a given number of shares passes all guards
fn shares_pass_guards(
    shares_e6: i64,
    action: u8,
    side: u8,
    guards: &AdvancedGuardConfig,
    amm: &Amm,
) -> Result<bool> {
    // Get current market price for slippage check
    let current_price_e6 = if side == 1 { // YES
        calculate_yes_price(amm)
    } else { // NO
        calculate_no_price(amm)
    };

    // Calculate execution price and cost for this number of shares
    let (execution_price_e6, total_cost_e6) = if action == 1 { // BUY
        let spend_e6 = if side == 1 {
            lmsr_buy_yes_for_shares(amm, shares_e6)?
        } else {
            lmsr_buy_no_for_shares(amm, shares_e6)?
        };
        let price_per_share = if shares_e6 > 0 {
            ((spend_e6 as i128 * 1_000_000) / shares_e6 as i128) as i64
        } else {
            0
        };
        (price_per_share, spend_e6)
    } else { // SELL
        let proceeds_e6 = if side == 1 {
            calculate_sell_yes_proceeds(amm, shares_e6)
        } else {
            calculate_sell_no_proceeds(amm, shares_e6)
        };
        let price_per_share = if shares_e6 > 0 {
            ((proceeds_e6 as i128 * 1_000_000) / shares_e6 as i128) as i64
        } else {
            0
        };
        (price_per_share, proceeds_e6)
    };

    msg!("📊 Price check: shares={} exec_price={} current_price={} cost={}",
         shares_e6, execution_price_e6, current_price_e6, total_cost_e6);

    // Check absolute price limit (with 0.2% tolerance for execution timing)
    if guards.has_price_limit() {
        // Add 20 bps (0.2%) tolerance to handle microsecond price movements between simulation and execution
        let tolerance = (guards.price_limit_e6 as i128 * 20) / 10_000;

        if action == 1 { // BUY: execution price must not exceed limit + tolerance
            let max_allowed = guards.price_limit_e6 as i128 + tolerance;
            msg!("🔒 Price limit check (BUY): exec={} max_allowed={} limit={} tolerance={}",
                 execution_price_e6, max_allowed, guards.price_limit_e6, tolerance);
            if execution_price_e6 as i128 > max_allowed {
                msg!("❌ FAILED: Price {} exceeds limit {}", execution_price_e6, max_allowed);
                return Ok(false);
            }
        } else { // SELL: execution price must not fall below limit - tolerance
            let min_allowed = (guards.price_limit_e6 as i128).saturating_sub(tolerance);
            msg!("🔒 Price limit check (SELL): exec={} min_allowed={} limit={} tolerance={}",
                 execution_price_e6, min_allowed, guards.price_limit_e6, tolerance);
            if (execution_price_e6 as i128) < min_allowed {
                msg!("❌ FAILED: Price {} below limit {}", execution_price_e6, min_allowed);
                return Ok(false);
            }
        }
    }

    // Check slippage against quote
    if guards.has_slippage_guard() {
        let max_deviation = (guards.quote_price_e6 as i128 * guards.max_slippage_bps as i128) / 10_000;

        if action == 1 { // BUY: price can go up by slippage%
            let max_price = guards.quote_price_e6 as i128 + max_deviation;
            msg!("🔒 Slippage check (BUY): exec={} max={} quote={} slippage_bps={}",
                 execution_price_e6, max_price, guards.quote_price_e6, guards.max_slippage_bps);
            if execution_price_e6 as i128 > max_price {
                msg!("❌ FAILED: Price {} exceeds max {}", execution_price_e6, max_price);
                return Ok(false);
            }
        } else { // SELL: price can go down by slippage%
            let min_price = (guards.quote_price_e6 as i128 - max_deviation).max(0);
            msg!("🔒 Slippage check (SELL): exec={} min={} quote={} slippage_bps={}",
                 execution_price_e6, min_price, guards.quote_price_e6, guards.max_slippage_bps);
            if (execution_price_e6 as i128) < min_price {
                msg!("❌ FAILED: Price {} below min {}", execution_price_e6, min_price);
                return Ok(false);
            }
        }
    }

    // Check max total cost (only for BUY)
    if action == 1 && guards.has_cost_limit() {
        msg!("🔒 Cost limit check: cost={} limit={}", total_cost_e6, guards.max_total_cost_e6);
        if total_cost_e6 > guards.max_total_cost_e6 {
            msg!("❌ FAILED: Cost {} exceeds limit {}", total_cost_e6, guards.max_total_cost_e6);
            return Ok(false);
        }
    }

    Ok(true)
}

/// Binary search to find maximum executable shares within guard constraints
/// Uses exponential backoff + binary search for efficiency
fn find_max_executable_shares(
    action: u8,
    side: u8,
    max_shares_e6: i64,
    guards: &AdvancedGuardConfig,
    amm: &Amm,
) -> Result<i64> {
    let min_trade = if action == 2 { MIN_SELL_E6 } else { 100_000 }; // Min 0.1 shares
    let search_min = guards.min_fill_shares_e6.max(min_trade);

    msg!("🔁 SEARCH START: min={} max={}", search_min, max_shares_e6);

    // Phase 1: Exponential backoff from max to quickly find a working range
    // Try 100%, 50%, 25%, 12.5%, etc. until we find one that passes
    let mut test_amount = max_shares_e6;
    let mut last_failed = max_shares_e6;
    let mut backoff_iteration = 0;

    msg!("🔽 Phase 1: Exponential backoff from max");
    while test_amount >= search_min && backoff_iteration < 8 {
        msg!("🔽 Backoff {}: testing {} shares", backoff_iteration, test_amount);

        if shares_pass_guards(test_amount, action, side, guards, amm)? {
            msg!("✅ {} shares PASSED - found working range!", test_amount);
            // Found a passing amount! Now optimize between test_amount and last_failed
            if test_amount == max_shares_e6 {
                // Best case: full amount works!
                msg!("🎯 Full amount executable!");
                return Ok(max_shares_e6);
            }
            // Use Newton-Raphson for faster convergence (or binary search fallback)
            let result = newton_raphson_search(test_amount, last_failed, action, side, guards, amm)?;
            msg!("🔁 SEARCH COMPLETE: best = {}", result);
            return Ok(result);
        }

        msg!("❌ {} shares FAILED", test_amount);
        last_failed = test_amount;
        test_amount = test_amount / 2;
        backoff_iteration += 1;
    }

    // Phase 2: If backoff didn't find anything, use binary search from min
    // (Newton won't help here since we don't have a good starting point)
    msg!("🔁 Phase 2: Binary search from min (backoff found nothing)");
    let result = binary_search_range(search_min, last_failed, action, side, guards, amm)?;
    msg!("🔁 SEARCH COMPLETE: best = {}", result);
    Ok(result)
}

/// Helper: Newton-Raphson method to find maximum shares within price limit or slippage
/// Uses numerical optimization for much faster convergence (3-5 iterations vs 16)
fn newton_raphson_search(
    initial_guess: i64,
    max_shares: i64,
    action: u8,
    side: u8,
    guards: &AdvancedGuardConfig,
    amm: &Amm,
) -> Result<i64> {
    // Newton works best for pure price/slippage constraints
    // For cost limits or mixed constraints, binary search is more reliable
    if !guards.has_price_limit() && !guards.has_slippage_guard() {
        msg!("🔁 No price/slippage limit - falling back to binary search");
        return binary_search_range(initial_guess, max_shares, action, side, guards, amm);
    }

    // If cost limit is present (for BUY), it may be the binding constraint
    // Binary search handles multi-constraint cases better
    if action == 1 && guards.has_cost_limit() {
        msg!("🔁 Cost limit active - using binary search for multi-constraint optimization");
        return binary_search_range(initial_guess, max_shares, action, side, guards, amm);
    }

    let guard_type = if guards.has_price_limit() { "price limit" } else { "slippage" };
    msg!("🔬 Phase 2: Newton-Raphson optimization [{} guard] (initial guess: {})", guard_type, initial_guess);

    // Calculate effective price limit (works for both guard types)
    let price_limit = if guards.has_price_limit() {
        guards.price_limit_e6 as i128 + (guards.price_limit_e6 as i128 * 20) / 10_000 // with tolerance
    } else if guards.has_slippage_guard() {
        let max_deviation = (guards.quote_price_e6 as i128 * guards.max_slippage_bps as i128) / 10_000;
        if action == 1 { // BUY: price can go up by slippage%
            guards.quote_price_e6 as i128 + max_deviation
        } else { // SELL: price can go down by slippage%
            (guards.quote_price_e6 as i128 - max_deviation).max(0)
        }
    } else {
        return binary_search_range(initial_guess, max_shares, action, side, guards, amm);
    };

    let mut shares = initial_guess as i128;

    for iteration in 0..8 {
        // Calculate f(shares) = avg_price(shares) - price_limit
        let price_at_shares = calculate_avg_price(shares as i64, action, side, amm)?;
        let error = price_at_shares as i128 - price_limit;

        msg!("🔬 Iteration {}: shares={} price={} limit={} error={}",
             iteration, shares, price_at_shares, price_limit, error);

        // Converged if error is small (within 1 e6 unit = $0.000001)
        if error.abs() <= 1 {
            msg!("✅ Converged! shares={} price={}", shares, price_at_shares);
            // Validate and return
            if shares_pass_guards(shares as i64, action, side, guards, amm)? {
                return Ok(shares as i64);
            } else {
                // Slightly over, step back
                shares = shares.saturating_sub(100);
                return Ok(shares as i64);
            }
        }

        // Calculate derivative with larger step (1%) and better precision
        // Use scaled arithmetic to avoid losing precision in integer division
        let delta = shares / 100; // 1% step instead of 0.1%
        if delta == 0 {
            msg!("⚠️  Delta too small, switching to binary search");
            return binary_search_range(shares as i64, max_shares, action, side, guards, amm);
        }

        let price_at_shares_plus = calculate_avg_price((shares + delta) as i64, action, side, amm)?;
        let price_diff = price_at_shares_plus as i128 - price_at_shares as i128;

        // Scale by 1M to preserve precision: derivative = (Δprice * 1M) / Δshares
        let derivative_scaled = (price_diff * 1_000_000) / delta;

        if derivative_scaled == 0 {
            msg!("⚠️  Derivative is zero, switching to binary search");
            return binary_search_range(shares as i64, max_shares, action, side, guards, amm);
        }

        // Newton step: shares_new = shares - error / derivative
        // Since derivative is scaled by 1M, multiply error by 1M too
        let step = (error * 1_000_000) / derivative_scaled;
        let new_shares = shares - step;

        msg!("🔬 Step: price_diff={} derivative_scaled={} step={} new_shares={}",
             price_diff, derivative_scaled, step, new_shares);

        // Clamp to valid range
        shares = new_shares.max(100_000).min(max_shares as i128);
    }

    // Fallback: didn't converge, use final shares
    msg!("⚠️  Newton didn't converge in 8 iterations, using best estimate");
    Ok(shares as i64)
}

/// Calculate average price for buying/selling a given number of shares
fn calculate_avg_price(shares_e6: i64, action: u8, side: u8, amm: &Amm) -> Result<i64> {
    let (price_per_share, _cost) = if action == 1 { // BUY
        let spend_e6 = if side == 1 {
            lmsr_buy_yes_for_shares(amm, shares_e6)?
        } else {
            lmsr_buy_no_for_shares(amm, shares_e6)?
        };
        let price = if shares_e6 > 0 {
            ((spend_e6 as i128 * 1_000_000) / shares_e6 as i128) as i64
        } else {
            0
        };
        (price, spend_e6)
    } else { // SELL
        let proceeds_e6 = if side == 1 {
            calculate_sell_yes_proceeds(amm, shares_e6)
        } else {
            calculate_sell_no_proceeds(amm, shares_e6)
        };
        let price = if shares_e6 > 0 {
            ((proceeds_e6 as i128 * 1_000_000) / shares_e6 as i128) as i64
        } else {
            0
        };
        (price, proceeds_e6)
    };
    Ok(price_per_share)
}

/// Helper: Binary search in a specific range (fallback method)
fn binary_search_range(
    mut left: i64,
    mut right: i64,
    action: u8,
    side: u8,
    guards: &AdvancedGuardConfig,
    amm: &Amm,
) -> Result<i64> {
    let mut best = 0i64;

    for iteration in 0..16 {
        if left > right {
            msg!("🔁 Binary search ended at iteration {}", iteration);
            break;
        }

        let mid = (left + right) / 2;
        msg!("🔁 Iteration {}: testing {} (range [{}, {}])", iteration, mid, left, right);

        if shares_pass_guards(mid, action, side, guards, amm)? {
            best = mid;
            msg!("✅ {} PASSED - trying larger", mid);
            left = mid + 1;
        } else {
            msg!("❌ {} FAILED - trying smaller", mid);
            right = mid - 1;
        }
    }

    Ok(best)
}

/// Validate advanced guards and return shares to execute
/// Returns the number of shares to execute (may be less than requested if partial fills enabled)
fn validate_advanced_guards(
    action: u8,
    side: u8,
    amount_e6: i64,
    guards: &AdvancedGuardConfig,
    amm: &Amm,
) -> Result<i64> {
    // 1. Validate quote staleness if using slippage guard
    if guards.has_slippage_guard() {
        let now = Clock::get()?.unix_timestamp;
        require!(
            now - guards.quote_timestamp <= 30,
            ReaderError::StaleQuote
        );
    }

    // 2. Validate guard configuration
    // (min_fill_shares_e6 = 0 is allowed, means no minimum enforced)

    // 3. Try full execution first
    if shares_pass_guards(amount_e6, action, side, guards, amm)? {
        msg!("✅ ADVANCED GUARDS: Full execution allowed for {} shares", amount_e6);
        return Ok(amount_e6);
    }

    // 4. If partial fills not allowed, reject
    if !guards.allow_partial {
        msg!("❌ ADVANCED GUARDS: Full execution failed, partial not allowed");
        if guards.has_price_limit() {
            return err!(ReaderError::PriceLimitExceeded);
        } else if guards.has_slippage_guard() {
            return err!(ReaderError::SlippageExceeded);
        } else if guards.has_cost_limit() {
            return err!(ReaderError::CostExceedsLimit);
        } else {
            return err!(ReaderError::InvalidGuardConfig);
        }
    }

    // 5. Binary search for max executable shares
    msg!("🔍 ADVANCED GUARDS: Searching for partial fill...");
    let executable = find_max_executable_shares(action, side, amount_e6, guards, amm)?;

    // 6. Check if any shares can be executed
    if executable == 0 {
        msg!("❌ ADVANCED GUARDS: No shares can be executed within guard constraints");
        if guards.has_price_limit() {
            return err!(ReaderError::PriceLimitExceeded);
        } else if guards.has_slippage_guard() {
            return err!(ReaderError::SlippageExceeded);
        } else if guards.has_cost_limit() {
            return err!(ReaderError::CostExceedsLimit);
        } else {
            return err!(ReaderError::InvalidGuardConfig);
        }
    }

    // 7. Check minimum fill requirement (only if min_fill > 0)
    if guards.min_fill_shares_e6 > 0 && executable < guards.min_fill_shares_e6 {
        msg!("❌ ADVANCED GUARDS: Max executable {} below min fill {}",
             executable, guards.min_fill_shares_e6);
        return err!(ReaderError::MinFillNotMet);
    }

    msg!("✅ ADVANCED GUARDS: Partial execution allowed: {}/{} shares",
         executable, amount_e6);
    Ok(executable)
}

// ---- logging helpers ----
fn emit_trade(amm: &Amm, side: u8, action: u8, net_e6: i64, dq_e6: i64, avg_h: f64) {
    let p_yes_e6 = (lmsr_p_yes(amm) * 1_000_000.0).round() as i64;
    emit!(TradeSnapshot {
        side, action,
        net_e6, dq_e6,
        avg_price_e6: (avg_h * 1_000_000.0).round() as i64,
        q_yes: amm.q_yes, q_no: amm.q_no,
        vault_e6: amm.vault_e6,
        p_yes_e6,
        fees_e6: amm.fees,
    });
}
fn log_trade_buy(tag: &str, spend_e6: i64, shares_e6: f64, avg_h: f64, p: f64, amm: &Amm) {
    // spend_e6 uses XNT scale (1 XNT = 10M e6), shares_e6 is already dq_h * 1M (so divide by 100 to get shares)
    let spend_xnt = spend_e6 as f64 / 10_000_000.0;
    let shares = shares_e6 / 10_000_000.0;  // dq_e6 is in wrong scale, divide by 10M to fix display
    msg!("{tag}: spend={:.6} XNT -> shares={:.6} @avg={:.6}  pYes={:.6}",
         spend_xnt, shares, avg_h, p);
    msg!("          qY={:.6}sh qN={:.6}sh vault={:.6} XNT fees={:.6} XNT",
         sh(amm.q_yes), sh(amm.q_no), usd(amm.vault_e6), usd(amm.fees));
}
fn log_trade_sell(tag: &str, sold_e6: f64, proceeds_e6: i64, avg_h: f64, p: f64, amm: &Amm) {
    let shares = sold_e6 / 10_000_000.0;  // sold_e6 is in wrong scale, divide by 10M to fix display
    // proceeds_e6 uses XNT scale (1 XNT = 10M e6)
    let proceeds_xnt = proceeds_e6 as f64 / 10_000_000.0;
    msg!("{tag}: shares={:.6} -> proceeds={:.6} XNT @avg={:.6}  pYes={:.6}",
         shares, proceeds_xnt, avg_h, p);
    msg!("          qY={:.6}sh qN={:.6}sh vault={:.6} XNT fees={:.6} XNT",
         sh(amm.q_yes), sh(amm.q_no), usd(amm.vault_e6), usd(amm.fees));
}

// ---- BUY YES ----
fn lmsr_buy_yes(amm: &mut Amm, spend_e6: i64) -> Result<(f64, f64)> {
    let fee = (spend_e6 as f64) * (amm.fee_bps as f64) / 10_000.0;
    let net_e6 = (spend_e6 as f64) - fee;
    require!(net_e6 > 0.0, ReaderError::BadParam);
    amm.fees = amm.fees.saturating_add(fee.round() as i64);

    let base = lmsr_cost(amm, sh(amm.q_yes), sh(amm.q_no));
    let p = lmsr_p_yes(amm).max(1e-9);
    let mut hi = (net_e6 / 1_000_000.0 / p).min((amm.b as f64 / 1_000_000.0) * 5.0);
    if hi < 1.0 { hi = 1.0; }
    let mut lo = 0.0;
    for _ in 0..32 {
        let mid = 0.5*(lo+hi);
        let val = lmsr_cost(amm, sh(amm.q_yes)+mid, sh(amm.q_no)) - base;
        let diff = val - (net_e6/1_000_000.0);
        if diff.abs() <= 1e-9 { lo=mid; hi=mid; break; }
        if diff < 0.0 { lo=mid; } else { hi=mid; }
    }
    let dq_h = 0.5*(lo+hi);
    let dq_e6_f = (dq_h * 1_000_000.0).max(0.0);
    let dq_i = dq_e6_f.round() as i64;

    require!(dq_i <= DQ_MAX_E6, ReaderError::BadParam);

    amm.q_yes = amm.q_yes.saturating_add(dq_i);
    amm.vault_e6 = amm.vault_e6.saturating_add(net_e6.round() as i64);

    let avg_h = (net_e6 / dq_e6_f).max(0.0);
    Ok((dq_e6_f, avg_h))
}

// ---- BUY NO ----
fn lmsr_buy_no(amm: &mut Amm, spend_e6: i64) -> Result<(f64, f64)> {
    let fee = (spend_e6 as f64) * (amm.fee_bps as f64) / 10_000.0;
    let net_e6 = (spend_e6 as f64) - fee;
    require!(net_e6 > 0.0, ReaderError::BadParam);
    amm.fees = amm.fees.saturating_add(fee.round() as i64);

    let base = lmsr_cost(amm, sh(amm.q_yes), sh(amm.q_no));
    let p_no = (1.0 - lmsr_p_yes(amm)).max(1e-9);
    let mut hi = (net_e6 / 1_000_000.0 / p_no).min((amm.b as f64 / 1_000_000.0) * 5.0);
    if hi < 1.0 { hi = 1.0; }
    let mut lo = 0.0;
    for _ in 0..32 {
        let mid = 0.5*(lo+hi);
        let val = lmsr_cost(amm, sh(amm.q_yes), sh(amm.q_no)+mid) - base;
        let diff = val - (net_e6/1_000_000.0);
        if diff.abs() <= 1e-9 { lo=mid; hi=mid; break; }
        if diff < 0.0 { lo=mid; } else { hi=mid; }
    }
    let dq_h = 0.5*(lo+hi);
    let dq_e6_f = (dq_h * 1_000_000.0).max(0.0);
    let dq_i = dq_e6_f.round() as i64;

    require!(dq_i <= DQ_MAX_E6, ReaderError::BadParam);

    amm.q_no = amm.q_no.saturating_add(dq_i);
    amm.vault_e6 = amm.vault_e6.saturating_add(net_e6.round() as i64);

    let avg_h = (net_e6 / dq_e6_f).max(0.0);
    Ok((dq_e6_f, avg_h))
}

// ---- SELL YES ----
fn lmsr_sell_yes(amm: &mut Amm, shares_e6: i64) -> Result<(i64, f64, f64)> {
    let req = shares_e6.max(0);
    let sell_e6 = req.min(amm.q_yes);
    if sell_e6 <= 0 { return Ok((0, 0.0, 0.0)); }

    let pre  = lmsr_cost(amm, sh(amm.q_yes),           sh(amm.q_no));
    let post = lmsr_cost(amm, sh(amm.q_yes - sell_e6), sh(amm.q_no));
    let mut gross_h = pre - post;
    if !gross_h.is_finite() || gross_h < 0.0 { gross_h = 0.0; }

    let gross_e6_f = gross_h * 1_000_000.0;
    let fee_e6_f   = (gross_e6_f * (amm.fee_bps as f64) / 10_000.0).max(0.0);
    let net_e6_f   = (gross_e6_f - fee_e6_f).max(0.0);

    let fee_e6 = fee_e6_f.round() as i64;
    let net_e6 = net_e6_f.round() as i64;

    amm.fees  = amm.fees.saturating_add(fee_e6);
    amm.q_yes = amm.q_yes.saturating_sub(sell_e6);
    amm.vault_e6 = amm.vault_e6.saturating_sub(net_e6);

    let avg_h = if sell_e6 > 0 { net_e6_f / (sell_e6 as f64) } else { 0.0 };
    Ok((net_e6, avg_h, sell_e6 as f64))
}

// ---- SELL NO ----
fn lmsr_sell_no(amm: &mut Amm, shares_e6: i64) -> Result<(i64, f64, f64)> {
    let req = shares_e6.max(0);
    let sell_e6 = req.min(amm.q_no);
    if sell_e6 <= 0 { return Ok((0, 0.0, 0.0)); }

    let pre  = lmsr_cost(amm, sh(amm.q_yes),           sh(amm.q_no));
    let post = lmsr_cost(amm, sh(amm.q_yes),           sh(amm.q_no - sell_e6));
    let mut gross_h = pre - post;
    if !gross_h.is_finite() || gross_h < 0.0 { gross_h = 0.0; }

    let gross_e6_f = gross_h * 1_000_000.0;
    let fee_e6_f   = (gross_e6_f * (amm.fee_bps as f64) / 10_000.0).max(0.0);
    let net_e6_f   = (gross_e6_f - fee_e6_f).max(0.0);

    let fee_e6 = fee_e6_f.round() as i64;
    let net_e6 = net_e6_f.round() as i64;

    amm.fees = amm.fees.saturating_add(fee_e6);
    amm.q_no = amm.q_no.saturating_sub(sell_e6);
    amm.vault_e6 = amm.vault_e6.saturating_sub(net_e6);

    let avg_h = if sell_e6 > 0 { net_e6_f / (sell_e6 as f64) } else { 0.0 };
    Ok((net_e6, avg_h, sell_e6 as f64))
}

// ---- BUY YES FOR SHARES (inverse calculation) ----
// Given desired shares, calculate required spend
fn lmsr_buy_yes_for_shares(amm: &Amm, desired_shares_e6: i64) -> Result<i64> {
    if desired_shares_e6 <= 0 { return Ok(0); }

    let base = lmsr_cost(amm, sh(amm.q_yes), sh(amm.q_no));
    let target_cost = lmsr_cost(amm, sh(amm.q_yes + desired_shares_e6), sh(amm.q_no));
    let net_h = (target_cost - base).max(0.0);

    // Gross spend before fees
    let gross_h = net_h / (1.0 - (amm.fee_bps as f64) / 10_000.0);
    let spend_e6 = (gross_h * 1_000_000.0).round() as i64;

    Ok(spend_e6)
}

// ---- BUY NO FOR SHARES (inverse calculation) ----
// Given desired shares, calculate required spend
fn lmsr_buy_no_for_shares(amm: &Amm, desired_shares_e6: i64) -> Result<i64> {
    if desired_shares_e6 <= 0 { return Ok(0); }

    let base = lmsr_cost(amm, sh(amm.q_yes), sh(amm.q_no));
    let target_cost = lmsr_cost(amm, sh(amm.q_yes), sh(amm.q_no + desired_shares_e6));
    let net_h = (target_cost - base).max(0.0);

    // Gross spend before fees
    let gross_h = net_h / (1.0 - (amm.fee_bps as f64) / 10_000.0);
    let spend_e6 = (gross_h * 1_000_000.0).round() as i64;

    Ok(spend_e6)
}

// ============================== ORACLE helpers ==============================

const ORACLE_MAX_AGE_SECS: i64 = 90; // adjust to your feed cadence

fn median3(a: i64, b: i64, c: i64) -> i64 {
    let mut v = [a,b,c];
    v.sort();
    v[1]
}

// Bytes layout we actually have (same as your JS):
//  [8]  anchor discriminator (skip)
//  [32] update_authority pubkey
//  [48] btc:  param1, param2, param3 (i64) | ts1, ts2, ts3 (i64)
//  [48] eth:  (skip)
//  [48] sol:  (skip)
//  [1]  decimals (u8)
//  [1]  bump     (u8)

fn read_i64_le(slice: &[u8]) -> i64 {
    let mut arr = [0u8; 8];
    arr.copy_from_slice(slice);
    i64::from_le_bytes(arr)
}

fn median3_i64(a: i64, b: i64, c: i64) -> i64 {
    let mut v = [a, b, c];
    v.sort();
    v[1]
}

/// Manual parser (no Borsh). Returns (price_e6, ts_used).
fn read_btc_price_e6(oracle_ai: &AccountInfo) -> Result<(i64, i64)> {
    require_keys_eq!(*oracle_ai.owner, ORACLE_PROGRAM_ID, ReaderError::WrongOwner);

    let data = oracle_ai.try_borrow_data()?;
    require!(data.len() >= 8 + 32 + 48*3 + 2, ReaderError::DataTooSmall);

    let d = &data[8..]; // skip discriminator
    let mut o: usize = 0;

    // update_authority
    o += 32;

    // btc triplet: param1..3, ts1..3
    let p1 = read_i64_le(&d[o..o+8]); o += 8;
    let p2 = read_i64_le(&d[o..o+8]); o += 8;
    let p3 = read_i64_le(&d[o..o+8]); o += 8;
    let t1 = read_i64_le(&d[o..o+8]); o += 8;
    let t2 = read_i64_le(&d[o..o+8]); o += 8;
    let t3 = read_i64_le(&d[o..o+8]); o += 8;

    // Skip remaining triplets - decimals is at end of data
    // Works for both testnet (3 triplets, 186 bytes) and mainnet (6 triplets, 362 bytes)
    // Decimals is at data.len() - 2 (after discriminator), bump at data.len() - 1
    let decimals = data[data.len() - 2] as u32;

    // robust median
    let p_raw = median3_i64(p1, p2, p3);
    let ts    = median3_i64(t1, t2, t3);

    // Convert p_raw (10^decimals) -> 1e6 fixed
    // Use i128 to avoid overflow, then clamp to i64.
    let pow = 10i128.pow(decimals);
    let num = (p_raw as i128) * 1_000_000i128;
    let price_e6_i128 = if pow > 0 { num / pow } else { num }; // decimals should be >0, but guard anyway
    let price_e6 = price_e6_i128.clamp(i64::MIN as i128, i64::MAX as i128) as i64;

    // (Optional) debug line you can keep until confident:
    // msg!("DBG oracle: p_raw={} dec={} -> price=${:.6}", p_raw, decimals, (price_e6 as f64)/1e6);

    Ok((price_e6, ts))
}


fn assert_fresh(ts: i64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(now - ts <= ORACLE_MAX_AGE_SECS, ReaderError::StaleOracle);
    Ok(())
}

// ============================== Limit Order helpers ==============================

/// Verify Ed25519 signature for limit order using Solana's native Ed25519 sysvar
///
/// The signature must be pre-verified using the Ed25519Program instruction before calling this.
/// This function checks that the verification was done correctly.
fn verify_ed25519_signature(order: &LimitOrder, signature: &[u8; 64], instructions_sysvar: &AccountInfo) -> Result<()> {
    // Serialize order to bytes using Borsh (must match client-side encoding)
    let message = order.try_to_vec().map_err(|_| ReaderError::BadParam)?;

    // Get user's public key bytes
    let pubkey_bytes = order.user.to_bytes();

    // Load and verify the Ed25519 instruction from sysvar
    let instruction_sysvar_account_info = instructions_sysvar;
    let current_index = anchor_lang::solana_program::sysvar::instructions::load_current_index_checked(
        instruction_sysvar_account_info
    )?;

    // The Ed25519 verify instruction should be at current_index - 1
    let ed25519_ix_index = (current_index as usize).saturating_sub(1);

    let ed25519_ix = anchor_lang::solana_program::sysvar::instructions::load_instruction_at_checked(
        ed25519_ix_index,
        instruction_sysvar_account_info
    )?;

    // Verify this is an Ed25519 instruction
    // Ed25519 program ID: Ed25519SigVerify111111111111111111111111111
    const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");
    require_keys_eq!(
        ed25519_ix.program_id,
        ED25519_PROGRAM_ID,
        ReaderError::InvalidSignature
    );

    // Ed25519 instruction data format:
    // [num_signatures: u8][padding: u8][signature_offset: u16][signature_instruction_index: u16]
    // [public_key_offset: u16][public_key_instruction_index: u16][message_data_offset: u16]
    // [message_data_size: u16][message_instruction_index: u16][public_key: 32 bytes][signature: 64 bytes][message: variable]

    // For a single signature verification, we expect:
    // - num_signatures = 1
    // - The public key, signature, and message embedded in the instruction data

    require!(
        ed25519_ix.data.len() >= 114, // minimum: 14 header + 32 pubkey + 64 sig + 4 for offsets
        ReaderError::InvalidSignature
    );

    require!(
        ed25519_ix.data[0] == 1, // num_signatures must be 1
        ReaderError::InvalidSignature
    );

    // Read offsets from the instruction header
    let pubkey_offset = u16::from_le_bytes([ed25519_ix.data[6], ed25519_ix.data[7]]) as usize;
    let sig_offset = u16::from_le_bytes([ed25519_ix.data[2], ed25519_ix.data[3]]) as usize;
    let msg_offset = u16::from_le_bytes([ed25519_ix.data[10], ed25519_ix.data[11]]) as usize;
    let msg_size = u16::from_le_bytes([ed25519_ix.data[12], ed25519_ix.data[13]]) as usize;

    // Extract the public key from the instruction (using offset)
    let ix_pubkey = &ed25519_ix.data[pubkey_offset..pubkey_offset + 32];
    require!(
        ix_pubkey == pubkey_bytes,
        ReaderError::InvalidSignature
    );

    // Extract the signature from the instruction (using offset)
    let ix_signature = &ed25519_ix.data[sig_offset..sig_offset + 64];
    require!(
        ix_signature == signature,
        ReaderError::InvalidSignature
    );

    // Extract and verify the message from the instruction (using offset)
    let ix_message = &ed25519_ix.data[msg_offset..msg_offset + msg_size];
    require!(
        ix_message == message.as_slice(),
        ReaderError::InvalidSignature
    );

    msg!("✅ Ed25519 signature verified via sysvar");

    Ok(())
}

/// Calculate average price for 1 share
fn calculate_avg_price_for_one_share(action: u8, side: u8, amm: &Amm) -> Result<i64> {
    calculate_avg_price(1_000_000, action, side, amm) // 1 share = 1e6
}

/// Execute trade internally and return (net_e6, dq_e6, avg_price_e6)
/// This is a simplified version that reuses the existing trade logic
fn execute_trade_internal(
    _action: u8,
    _side: u8,
    amount_e6: i64,
    _amm_info: AccountInfo,
    _position_info: AccountInfo,
    _vault_info: AccountInfo,
    _user_info: AccountInfo,
    _system_program_info: AccountInfo,
) -> Result<(i64, i64, i64)> {
    // TODO: Extract and reuse the core trade execution logic from the `trade` instruction
    // For now, return placeholder values
    // This needs to be implemented by extracting the LMSR logic from the existing trade function

    msg!("⚠️  execute_trade_internal not fully implemented - needs LMSR logic extraction");

    // Placeholder: return dummy values
    // In production, this should execute the actual trade
    let net_e6 = amount_e6; // Simplified
    let dq_e6 = amount_e6;  // Simplified
    let avg_price_e6 = 500_000; // Simplified: $0.50

    Ok((net_e6, dq_e6, avg_price_e6))
}

// ============================== SOL helpers ==============================

/// Keep at least 1 SOL in the vault at all times.
const MIN_VAULT_LAMPORTS: u64 = 1_000_000_000; // 1 SOL

/// How many lamports we move per 1e6 "credits".
const LAMPORTS_PER_E6: u64 = 100;

#[inline]
fn e6_to_lamports(x_e6: i64) -> u64 {
    if x_e6 <= 0 { 0 } else {
        let xe = x_e6 as i128;
        (xe * (LAMPORTS_PER_E6 as i128)) as u64
    }
}

#[inline]
fn lamports_to_e6(l: u64) -> i64 {
    (l as i128 / LAMPORTS_PER_E6 as i128) as i64
}

fn transfer_sol<'info>(
    system_program: &Program<'info, System>,
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    if amount == 0 { return Ok(()); }
    let ix = system_instruction::transfer(from.key, to.key, amount);
    invoke(&ix, &[from.clone(), to.clone(), system_program.to_account_info()])?;
    Ok(())
}

fn transfer_sol_signed<'info>(
    system_program: &Program<'info, System>,
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    amount: u64,
    seeds: &[&[&[u8]]],
) -> Result<()> {
    if amount == 0 { return Ok(()); }
    let ix = system_instruction::transfer(from.key, to.key, amount);
    invoke_signed(&ix, &[from.clone(), to.clone(), system_program.to_account_info()], seeds)?;
    Ok(())
}

// ============================== Errors ==============================
#[error_code]
pub enum ReaderError {
    #[msg("oracle_state owned by wrong program")] WrongOwner,
    #[msg("oracle_state data too small")]         DataTooSmall,
    #[msg("failed to deserialize oracle state")]  DeserializeFail,
    #[msg("bad parameter")]                       BadParam,
    #[msg("market is closed")]                    MarketClosed,
    #[msg("wrong market state for this action")]  WrongState,
    #[msg("not the owner of this position")]      NotOwner,
    #[msg("insufficient shares")]                 InsufficientShares,
    #[msg("insufficient coverage")]               NoCoverage,

    // NEW
    #[msg("oracle snapshot already taken")]       AlreadySnapshotted,
    #[msg("oracle snapshot missing")]             NotSnapshotted,
    #[msg("stale oracle data")]                   StaleOracle,
    #[msg("unauthorized access")]                 Unauthorized,
    #[msg("insufficient vault balance")]          InsufficientBalance,
    #[msg("trading locked before market close")]  TradingLocked,

    // Guarded transactions
    #[msg("price exceeds limit for BUY")]         PriceLimitExceeded,
    #[msg("price below limit for SELL")]          PriceLimitNotMet,

    // Slippage protection
    #[msg("slippage tolerance exceeded")]         SlippageExceeded,

    // Advanced guards
    #[msg("quote too stale - maximum 30 seconds old")]
    StaleQuote,
    #[msg("total cost exceeds maximum allowed")]
    CostExceedsLimit,
    #[msg("minimum fill amount not met")]
    MinFillNotMet,
    #[msg("invalid guard configuration")]
    InvalidGuardConfig,

    // Limit orders
    #[msg("invalid Ed25519 signature")]
    InvalidSignature,
    #[msg("order has expired")]
    OrderExpired,
    #[msg("nonce has already been used")]
    NonceAlreadyUsed,
    #[msg("price condition not met")]
    PriceConditionNotMet,
    #[msg("wrong market for this order")]
    WrongMarket,
    #[msg("wrong user for this position")]
    WrongUser,
    #[msg("invalid action (must be 1=BUY or 2=SELL)")]
    InvalidAction,
}

