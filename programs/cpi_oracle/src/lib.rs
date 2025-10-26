use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    program::{invoke, invoke_signed},
    system_instruction,
};
use anchor_lang::system_program::{self, System};

declare_id!("EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF");

// =========================
// Oracle (foreign) settings
// =========================
pub const ORACLE_PROGRAM_ID: Pubkey =
    pubkey!("7ARBeYF5rGCanAGiRaxhVpiuZZpGXazo5UJqHMoJgkuE");

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
// Market (single) with LMSR + coverage + settlement
// ===========================

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq)]
pub enum MarketStatus { Open = 0, Stopped = 1, Settled = 2 }

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
}
impl Amm {
    pub const SEED: &'static [u8] = b"amm_btc_v3";
    pub const VAULT_SOL_SEED: &'static [u8] = b"vault_sol";
    pub const SPACE: usize = core::mem::size_of::<Amm>();

    #[inline] pub fn status(&self) -> MarketStatus {
        match self.status { 0 => MarketStatus::Open, 1 => MarketStatus::Stopped, _ => MarketStatus::Settled }
    }
}

// Per-user position (PDA is per-market: [b"pos", amm, user])
#[account]
pub struct Position {
    pub owner: Pubkey,
    pub yes_shares_e6: i64,
    pub no_shares_e6: i64,
}
impl Position {
    pub const SEED: &'static [u8] = b"pos";
    pub const SPACE: usize = 32 + 8 + 8;
}

