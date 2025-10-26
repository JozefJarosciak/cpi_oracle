# Vault Persistence Across Market Cycles

## Overview

The vault now **persists funds across market cycles** instead of sweeping them to the operator on restart. This creates a continuous liquidity pool and ensures fairness to users.

## How It Works

### Previous Behavior (REMOVED)

```rust
// OLD: On init_amm, sweep all vault funds to fee_dest
if vault_ai.lamports() > 0 {
    transfer(vault → fee_dest, entire_balance);
}
amm.vault_e6 = 0; // Start fresh
```

**Problems:**
- ❌ Minimum 1 SOL reserve swept to operator each cycle
- ❌ Unredeemed winnings became operator profit
- ❌ No continuity between markets
- ❌ Users penalized for not redeeming quickly

### Current Behavior (NEW)

```rust
// NEW: Keep vault funds, sync accounting
let vault_lamports = vault_ai.lamports();
amm.vault_e6 = lamports_to_e6(vault_lamports);
// Continue with existing balance
```

**Benefits:**
- ✅ Vault balance carries over to next market
- ✅ Unredeemed winnings stay in the pool
- ✅ Continuous liquidity growth
- ✅ Fair to all users
- ✅ Auto-redeem bot minimizes leftover funds

## Vault Balance Flow

### Scenario: Two Market Cycles

**Cycle 1:**
1. Init market: vault starts at 0 SOL
2. Users trade: vault grows to 100 SOL
3. Market settles: winners entitled to 95 SOL
4. Users redeem: 90 SOL paid out
5. **Remaining: 10 SOL (5 SOL reserve + 5 SOL unredeemed)**

**Cycle 2 (New Behavior):**
1. Init market: `vault_e6 = lamports_to_e6(10 SOL)`
2. Log shows: `vault_e6=10000000 (10000000000 lamports carried over)`
3. Users trade: vault grows from 10 SOL → 110 SOL
4. Continuous liquidity pool!

**Cycle 2 (Old Behavior - REMOVED):**
1. Init market: Transfer 10 SOL → fee_dest
2. `vault_e6 = 0` (fresh start)
3. Operator profits 10 SOL per cycle

## Reserves and Limits

### Minimum Reserve

```rust
const MIN_VAULT_LAMPORTS: u64 = 1_000_000_000; // 1 SOL
```

- Always keep ≥1 SOL in vault
- Prevents complete drainage
- Enforced on every `redeem()` and `admin_redeem()`

### Maximum Payout

```rust
let available_lamports = vault_lamports.saturating_sub(MIN_VAULT_LAMPORTS);
let pay_lamports = theoretical_payout.min(available_lamports);
```

Users can withdraw up to: `vault_balance - 1 SOL`

## Trading Before Snapshot

**Already Allowed!** Trading does not require a snapshot.

```rust
pub fn trade(...) -> Result<()> {
    require!(amm.status() == MarketStatus::Open, ...);
    // No snapshot check - trade anytime market is Open
}
```

**Workflow:**
1. `init_amm` → Market is Open
2. Users can trade immediately (no snapshot needed)
3. Later: `snapshot_start` captures start price
4. `stop_market` halts trading
5. `settle_by_oracle` requires snapshot to determine winner

## Auto-Redeem Integration

The settlement bot's `autoRedeemAllPositions()` minimizes leftover funds:

```javascript
// After settlement, auto-redeem all winners
await autoRedeemAllPositions(conn, kp, ammPda, vaultPda);
// Minimizes unredeemed funds carried to next cycle
```

**Result:** Most winnings auto-claimed → vault carries over mostly just the 1 SOL reserve

## Migration Notes

### Breaking Change

This is a **breaking change** in vault behavior:

| Aspect | Old | New |
|--------|-----|-----|
| Vault on restart | Swept to fee_dest | Carried over |
| vault_e6 on init | 0 | Previous balance |
| Operator profit | 1 SOL + unredeemed per cycle | Fees only |
| Continuity | None | Persistent pool |

### Deployment

Already deployed:
```bash
Program Id: EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF
Signature: 4a13XjfRiF1cvs8rCGZsjKG8WTZYPF3JSqk98ZpQS1hXqWYUqXaeDuXir5rmQg3H2dL7LjDafnYBcbm1BE7KDi27
```

### Testing

After next market cycle, check logs:
```
✅ INIT: b=500 (1e-6), fee_bps=25, status=Open,
         vault_e6=1000000 (1000000000 lamports carried over)
```

## Fund Extraction (If Needed)

If the operator needs to extract vault funds, options:

1. **Wait for market close** - Create a new instruction to sweep vault
2. **Admin withdraw** - Add `admin_withdraw_excess()` instruction
3. **Gradually via fees** - Fees still go to fee_dest each trade

**Currently:** No extraction method exists (funds locked in continuous pool)

## Security Considerations

### Positive
- ✅ Funds don't disappear to operator
- ✅ Transparent accounting (vault_e6 = actual lamports)
- ✅ Users can't lose more than they risk

### Considerations
- ⚠️ Vault grows indefinitely (no extraction)
- ⚠️ Need separate admin function if operator wants to extract
- ⚠️ Auto-redeem bot must run reliably to prevent fund accumulation

## Summary

**Old model:** Operator extracts 1 SOL + unredeemed funds every cycle
**New model:** Continuous liquidity pool, operator earns only trading fees

This aligns incentives better and is fairer to users!
