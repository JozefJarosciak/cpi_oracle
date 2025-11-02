# Guarded Transactions - Quick Reference

**Full Design**: See `GUARDED_TRANSACTIONS_DESIGN.md`

---

## What Are Guarded Transactions?

Protection mechanisms for trades that prevent execution at unfavorable prices.

---

## 6 Transaction Types

### 1. Market Order (Current)
- **No protection**
- Executes immediately at any price
- Use: Fast execution, don't care about price

### 2. Limit Order
- **Price protection**: Won't exceed specified price
- BUY: Execute only if price ≤ limit
- SELL: Execute only if price ≥ limit
- Use: "Don't pay more than $0.70/share"

### 3. Slippage Protected
- **% deviation protection**: Max X% worse than quote
- Rejects if actual price differs too much from quote
- Use: "Don't pay more than 2% above quote"

### 4. All-or-Nothing
- **Full execution or full revert**
- Either get all shares or reject completely
- Optional max cost limit
- Use: "I want exactly 500 shares"

### 5. Partial Fill
- **Execute as much as possible** within limits
- Minimum fill threshold (e.g., at least 50%)
- Refunds unexecuted portion
- Use: "Buy as many as possible under $0.65"

### 6. Combined Guards
- **Multiple protections** at once
- Mix price limits, slippage, partial fills
- Use: Professional traders

---

## Quick Comparison

| Type | Execution | Protection | Complexity | Gas Cost |
|------|-----------|------------|------------|----------|
| Market | Immediate | None | Low | Base |
| Limit | Conditional | Price | Low | +7% |
| Slippage | Conditional | % deviation | Medium | +10% |
| All-or-Nothing | Full or revert | Multiple | Medium | +15% |
| Partial Fill | As much as fits | Multiple | High | +257% |
| Combined | Depends | Maximum | High | +257% |

---

## User Interface Preview

```
┌─────────────────────────────────────────┐
│  BUY [100] [YES v] shares               │
│                                          │
│  Guards: [Configure...] 🛡️              │
│                                          │
│  Quick Presets:                          │
│  [Market] [+2% Slip] [+5% Slip] [Limit] │
│                                          │
│  Estimated: ~$52.30                     │
│  [🛡️ BUY 100 YES SHARES - PROTECTED]   │
└─────────────────────────────────────────┘
```

---

## Example Use Cases

### Use Case 1: Large Buy with Slippage Protection
```
User wants: BUY 1000 YES shares
Quote: $0.65/share → $650 total
Protection: Max 2% slippage
Result: Will execute if cost ≤ $663 (2% = $13)
```

### Use Case 2: Limit Order
```
User wants: BUY 500 YES shares @ max $0.70
Current price: $0.68 → ✅ Execute
Current price: $0.72 → ❌ Reject
```

### Use Case 3: Partial Fill with Min Threshold
```
User wants: BUY 1000 shares, partial OK, min 600
Price limit: $0.65/share
Can get 800 @ avg $0.64 → ✅ Execute 800
Can get 500 @ avg $0.63 → ❌ Reject (< 600 min)
```

---

## Implementation Timeline

| Phase | Duration | Description |
|-------|----------|-------------|
| **Phase 1** | 2 weeks | Smart contract: `trade_guarded` instruction |
| **Phase 2** | 2 weeks | Frontend UI and guard configuration |
| **Phase 3** | 1 week | Beta testing with small group |
| **Phase 4** | 2 weeks | Gradual rollout to all users |
| **Total** | **7 weeks** | Full deployment |

---

## Key Benefits

✅ **Reduces Front-Running Risk**
- Bots can't easily sandwich your trades

✅ **Predictable Outcomes**
- Know worst-case price before submitting

✅ **Professional Features**
- Matches TradFi/DeFi expectations

✅ **Flexible Protection**
- Choose level of protection needed

✅ **Backward Compatible**
- Old market orders still work

---

## Security Features

🛡️ **Quote Staleness Check** - Reject quotes > 30s old
🛡️ **Guard Complexity Limits** - Max 3 guards per trade
🛡️ **Binary Search Limit** - Max 20 iterations for partial fills
🛡️ **Minimum Fill Threshold** - Prevent griefing with tiny fills

---

## Performance Impact

**Gas Costs:**
- Market: 70,000 CU (baseline)
- Limit: 75,000 CU (+7%)
- Partial Fill: 250,000 CU (+257%)

**Latency:**
- Market: 400ms
- Limit: 450ms (+12.5%)
- Partial Fill: 800ms (+100%)

