# Liquidity Provider (LP) System Design

## Executive Summary

This document proposes a bankroll investment system for CPI Oracle where users can deposit XNT to become Liquidity Providers (LPs). LPs share in the house profits when traders lose, and share in losses when traders win big. This creates a sustainable liquidity model similar to Ethcrash's bankroll system.

---

## 1. Current System Analysis

### How Profits/Losses Flow Today

```
┌─────────────────────────────────────────────────────────────┐
│                    CURRENT SYSTEM                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   Trader BUY  ──────►  Per-Market Vault (vault_sol PDA)    │
│                              │                              │
│   Market Settles             │                              │
│                              ▼                              │
│   pps_e6 = min(1.0, vault / winning_shares)                │
│                              │                              │
│                    ┌─────────┴─────────┐                   │
│                    ▼                   ▼                   │
│            pps = 1.0              pps < 1.0                │
│         (House Profit)         (House Loss)                │
│                                                             │
│   Remaining vault after       Winners don't get            │
│   all redemptions =           full payout                  │
│   PROFIT (stuck in vault)                                  │
└─────────────────────────────────────────────────────────────┘
```

### Key Metrics from lib.rs

```rust
// Settlement calculates payout per share
pps_e6 = if w_total_e6 <= 0 {
    0
} else {
    let num: i128 = (vault_e6.max(0) as i128) * 1_000_000i128;
    let den: i128 = w_total_e6 as i128;
    let floored: i64 = (num / den) as i64;
    floored.min(1_000_000)  // Cap at 1.0 (1e6)
};
```

**Profit scenario** (pps = 1.0):
- Vault has more than enough to pay winners
- Remaining = `vault_e6 - (w_total_e6 * 1.0)` = House profit

**Loss scenario** (pps < 1.0):
- Vault can't cover all winning shares
- Winners get `pps` per share instead of 1.0
- House effectively "loses" but winners bear the shortfall

---

## 2. Ethcrash Comparison

### Ethcrash Bankroll Model

| Feature | Ethcrash | Proposed CPI Oracle LP |
|---------|----------|------------------------|
| **Deposit Token** | ETH | XNT (SOL) |
| **LP Share Calculation** | deposit / total_bankroll | deposit / total_lp_pool |
| **Profit Distribution** | Pro-rata after each game | Pro-rata after each market |
| **Withdrawal** | Instant or delayed | Delayed (1 market cycle minimum) |
| **House Edge** | ~1% built into crash math | LMSR spread + fees |
| **Risk Exposure** | High variance, single game | Lower variance, market duration |
| **Max Profit Cap** | Bankroll limits max win | LP pool limits max payout |

### Ethcrash Mechanics Deep Dive

1. **Investment**: Users deposit ETH to bankroll, receive shares proportional to deposit
2. **Each Round**: House edge ~1% means on average bankroll grows
3. **Big Wins**: When players win big, bankroll decreases, LP share value drops
4. **Dilution Protection**: New deposits don't immediately dilute existing LPs
5. **Withdrawal Queue**: Prevents bank runs during losing streaks

---

## 3. Proposed LP System Architecture

### 3.1 New Accounts

```rust
/// Global LP Pool - One per program
#[account]
pub struct LpPool {
    // Authority who can update pool parameters
    pub authority: Pubkey,

    // Total XNT deposited by all LPs (in lamports)
    pub total_deposits_lamports: u64,

    // Total LP shares outstanding (1e9 scale)
    pub total_shares_e9: u64,

    // Share price at last update (lamports per share, 1e9 scale)
    // share_price = total_deposits / total_shares
    pub share_price_e9: u64,

    // Cumulative profit/loss (can be negative)
    pub cumulative_pnl_lamports: i64,

    // Number of markets settled
    pub markets_settled: u64,

    // Reserved for future parameters
    pub reserved: [u64; 8],

    // Bump seed
    pub bump: u8,
}

/// Per-user LP position
#[account]
pub struct LpPosition {
    pub owner: Pubkey,
    pub pool: Pubkey,

    // LP shares owned (1e9 scale)
    pub shares_e9: u64,

    // Timestamp of last deposit (for lockup)
    pub last_deposit_ts: i64,

    // Pending withdrawal request (0 if none)
    pub pending_withdrawal_shares: u64,
    pub withdrawal_request_ts: i64,

    // Bump seed
    pub bump: u8,
}
```

### 3.2 LP Pool PDA Seeds

```rust
// Global LP Pool
seeds = [b"lp_pool_v1"]

// LP Pool SOL Vault (system-owned, holds actual lamports)
seeds = [b"lp_vault", lp_pool.key().as_ref()]

// Per-user LP Position
seeds = [b"lp_pos", lp_pool.key().as_ref(), user.key().as_ref()]
```

