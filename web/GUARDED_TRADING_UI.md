# Guarded Trading UI

## Overview

The Guarded Trading UI provides a comprehensive, user-friendly interface for executing trades with advanced on-chain protection mechanisms. All guard validation happens on-chain in the Solana program, ensuring execution is protected even if network conditions change between simulation and execution.

## Access

Navigate to `/guarded-trade.html` or click the **🛡️ GUARDED TRADING** button in the main trading panel.

## Features

### 1. **Price Limit Protection** 💰
- **For BUY orders**: Set a maximum price you're willing to pay
- **For SELL orders**: Set a minimum price you're willing to accept
- Trade is rejected if execution price doesn't meet your limit
- Prevents unfavorable execution in volatile market conditions

### 2. **Slippage Protection** 📉
- Compare execution price against your quote price
- Set tolerance in basis points (bps): 100 bps = 1%
- Quote must be ≤30 seconds old (enforced on-chain)
- Preset buttons for common slippage tolerances: 0.5%, 1%, 2%, 5%, 10%
- **Get Quote** button fetches current market price

### 3. **Max Cost Limit** 💵
- Cap the total cost of your BUY order
- Works seamlessly with partial fills to execute maximum shares within budget
- Quick presets: $10, $50, $100, $500, $1K, $5K
- Only applies to BUY orders

### 4. **Partial Fills** 🔀
- Allow trade to execute partially if full amount would violate guards
- Uses binary search (max 16 iterations) to find largest executable size
- Set minimum fill threshold to prevent dust trades
- Visual feedback shows percentage filled

## User Interface

### Layout

The UI is organized into collapsible panels:

1. **Trade Setup** - Basic parameters (Action, Side, Amount)
2. **Price Limit** - Absolute price protection
3. **Slippage Protection** - Quote-based slippage tolerance
4. **Max Cost Limit** - Total cost cap for BUY orders
5. **Partial Fills** - Partial execution settings
6. **Simulation Results** - Real-time validation preview

### Guard Status Badges

Each guard displays its current status:
- **INACTIVE** (gray) - Guard is disabled
- **ACTIVE** (green) - Guard is enabled and will be enforced
- **FAILED** (red) - Guard would reject the trade (shown in simulation)

### Simulation Panel

Before executing, click **🔍 SIMULATE TRADE** to preview:
- **Execution Status**: Full execution, partial fill, or rejection
- **Shares to Execute**: How many shares will be traded
- **Execution Price**: Expected price per share
- **Total Cost**: Total amount (with fees)
- **Guard Badges**: Pass/fail status for each enabled guard

### Execution

1. Configure your trade parameters
2. Enable desired guards with toggle switches
3. Click **🔍 SIMULATE TRADE** to validate
4. Review simulation results
5. Click **🛡️ EXECUTE GUARDED TRADE** if satisfied

## Guard Configuration Details

### AdvancedGuardConfig Structure

```rust
pub struct AdvancedGuardConfig {
    pub price_limit_e6: i64,           // 0 = no limit
    pub max_slippage_bps: u16,         // 0 = no check
    pub quote_price_e6: i64,           // Reference price
    pub quote_timestamp: i64,          // Unix seconds
    pub max_total_cost_e6: i64,        // 0 = no limit
    pub allow_partial: bool,            // Enable partial fills?
    pub min_fill_shares_e6: i64,       // Min shares if partial
}
```

### Price Format

All prices use 6 decimal places (e6 format):
- $0.50 = 500,000 e6
- $1.00 = 1,000,000 e6
- $100.00 = 100,000,000 e6

### Slippage Format

Slippage is measured in basis points (bps):
- 1 bps = 0.01%
- 10 bps = 0.1%
- 100 bps = 1%
- 1,000 bps = 10%

## Use Cases

### Conservative Buyer
```
Action: BUY
Amount: 100 shares
Guards:
  - Price Limit: $0.60 (won't pay more than $0.60/share)
  - Max Cost: $65 (won't spend more than $65 total)
  - Partial Fills: ON (min 10 shares)
```
**Result**: Buys up to 100 shares at ≤$0.60/share, up to $65 total, at least 10 shares.

### Tight Slippage Trader
```
Action: BUY
Amount: 500 shares
Guards:
  - Slippage: 50 bps (0.5%)
  - Quote Price: $0.4523 (fetched)
  - Partial Fills: OFF
```
**Result**: All-or-nothing execution. Buys 500 shares only if price ≤$0.4545 ($0.4523 + 0.5%).

### Budget-Constrained DCA
```
Action: BUY
Amount: 1000 shares
Guards:
  - Max Cost: $100
  - Partial Fills: ON (min 50 shares)
```
**Result**: Buys as many shares as possible up to $100, minimum 50 shares.

### Profit-Taking Seller
```
Action: SELL
Amount: 250 shares
Guards:
  - Price Limit: $0.55 (won't sell below $0.55/share)
  - Partial Fills: OFF
```
**Result**: All-or-nothing. Sells 250 shares only if price ≥$0.55/share.

## Design Principles

### Visual Hierarchy
- Dark theme matches existing Hyperliquid-style terminal aesthetic
- Color-coded status badges for quick scanning
- Progressive disclosure: guards hidden behind toggles

### User Feedback
- Real-time simulation shows exact execution outcome
- Partial fill warnings highlight reduced execution
- Guard status badges show pass/fail for each constraint

### Safety First
- Simulation required before execution (button disabled until simulated)
- Confirmation dialog before on-chain execution
- All validation happens on-chain (trustless)

## Technical Implementation

### Frontend Stack
- Vanilla JavaScript (no framework dependencies)
- Solana web3.js for blockchain interaction
- Custom CSS matching existing dark theme
- Responsive design for mobile compatibility

### Backend Integration
- `/api/simulate-guarded-trade` - Preflight validation
- `/api/ts/market-data` - Current market prices
- Direct Solana RPC calls for on-chain execution

### On-Chain Validation
- Program ID: `EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF`
- Instruction: `trade_advanced`
- Binary search for partial fills (max 16 iterations)
- All guards enforced in Rust smart contract

## Browser Compatibility

- Chrome/Edge: ✅ Full support
- Firefox: ✅ Full support
- Safari: ✅ Full support
- Mobile browsers: ✅ Responsive design

## Performance

- Simulation: ~200ms (off-chain, no fees)
- Execution: ~2-5s (on-chain, transaction confirmation)
- Binary search overhead: ~15k CU (compute units)

## Future Enhancements

- [ ] Real-time guard validation as parameters change
- [ ] Historical execution analytics
- [ ] Saved preset configurations
- [ ] Multi-guard templates (conservative, moderate, aggressive)
- [ ] Integration with wallet balance for auto max cost calculation
- [ ] Advanced order types (limit orders, stop-loss)

## Support

For issues or questions:
- Check transaction logs in browser console
- Verify wallet connection
- Ensure sufficient balance for transaction fees
- Review simulation results before execution

## Related Documentation

- [ADVANCED_GUARDS_IMPLEMENTATION.md](../ADVANCED_GUARDS_IMPLEMENTATION.md) - Full technical implementation details
- [SOLANA_RPC_LOAD_ANALYSIS.md](../SOLANA_RPC_LOAD_ANALYSIS.md) - Why on-chain guards reduce RPC load
- [Test Results](../app/test-advanced-guards.js) - Comprehensive test suite