// ---- Limits (all scaled 1e6) ----
const MIN_BUY_E6: i64   = 100_000;         // $0.10 min
const MIN_SELL_E6: i64  = 100_000;         // 0.100000 share min
const SPEND_MAX_E6: i64 = 50_000_000_000;  // $50,000 per trade
const DQ_MAX_E6: i64    = 50_000_000_000;  // 50,000,000 shares per trade

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
        payer = user,
        space = 8 + Position::SPACE,
        seeds = [Position::SEED, amm.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub pos: Account<'info, Position>,

    #[account(mut)]
    pub user: Signer<'info>,
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

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, seeds = [Amm::SEED], bump = amm.bump)]
    pub amm: Account<'info, Amm>,
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

    pub system_program: Program<'info, System>,
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
        amm.vault_e6 = 0;
        amm.status = MarketStatus::Open as u8;
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

        // If vault already has lamports from a prior run, sweep to fee_dest; otherwise leave it.
        let vault_ai = ctx.accounts.vault_sol.to_account_info();
        let fee_dest_ai = ctx.accounts.fee_dest.to_account_info();
        if vault_ai.lamports() > 0 {
            let bal = vault_ai.lamports();
            let amm_key = amm.key();
            let seeds: &[&[u8]] = &[
                Amm::VAULT_SOL_SEED,
                amm_key.as_ref(),
                core::slice::from_ref(&amm.vault_sol_bump),
            ];
            let ix = system_instruction::transfer(&vault_ai.key(), &fee_dest_ai.key(), bal);
            invoke_signed(
                &ix,
                &[
                    vault_ai.clone(),
                    fee_dest_ai.clone(),
                    ctx.accounts.system_program.to_account_info(),
                ],
                &[seeds],
            )?;
        }

        msg!("✅ INIT: b={} (1e-6), fee_bps={}, status=Open, fee_dest={}, vault_sol ready",
             b, fee_bps, amm.fee_dest);
        Ok(())
    }

    // ---------- INIT position (per user & market) ----------
    pub fn init_position(ctx: Context<InitPosition>) -> Result<()> {
        let pos = &mut ctx.accounts.pos;
        pos.owner = ctx.accounts.user.key();
        pos.yes_shares_e6 = 0;
        pos.no_shares_e6 = 0;
        msg!("✅ Position initialized for {}", pos.owner);
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
        require!(amm.status() == MarketStatus::Open, ReaderError::MarketClosed);

        match (side, action) {
            (1, 1) => { // BUY YES
                require!(amount >= MIN_BUY_E6 && amount <= SPEND_MAX_E6, ReaderError::BadParam);
                let (dq_e6, avg_h) = lmsr_buy_yes(amm, amount)?;
                pos.yes_shares_e6 = pos.yes_shares_e6.saturating_add(dq_e6.round() as i64);

                // Collect lamports from user: fee + net
                let fee_e6 = ((amount as i128) * (amm.fee_bps as i128) / 10_000) as i64;
                let net_e6 = amount.saturating_sub(fee_e6);

                transfer_sol(sys, &ctx.accounts.user.to_account_info(), &ctx.accounts.vault_sol.to_account_info(), e6_to_lamports(net_e6))?;
                transfer_sol(sys, &ctx.accounts.user.to_account_info(), &ctx.accounts.fee_dest.to_account_info(), e6_to_lamports(fee_e6))?;

                emit_trade(amm, 1, 1, amount, dq_e6.round() as i64, avg_h);
                log_trade_buy("BUY YES", amount, dq_e6, avg_h, lmsr_p_yes(amm), amm);
            }
            (2, 1) => { // BUY NO
                require!(amount >= MIN_BUY_E6 && amount <= SPEND_MAX_E6, ReaderError::BadParam);
                let (dq_e6, avg_h) = lmsr_buy_no(amm, amount)?;
                pos.no_shares_e6 = pos.no_shares_e6.saturating_add(dq_e6.round() as i64);

                let fee_e6 = ((amount as i128) * (amm.fee_bps as i128) / 10_000) as i64;
                let net_e6 = amount.saturating_sub(fee_e6);

                transfer_sol(sys, &ctx.accounts.user.to_account_info(), &ctx.accounts.vault_sol.to_account_info(), e6_to_lamports(net_e6))?;
                transfer_sol(sys, &ctx.accounts.user.to_account_info(), &ctx.accounts.fee_dest.to_account_info(), e6_to_lamports(fee_e6))?;

                emit_trade(amm, 2, 1, amount, dq_e6.round() as i64, avg_h);
                log_trade_buy("BUY NO ", amount, dq_e6, avg_h, lmsr_p_yes(amm), amm);
            }
            (1, 2) => { // SELL YES → pay user from vault_sol
                require!(amount >= MIN_SELL_E6 && amount <= DQ_MAX_E6, ReaderError::BadParam);
                let sell_e6 = amount.min(pos.yes_shares_e6);
                require!(sell_e6 > 0, ReaderError::InsufficientShares);

                let (proceeds_e6, avg_h, sold_e6) = lmsr_sell_yes(amm, sell_e6)?;
                require!(amm.vault_e6 >= proceeds_e6, ReaderError::NoCoverage);

                let amm_key = amm.key();
                let seeds: &[&[u8]] = &[
                    Amm::VAULT_SOL_SEED,
                    amm_key.as_ref(),
                    core::slice::from_ref(&amm.vault_sol_bump),
                ];
                transfer_sol_signed(sys, &ctx.accounts.vault_sol.to_account_info(), &ctx.accounts.user.to_account_info(), e6_to_lamports(proceeds_e6), &[seeds])?;

                pos.yes_shares_e6 = pos.yes_shares_e6.saturating_sub(sold_e6.round() as i64);
                emit_trade(amm, 1, 2, proceeds_e6, sold_e6.round() as i64, avg_h);
                log_trade_sell("SELL YES", sold_e6, proceeds_e6, avg_h, lmsr_p_yes(amm), amm);
            }
            (2, 2) => { // SELL NO → pay user from vault_sol
                require!(amount >= MIN_SELL_E6 && amount <= DQ_MAX_E6, ReaderError::BadParam);
                let sell_e6 = amount.min(pos.no_shares_e6);
                require!(sell_e6 > 0, ReaderError::InsufficientShares);

                let (proceeds_e6, avg_h, sold_e6) = lmsr_sell_no(amm, sell_e6)?;
                require!(amm.vault_e6 >= proceeds_e6, ReaderError::NoCoverage);

                let amm_key = amm.key();
                let seeds: &[&[u8]] = &[
                    Amm::VAULT_SOL_SEED,
                    amm_key.as_ref(),
                    core::slice::from_ref(&amm.vault_sol_bump),
                ];
                transfer_sol_signed(sys, &ctx.accounts.vault_sol.to_account_info(), &ctx.accounts.user.to_account_info(), e6_to_lamports(proceeds_e6), &[seeds])?;

                pos.no_shares_e6 = pos.no_shares_e6.saturating_sub(sold_e6.round() as i64);
                emit_trade(amm, 2, 2, proceeds_e6, sold_e6.round() as i64, avg_h);
                log_trade_sell("SELL NO ", sold_e6, proceeds_e6, avg_h, lmsr_p_yes(amm), amm);
            }
            _ => return err!(ReaderError::BadParam),
        }
        Ok(())
    }

    // ---------- STOP ----------
    pub fn stop_market(ctx: Context<AdminOnly>) -> Result<()> {
        let amm = &mut ctx.accounts.amm;
        require!(amm.status() == MarketStatus::Open, ReaderError::WrongState);
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



    // ---------- SETTLE (manual winner: 1=YES, 2=NO) ----------
    pub fn settle_market(ctx: Context<AdminOnly>, winner: u8) -> Result<()> {
        let amm = &mut ctx.accounts.amm;
        require!(amm.status() == MarketStatus::Stopped, ReaderError::WrongState);
        require!(winner == 1 || winner == 2, ReaderError::BadParam);
        amm.winner = winner;

        // Snapshot W (total winning shares at stop)
        let w = if winner == 1 { amm.q_yes } else { amm.q_no };
        amm.w_total_e6 = w.max(0);

        // pps = min(1e6, floor(vault / W)) with exact integers
        let pps_e6 = if amm.w_total_e6 <= 0 {
            0
        } else {
            let num: i128 = (amm.vault_e6.max(0) as i128) * 1_000_000i128;
            let den: i128 = amm.w_total_e6 as i128;
            let floored: i64 = (num / den) as i64;
            floored.min(1_000_000)
        };
        amm.pps_e6 = pps_e6;
        amm.status = MarketStatus::Settled as u8;

        msg!("✅ SETTLED winner={}  W={}  vault=${:.6}  pps={:.6}",
             winner, amm.w_total_e6, usd(amm.vault_e6), (pps_e6 as f64)/1_000_000.0);
        Ok(())
    }

/// If true, we wipe (set to zero) the user's Position even when coverage/reserve makes pay=0.
/// If false, we keep the Position intact when pay=0 so the user can try again later.
const WIPE_ON_PAY_ZERO: bool = true;

pub fn redeem(ctx: Context<Redeem>) -> Result<()> {
    let sys  = &ctx.accounts.system_program;

    // Must be settled
    require!(ctx.accounts.amm.status() == MarketStatus::Settled, ReaderError::WrongState);

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

    // Pay user from vault (PDA signed)
    let amm_key = ctx.accounts.amm.key();
    let seeds: &[&[u8]] = &[
        Amm::VAULT_SOL_SEED,
        amm_key.as_ref(),
        core::slice::from_ref(&ctx.accounts.amm.vault_sol_bump),
    ];
    transfer_sol_signed(
        sys,
        &ctx.accounts.vault_sol.to_account_info(),
        &ctx.accounts.user.to_account_info(),
        pay_lamports,
        &[seeds],
    )?;

    // ---- mutate mirrors and WIPE position
    let amm_mut = &mut ctx.accounts.amm;
    amm_mut.vault_e6 = amm_mut.vault_e6.saturating_sub(pay_e6_effective);

    let pos_mut = &mut ctx.accounts.pos;
    pos_mut.yes_shares_e6 = 0;
    pos_mut.no_shares_e6  = 0;

    let kept = vault_ai.lamports(); // after transfer
    msg!(
        "💸 REDEEM pay={} lamports ({:.9} SOL); kept_reserve={} lamports; pps={:.6}, winner={}",
        pay_lamports,
        (pay_lamports as f64)/1e9,
        kept.min(MIN_VAULT_LAMPORTS),
        (amm_mut.pps_e6 as f64)/1_000_000.0,
        amm_mut.winner
    );
    Ok(())
}

    // ---------- ADMIN REDEEM (force redeem on behalf of user) ----------
    pub fn admin_redeem(ctx: Context<AdminRedeem>) -> Result<()> {
        let sys = &ctx.accounts.system_program;

        // Only fee_dest can call this
        require_keys_eq!(ctx.accounts.admin.key(), ctx.accounts.amm.fee_dest, ReaderError::NotOwner);

        // Must be settled
        require!(ctx.accounts.amm.status() == MarketStatus::Settled, ReaderError::WrongState);

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

        // Pay user from vault (PDA signed) - NOTE: funds go to USER, not admin
        let amm_key = ctx.accounts.amm.key();
        let seeds: &[&[u8]] = &[
            Amm::VAULT_SOL_SEED,
            amm_key.as_ref(),
            core::slice::from_ref(&ctx.accounts.amm.vault_sol_bump),
        ];
        transfer_sol_signed(
            sys,
            &ctx.accounts.vault_sol.to_account_info(),
            &ctx.accounts.user.to_account_info(),
            pay_lamports,
            &[seeds],
        )?;

        // ---- mutate mirrors and WIPE position
        let amm_mut = &mut ctx.accounts.amm;
        amm_mut.vault_e6 = amm_mut.vault_e6.saturating_sub(pay_e6_effective);

        let pos_mut = &mut ctx.accounts.pos;
        pos_mut.yes_shares_e6 = 0;
        pos_mut.no_shares_e6  = 0;

        let kept = vault_ai.lamports();
        msg!(
            "💸 ADMIN_REDEEM user={} pay={} lamports ({:.9} SOL); kept_reserve={} lamports",
            ctx.accounts.user.key(),
            pay_lamports,
            (pay_lamports as f64)/1e9,
            kept.min(MIN_VAULT_LAMPORTS)
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
        require!(amm.status() == MarketStatus::Open, ReaderError::WrongState);
        require!(amm.start_price_e6 == 0, ReaderError::AlreadySnapshotted);

        let (price_e6, ts) = read_btc_price_e6(&ctx.accounts.oracle_state)?;
        assert_fresh(ts)?;

        amm.start_price_e6 = price_e6;
        amm.start_ts = ts;

        msg!("📸 SNAPSHOT start BTC=${:.6} (ts={})", (price_e6 as f64)/1e6, ts);
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
            let num: i128 = (amm.vault_e6.max(0) as i128) * 1_000_000i128;
            let den: i128 = amm.w_total_e6 as i128;
            let floored: i64 = (num / den) as i64;
            floored.min(1_000_000)
        };
        amm.pps_e6 = pps_e6;
        amm.status = MarketStatus::Settled as u8;

        msg!(
          "✅ SETTLED_BY_ORACLE winner={} start=${:.6}@{} curr=${:.6}@{}  W={}  vault=${:.6}  pps={:.6}",
          winner,
          (start as f64)/1e6, amm.start_ts,
          (curr_e6 as f64)/1e6, ts,
          amm.w_total_e6,
          (amm.vault_e6 as f64)/1e6,
          (pps_e6 as f64)/1e6
        );
        Ok(())
    }
}