### 3.3 Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                      PROPOSED LP SYSTEM                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   LP Deposits XNT ───────►  LP Pool Vault                          │
│   (receives LP shares)           │                                  │
│                                  │                                  │
│                                  ▼                                  │
│   ┌──────────────────────────────────────────────────────┐         │
│   │                    MARKET CYCLE                       │         │
│   │                                                       │         │
│   │   1. Market Init: LP Pool "backs" the market          │         │
│   │      - Per-market vault draws from LP pool if needed  │         │
│   │                                                       │         │
│   │   2. Trading: Traders buy/sell YES/NO                 │         │
│   │      - Per-market vault_e6 tracks coverage            │         │
│   │                                                       │         │
│   │   3. Settlement:                                      │         │
│   │      - If pps = 1.0: profit flows TO LP pool         │         │
│   │      - If pps < 1.0: LP pool covers shortfall        │         │
│   │                                                       │         │
│   │   4. Share Price Update:                              │         │
│   │      share_price = total_pool_value / total_shares   │         │
│   └──────────────────────────────────────────────────────┘         │
│                                  │                                  │
│                                  ▼                                  │
│   LP Withdraws ◄───────  Share Value Changed                       │
│   (gets shares × current_price)                                    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 4. Smart Contract Instructions

### 4.1 LP Pool Management

```rust
/// Initialize the global LP pool (admin only, one-time)
pub fn init_lp_pool(ctx: Context<InitLpPool>) -> Result<()>

/// Deposit XNT to LP pool, receive shares
/// shares_received = deposit_amount / current_share_price
pub fn lp_deposit(ctx: Context<LpDeposit>, amount_lamports: u64) -> Result<()>

/// Request withdrawal (starts lockup timer)
pub fn lp_request_withdrawal(ctx: Context<LpWithdraw>, shares_e9: u64) -> Result<()>

/// Execute withdrawal after lockup period
/// payout = shares × current_share_price
pub fn lp_execute_withdrawal(ctx: Context<LpWithdraw>) -> Result<()>

/// Cancel pending withdrawal request
pub fn lp_cancel_withdrawal(ctx: Context<LpWithdraw>) -> Result<()>
```

### 4.2 Market-LP Integration

```rust
/// Modified init_amm: optionally draw initial liquidity from LP pool
pub fn init_amm_with_lp(
    ctx: Context<InitAmmWithLp>,
    b: i64,
    fee_bps: u16,
    lp_backing_lamports: u64  // Amount to draw from LP pool
) -> Result<()>

/// Modified settle: return profit/loss to LP pool
pub fn settle_market_with_lp(ctx: Context<SettleWithLp>, winner: u8) -> Result<()>
```

### 4.3 Share Price Calculation

```rust
// On deposit
let current_price_e9 = if pool.total_shares_e9 == 0 {
    1_000_000_000  // Initial price = 1.0 (1e9)
} else {
    (pool.total_deposits_lamports as u128 * 1_000_000_000u128
        / pool.total_shares_e9 as u128) as u64
};

let shares_received = (amount_lamports as u128 * 1_000_000_000u128
    / current_price_e9 as u128) as u64;

// On withdrawal
let payout = (shares_e9 as u128 * current_price_e9 as u128
    / 1_000_000_000u128) as u64;
```

---

## 5. Profit/Loss Distribution

### 5.1 After Market Settlement

```rust
pub fn settle_market_with_lp(ctx: Context<SettleWithLp>, winner: u8) -> Result<()> {
    let amm = &mut ctx.accounts.amm;
    let lp_pool = &mut ctx.accounts.lp_pool;

    // Calculate standard pps
    let w = if winner == 1 { amm.q_yes } else { amm.q_no };
    let w_total_e6 = w.max(0);

    // Full payout required
    let required_payout_lamports = (w_total_e6 as u128 * LAMPORTS_PER_E6 as u128
        / 1_000_000u128) as u64;

    let vault_lamports = ctx.accounts.vault_sol.lamports();

    if vault_lamports >= required_payout_lamports {
        // PROFIT SCENARIO
        let profit = vault_lamports - required_payout_lamports;

        // Transfer profit to LP pool
        transfer_to_lp_pool(profit);

        // pps = 1.0, winners get full payout
        amm.pps_e6 = 1_000_000;

        // Update LP pool accounting
        lp_pool.total_deposits_lamports += profit;
        lp_pool.cumulative_pnl_lamports += profit as i64;

    } else {
        // LOSS SCENARIO - LP pool covers shortfall
        let shortfall = required_payout_lamports - vault_lamports;

        // Check LP pool has enough
        require!(
            lp_pool.total_deposits_lamports >= shortfall,
            LpError::InsufficientLiquidity
        );

        // Transfer from LP pool to market vault
        transfer_from_lp_pool(shortfall);

        // pps = 1.0, winners get full payout (LP absorbed loss)
        amm.pps_e6 = 1_000_000;

        // Update LP pool accounting
        lp_pool.total_deposits_lamports -= shortfall;
        lp_pool.cumulative_pnl_lamports -= shortfall as i64;
    }

    lp_pool.markets_settled += 1;

    emit!(LpSettlementEvent {
        market: amm.key(),
        winner,
        vault_before: vault_lamports,
        required_payout: required_payout_lamports,
        lp_pnl: lp_pool.cumulative_pnl_lamports,
        share_price: calculate_share_price(lp_pool),
    });

    Ok(())
}
```

