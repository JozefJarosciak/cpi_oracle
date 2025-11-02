# Advanced Guards Implementation Summary

## Status: IMPLEMENTED (Slippage Protection)
## Next Phase: Comprehensive Guards

---

## What We Have Now

### ✅ Implemented
1. **GuardConfig** - Absolute price limits
   - `price_limit_e6`: Max price for BUY, min price for SELL
   - Used in `trade_guarded` instruction

2. **SlippageConfig** - Percentage-based slippage
   - `max_slippage_bps`: Tolerance in basis points
   - Used in `trade_with_slippage` instruction

3. **Error Codes**
   - `PriceLimitExceeded`
   - `PriceLimitNotMet`
   - `SlippageExceeded`

4. **Test Scripts**
   - `app/test-guarded.js` - Absolute limit tests
   - `app/test-slippage.js` - Slippage tests
   - `app/test-slippage-onchain.js` - On-chain rejection proof

5. **Deployed to X1 Testnet**
   - Program ID: `EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF`
   - All features working and tested

---

## What Needs to Be Added

### Phase 2: Comprehensive Guards System

#### 1. Unified AdvancedGuardConfig Struct
```rust
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct AdvancedGuardConfig {
    // Absolute price limits
    pub price_limit_e6: i64,           // 0 = no limit

    // Slippage protection with quote
    pub max_slippage_bps: u16,         // 0 = no slippage check
    pub quote_price_e6: i64,           // Reference price for slippage
    pub quote_timestamp: i64,          // When quote was generated

    // Max cost enforcement
    pub max_total_cost_e6: i64,        // 0 = no max cost

    // Partial fill support
    pub allow_partial: bool,            // Allow partial execution?
    pub min_fill_shares_e6: i64,       // Minimum shares to execute (if partial)
}
```

#### 2. Additional Error Codes
```rust
#[msg("quote too stale - maximum 30 seconds old")]
StaleQuote,

#[msg("total cost exceeds maximum allowed")]
CostExceedsLimit,

#[msg("minimum fill amount not met")]
MinFillNotMet,

#[msg("invalid guard configuration")]
InvalidGuardConfig,
```

#### 3. Guard Validation Function
```rust
fn validate_advanced_guards(
    action: u8,
    side: u8,
    amount_e6: i64,
    guards: &AdvancedGuardConfig,
    amm: &Amm,
) -> Result<i64> {
    // Returns the number of shares to execute (may be less than amount if partial)

    // 1. Validate quote staleness (if using slippage)
    // 2. Calculate execution price and cost
    // 3. Check absolute price limit
    // 4. Check slippage against quote
    // 5. Check max total cost
    // 6. If partial fills enabled, binary search for max executable
    // 7. Check min fill requirement
}
```

#### 4. Binary Search for Partial Fills
```rust
fn find_max_executable_shares(
    action: u8,
    side: u8,
    max_shares_e6: i64,
    guards: &AdvancedGuardConfig,
    amm: &Amm,
) -> Result<i64> {
    // Binary search to find largest trade that passes all guards
    let mut left = guards.min_fill_shares_e6.max(MIN_SELL_E6);
    let mut right = max_shares_e6;
    let mut best = 0;

    while left <= right {
        let mid = (left + right) / 2;
        if shares_pass_guards(mid, action, side, guards, amm)? {
            best = mid;
            left = mid + 1;  // Try larger
        } else {
            right = mid - 1; // Try smaller
        }
    }

    Ok(best)
}
```

#### 5. New Instruction: trade_advanced
```rust
pub fn trade_advanced(
    ctx: Context<Trade>,
    side: u8,
    action: u8,
    amount_e6: i64,
    guards: AdvancedGuardConfig,
) -> Result<()> {
    // Validate guards
    let shares_to_execute = validate_advanced_guards(
        action, side, amount_e6, &guards, &ctx.accounts.amm
    )?;

    // Execute trade
    execute_trade_internal(ctx, side, action, shares_to_execute)?;

    // Emit event with guard info
    emit!(TradeExecuted {
        shares_requested: amount_e6,
        shares_executed: shares_to_execute,
        fully_executed: shares_to_execute == amount_e6,
    });

    Ok(())
}
```

---

## Implementation Steps

### Step 1: Add AdvancedGuardConfig
- Keep existing GuardConfig and SlippageConfig for backward compatibility
- Add new AdvancedGuardConfig struct
- Add helper methods