// ============================== Helpers & LMSR math ==============================

#[inline] fn sh(x: i64) -> f64 { (x as f64) / 1_000_000.0 }
#[inline] fn usd(x: i64) -> f64 { (x as f64) / 1_000_000.0 }

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
    msg!("{tag}: spend=${:.6} -> shares={:.6} @avg={:.6}  pYes={:.6}",
         usd(spend_e6), shares_e6/1_000_000.0, avg_h, p);
    msg!("          qY={:.6}sh qN={:.6}sh vault=${:.6} fees=${:.6}",
         sh(amm.q_yes), sh(amm.q_no), usd(amm.vault_e6), usd(amm.fees));
}
fn log_trade_sell(tag: &str, sold_e6: f64, proceeds_e6: i64, avg_h: f64, p: f64, amm: &Amm) {
    msg!("{tag}: shares={:.6} -> proceeds=${:.6} @avg={:.6}  pYes={:.6}",
         sold_e6/1_000_000.0, usd(proceeds_e6), avg_h, p);
    msg!("          qY={:.6}sh qN={:.6}sh vault=${:.6} fees=${:.6}",
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

    let avg_h = if sell_e6 > 0 { (net_e6_f / (sell_e6 as f64)) / 1_000_000.0 } else { 0.0 };
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

    let avg_h = if sell_e6 > 0 { (net_e6_f / (sell_e6 as f64)) / 1_000_000.0 } else { 0.0 };
    Ok((net_e6, avg_h, sell_e6 as f64))
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

    // skip eth + sol (48 + 48)
    o += 96;

    // decimals (u8) + bump (u8)
    let decimals = d[o] as u32; o += 1;
    /* bump */ o += 1;

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
}