### 5.2 LP Returns Over Time

```
LP Return = (Final Share Price / Entry Share Price) - 1

Example:
- LP deposits 10 XNT when share_price = 1.0
- Receives 10 shares
- After 100 markets:
  - 60 markets: House profit (avg 5% of volume)
  - 40 markets: House loss (avg 3% of volume)
  - Net: Positive if house edge > loss rate
- Share price now = 1.15
- LP can withdraw 11.5 XNT (15% return)
```

---

## 6. Risk Management

### 6.1 LP Pool Limits

```rust
// Constants
pub const MIN_LP_DEPOSIT: u64 = 1_000_000_000;       // 1 XNT minimum
pub const MAX_LP_POOL_SIZE: u64 = 100_000_000_000_000; // 100k XNT max
pub const WITHDRAWAL_LOCKUP_SECS: i64 = 86400;        // 24 hours
pub const MIN_LP_RESERVE_RATIO: u64 = 20;             // 20% always kept liquid
```

### 6.2 Market Exposure Limits

```rust
// Max any single market can draw from LP pool
pub const MAX_MARKET_LP_BACKING: u64 = pool.total_deposits * 10 / 100; // 10%

// Max total exposure across all active markets
pub const MAX_TOTAL_EXPOSURE: u64 = pool.total_deposits * 50 / 100; // 50%
```

### 6.3 Circuit Breakers

```rust
// If LP pool drops below threshold, halt new markets
if lp_pool.total_deposits_lamports < MIN_POOL_THRESHOLD {
    return Err(LpError::PoolBelowMinimum);
}

// If single market loss exceeds limit, cap LP contribution
let max_lp_loss = lp_pool.total_deposits_lamports * MAX_SINGLE_LOSS_PERCENT / 100;
```

---

## 7. Database Schema (Off-chain Tracking)

### 7.1 New Tables

```sql
-- LP deposit/withdrawal history
CREATE TABLE lp_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_signature TEXT UNIQUE NOT NULL,
    user_pubkey TEXT NOT NULL,
    action TEXT NOT NULL,  -- 'deposit', 'withdrawal_request', 'withdrawal_execute'
    amount_lamports INTEGER NOT NULL,
    shares_e9 INTEGER NOT NULL,
    share_price_e9 INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- LP share price history (for charts)
CREATE TABLE lp_share_price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    share_price_e9 INTEGER NOT NULL,
    total_deposits_lamports INTEGER NOT NULL,
    total_shares_e9 INTEGER NOT NULL,
    cumulative_pnl_lamports INTEGER NOT NULL,
    market_pubkey TEXT,  -- Which market caused this update
    timestamp INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Per-user LP stats
CREATE TABLE lp_user_stats (
    user_pubkey TEXT PRIMARY KEY,
    total_deposited_lamports INTEGER DEFAULT 0,
    total_withdrawn_lamports INTEGER DEFAULT 0,
    current_shares_e9 INTEGER DEFAULT 0,
    realized_pnl_lamports INTEGER DEFAULT 0,
    first_deposit_ts INTEGER,
    last_activity_ts INTEGER
);

CREATE INDEX idx_lp_tx_user ON lp_transactions(user_pubkey);
CREATE INDEX idx_lp_tx_ts ON lp_transactions(timestamp);
CREATE INDEX idx_lp_price_ts ON lp_share_price_history(timestamp);
```

---

## 8. Web Interface Additions

### 8.1 LP Dashboard Components

```
┌─────────────────────────────────────────────────────────────┐
│  LP POOL STATUS                                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Total Pool:        1,234.56 XNT                           │
│  Your Shares:       12.34 (1.0% of pool)                   │
│  Share Price:       1.0523 XNT                             │
│  Your Value:        12.98 XNT (+5.23%)                     │
│                                                             │
│  [DEPOSIT]  [WITHDRAW]                                      │
│                                                             │
│  ── Share Price History (7d) ─────────────────────────     │
│  1.06 |      ╱╲                                             │
│  1.04 |    ╱    ╲    ╱                                      │
│  1.02 |  ╱        ╲╱                                        │
│  1.00 |╱                                                    │
│       └────────────────────────────────────────────         │
│                                                             │
│  ── Recent LP Activity ────────────────────────────────    │
│  Market #42: +0.5 XNT profit  (share price +0.04%)         │
│  Market #41: -0.2 XNT loss    (share price -0.02%)         │
│  Market #40: +0.8 XNT profit  (share price +0.06%)         │
└─────────────────────────────────────────────────────────────┘
```