### Step 2: Add Missing Error Codes
- `StaleQuote`
- `CostExceedsLimit`
- `MinFillNotMet`
- `InvalidGuardConfig`

### Step 3: Implement Validation Logic
- `validate_advanced_guards()` function
- `shares_pass_guards()` helper
- `find_max_executable_shares()` for partial fills

### Step 4: Add trade_advanced Instruction
- Use AdvancedGuardConfig parameter
- Call validation logic
- Execute trade
- Emit detailed events

### Step 5: Create Comprehensive Tests
```javascript
// app/test-advanced-guards.js
- Test 1: All-or-nothing with max cost
- Test 2: Partial fills with min fill
- Test 3: Quote staleness check
- Test 4: Combined guards (price + slippage + cost)
- Test 5: Binary search edge cases
- Test 6: Large trade partial execution
```

### Step 6: Deploy and Test
- Deploy to testnet
- Run all test cases
- Verify on-chain behavior
- Document results

---

## Test Matrix

| Test Case | Guards Used | Expected Result |
|-----------|-------------|-----------------|
| Market order | None | Full execution |
| Absolute limit (favorable) | price_limit | Full execution |
| Absolute limit (unfavorable) | price_limit | Rejection |
| Slippage 2% (within) | max_slippage + quote | Full execution |
| Slippage 2% (exceeded) | max_slippage + quote | Rejection |
| Stale quote | max_slippage + old quote | Rejection (StaleQuote) |
| Max cost (under) | max_total_cost | Full execution |
| Max cost (over, all-or-nothing) | max_total_cost, !allow_partial | Rejection |
| Max cost (over, partial) | max_total_cost, allow_partial | Partial execution |
| Partial + min fill (met) | allow_partial, min_fill | Partial execution |
| Partial + min fill (not met) | allow_partial, min_fill | Rejection |
| Combined guards | All | Complex behavior |

---

## Backward Compatibility

### Existing Instructions Unchanged
- `trade()` - Regular market orders
- `trade_guarded()` - Absolute price limits only
- `trade_with_slippage()` - Slippage protection only

### New Instruction
- `trade_advanced()` - All guard features combined

### Migration Path
1. Deploy new version with `trade_advanced`
2. Test thoroughly on testnet
3. Frontend can gradually adopt advanced features
4. Old instructions remain functional

---

## Performance Considerations

### Compute Units
- Basic guards: ~5k CU overhead
- Partial fills (binary search): ~15k CU overhead
- Combined guards: ~20k CU overhead

### Optimization Strategies
1. Early rejection on cheap checks (quote staleness)
2. Limit binary search iterations (max 16)
3. Cache LMSR calculations where possible
4. Use integer math throughout

---

## Frontend Integration (Future)

```javascript
// Example usage
const guards = {
    priceLimitE6: 700_000,        // Max $0.70
    maxSlippageBps: 200,          // 2%
    quotePriceE6: 650_000,        // $0.65 quote
    quoteTimestamp: Math.floor(Date.now() / 1000),
    maxTotalCostE6: 500_000_000,  // Max $500
    allowPartial: true,
    minFillSharesE6: 100_000_000  // Min 100 shares
};

await program.methods
    .tradeAdvanced(side, action, amount, guards)
    .accounts({...})
    .rpc();
```

---

## Current Status

✅ **Phase 1 Complete**: Basic guards (price limits + slippage)
⏳ **Phase 2 Ready**: Comprehensive guards implementation plan
🎯 **Next Action**: Implement AdvancedGuardConfig and validation logic

---

## Files to Modify

1. `programs/cpi_oracle/src/lib.rs`
   - Add AdvancedGuardConfig struct
   - Add error codes
   - Add validation functions
   - Add trade_advanced instruction

2. `app/test-advanced-guards.js` (NEW)
   - Comprehensive test suite

3. `target/idl/cpi_oracle.json`
   - Auto-generated from build

4. `CLAUDE.md`
   - Document new features

---

## Decision: Proceed with Full Implementation?

Options:
1. **Implement Now**: Full advanced guards system
2. **Defer**: Keep simple guards, add advanced later
3. **Hybrid**: Add AdvancedGuardConfig but defer partial fills

**Recommendation**: Implement full system now while context is fresh.