**Acceptable tradeoff for protection**

---

## Smart Contract Signature

### Current (Unchanged):
```rust
pub fn trade(
    ctx: Context<Trade>,
    side: u8,    // 0=YES, 1=NO
    action: u8,  // 0=BUY, 1=SELL
    amount: i64  // Shares in e6
) -> Result<()>
```

### New (Additive):
```rust
pub fn trade_guarded(
    ctx: Context<Trade>,
    side: u8,
    action: u8,
    amount: i64,
    guards: GuardConfig  // ← Protection config
) -> Result<TradeResult>
```

### Guard Config:
```rust
pub struct GuardConfig {
    pub guard_type: u8,              // Type of guard
    pub price_limit: Option<i64>,    // Max/min price per share
    pub max_slippage_bps: Option<u16>,  // Max slippage in bps
    pub quote_price: Option<i64>,    // Reference quote price
    pub allow_partial: bool,         // Allow partial fills?
    pub min_fill_shares: Option<i64>,   // Min shares to execute
    pub max_total_cost: Option<i64>  // Max total cost for BUY
}
```

---

## Error Codes

| Code | Meaning | Action |
|------|---------|--------|
| `PriceLimitExceeded` | Price > limit for BUY | Set higher limit or market order |
| `PriceLimitNotMet` | Price < limit for SELL | Set lower limit or market order |
| `SlippageExceeded` | Deviation > max % | Increase slippage tolerance |
| `CostExceedsLimit` | Total cost > max | Increase max cost or reduce shares |
| `MinFillNotMet` | Partial < minimum | Lower min threshold or increase limit |
| `StaleQuote` | Quote > 30s old | Refresh quote |

---

## Testing Checklist

**Smart Contract:**
- [ ] Limit order respects price limits
- [ ] Slippage calculation is accurate
- [ ] Partial fills execute correct amount
- [ ] All-or-nothing reverts properly
- [ ] Combined guards work together
- [ ] Stale quotes are rejected
- [ ] Gas costs are within bounds

**Frontend:**
- [ ] Guard UI is intuitive
- [ ] Quote refreshes automatically
- [ ] Partial fill results display correctly
- [ ] Error messages are clear
- [ ] Mobile UI works well
- [ ] Preset guards work

**Integration:**
- [ ] Backend quote API is accurate
- [ ] Guard validation catches errors
- [ ] Transaction results parse correctly
- [ ] Volume tracking includes partial fills

---

## Migration Strategy

**Week 1-2:** Deploy smart contract, keep UI unchanged
**Week 3-4:** Add UI behind feature flag, beta test
**Week 5-6:** Enable for all, default to market orders
**Week 7+:** Set smart defaults (e.g., 5% slippage auto-enabled for >$100 trades)

---

## Future Enhancements (V2)

- **Stop-Loss Orders**: Auto-sell when price drops
- **Take-Profit Orders**: Auto-sell when price rises
- **Trailing Stop-Loss**: Dynamic stop that follows price
- **Good-Till-Cancelled**: Persistent orders
- **Iceberg Orders**: Hide total order size
- **Time-In-Force**: FOK, IOC, GTT options

---

## Decision Framework

**Should I use guards?**

```
Is this a large trade (>$100)?
├─ YES → Use slippage protection (2-5%)
└─ NO → Market order is fine

Do I have a target price?
├─ YES → Use limit order
└─ NO → Use market or slippage protection

Do I need exact amount?
├─ YES → Use all-or-nothing
└─ NO → Allow partial fills

Am I a professional trader?
├─ YES → Use combined guards
└─ NO → Use presets
```

---

## Quick Start for Developers

### 1. Enable Guards in Frontend:
```javascript
const guards = {
    type: 'LIMIT',
    priceLimit: 0.70 * 1_000_000  // $0.70 in e6
};
```

### 2. Call Guarded Trade:
```javascript
const result = await program.methods
    .tradeGuarded(side, action, amount_e6, guardConfig)
    .accounts({...})
    .rpc();
```

### 3. Handle Result:
```javascript
const { shares_executed, fully_executed } = parseTradeResult(result);
if (!fully_executed) {
    showPartialFillNotice(shares_executed);
}
```

---

## Support

- Full Design: `GUARDED_TRANSACTIONS_DESIGN.md`
- Code Examples: `/examples/guarded-trades/`
- Test Suite: `/tests/guarded-trades.test.ts`

---

**Status**: PROPOSED
**Next Step**: Review and approve for implementation
**Timeline**: 7 weeks to full deployment