### 8.2 API Endpoints

```javascript
// GET /api/lp/pool - Pool status
{
  "total_deposits_lamports": "1234560000000",
  "total_shares_e9": "1172000000000",
  "share_price_e9": "1053200000",
  "cumulative_pnl_lamports": "62400000000",
  "markets_settled": 42,
  "apy_estimate": "12.5%"
}

// GET /api/lp/position/:pubkey - User's LP position
{
  "shares_e9": "12340000000",
  "value_lamports": "12996488000",
  "share_of_pool_percent": "1.0",
  "unrealized_pnl_lamports": "656488000",
  "pending_withdrawal": null
}

// GET /api/lp/history - Share price history
{
  "prices": [
    { "timestamp": 1700000000, "price_e9": "1000000000" },
    { "timestamp": 1700086400, "price_e9": "1012000000" },
    ...
  ]
}
```

---

## 9. Implementation Phases

### Phase 1: Core LP Pool (Week 1-2)
- [ ] Add `LpPool` and `LpPosition` account structs
- [ ] Implement `init_lp_pool`, `lp_deposit`, withdrawal instructions
- [ ] Add LP vault PDA
- [ ] Basic share price calculation
- [ ] Unit tests

### Phase 2: Market Integration (Week 2-3)
- [ ] Modify `settle_market` to interact with LP pool
- [ ] Profit/loss flow to/from LP pool
- [ ] Add exposure limits
- [ ] Integration tests with market cycles

### Phase 3: Database & API (Week 3-4)
- [ ] Create new database tables
- [ ] Update trade monitor to track LP events
- [ ] Add LP API endpoints
- [ ] Historical data collection

### Phase 4: Web UI (Week 4-5)
- [ ] LP dashboard component
- [ ] Deposit/withdraw modals
- [ ] Share price chart
- [ ] Activity feed

### Phase 5: Testing & Launch (Week 5-6)
- [ ] Testnet deployment
- [ ] Stress testing (many LPs, many markets)
- [ ] Security audit of LP smart contract
- [ ] Mainnet launch with caps

---

## 10. Economics & Projections

### Expected House Edge

Based on LMSR dynamics and fee structure:

| Source | Expected Edge |
|--------|--------------|
| LMSR Spread | ~1-3% of volume |
| Trading Fees (25 bps) | 0.25% of volume |
| Total | ~1.5-3.5% per market |

### LP Returns Projection

Assuming:
- Average market volume: 100 XNT
- House edge: 2%
- Markets per week: 20

```
Weekly LP Pool Return = 20 markets × 100 XNT × 2% = 40 XNT
If pool size = 1000 XNT
Weekly return = 4%
APY ≈ 200%+ (with compounding)

Note: High variance! Individual markets can swing ±10%
```

### Risk Disclosure

LPs should understand:
1. Share value can decrease if traders win big
2. No guaranteed returns
3. Lockup period prevents instant exit
4. Smart contract risk

---

## 11. Comparison Summary: Ethcrash vs CPI Oracle LP

| Aspect | Ethcrash | CPI Oracle LP |
|--------|----------|---------------|
| **Game Type** | Crash (single round) | Prediction market (duration) |
| **House Edge** | ~1% mathematical | LMSR spread + fees |
| **Variance** | Very high (single bets) | Lower (market aggregation) |
| **Settlement** | Instant | End of market period |
| **Withdrawal** | Delayed queue | 24h lockup |
| **Max Bet** | % of bankroll | Exposure limits |
| **Share Pricing** | Real-time | Per-settlement |
| **Complexity** | Simple | More complex (LMSR) |

**Key Advantage of CPI Oracle LP:**
- Lower variance due to market aggregation
- LMSR ensures always-valid prices
- Longer time horizons allow for rebalancing

**Key Disadvantage:**
- More complex to understand
- Longer lockup required
- Dependent on oracle accuracy

---

## Appendix A: Ethcrash Reference

Ethcrash bankroll mechanics (for reference):
- Players can invest ETH into the bankroll
- Investment = % share of total bankroll
- Each round, bankroll wins or loses based on crash point
- Share value changes proportionally
- Withdrawals may be queued during losing streaks
- House edge ensures long-term positive EV for investors

Source: Historical Ethcrash documentation and community analysis.

---

## Appendix B: Migration Path

For existing markets without LP backing:
1. Deploy LP pool contract alongside existing AMM
2. New markets can opt-in to LP backing
3. Old markets settle normally (no LP interaction)
4. Gradual migration as LPs deposit

No breaking changes to existing Amm struct required.
