# Guarded Transactions Design

**Date**: 2025-11-02
**Status**: PROPOSED
**Type**: Feature Design

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Current State Analysis](#current-state-analysis)
3. [Problem Statement](#problem-statement)
4. [Proposed Solution](#proposed-solution)
5. [Transaction Types](#transaction-types)
6. [Implementation Strategy](#implementation-strategy)
7. [UI/UX Design](#ui-ux-design)
8. [Smart Contract Changes](#smart-contract-changes)
9. [Frontend Changes](#frontend-changes)
10. [Testing Plan](#testing-plan)
11. [Migration Path](#migration-path)
12. [Security Considerations](#security-considerations)

---

## Executive Summary

This design proposes adding **guarded transactions** to the prediction market AMM, providing users with protection against adverse price movements during trade execution.

### Key Features

1. **Price Limit Orders**: Set minimum/maximum acceptable prices
2. **Slippage Protection**: Define maximum acceptable slippage percentage
3. **All-or-Nothing Execution**: Guarantee full execution or full revert
4. **Partial Fill Support**: Allow trades to execute partially within limits

### Benefits

- **Reduced Front-Running Risk**: Users can't be sandwiched as easily
- **Predictable Outcomes**: Know worst-case execution price before submitting
- **Better UX**: Users feel safer trading larger amounts
- **Professional Features**: Matches expectations from TradFi/DeFi

---

## Current State Analysis

### Existing Trade Flow

```
User → [Frontend] → [Smart Contract] → [LMSR Calculation] → [Execution]
         ↓              ↓                    ↓                   ↓
    Enter amount    Validate amt      Calculate cost        Transfer SOL
    Click BUY       Check balance     Update q_yes/q_no     Update shares
```

### Current Parameters

**Trade Instruction Signature:**
```rust
pub fn trade(ctx: Context<Trade>, side: u8, action: u8, amount: i64) -> Result<()>
```

**Parameters:**
- `side`: 0 = YES, 1 = NO
- `action`: 0 = BUY, 1 = SELL
- `amount`:
  - For BUY: shares to buy (e6 scale)
  - For SELL: shares to sell (e6 scale)

### Current Price Calculation (LMSR)

```rust
// Cost function: C(q) = b * ln(e^(q_yes/b) + e^(q_no/b))
// For BUY YES shares: cost = C(q_yes + amount) - C(q_yes)
// Price changes dynamically with quantity
```

### Current Limitations

❌ No price protection
❌ No slippage limits
❌ No all-or-nothing guarantees
❌ Price can move between quote and execution
❌ Front-running vulnerability

---

## Problem Statement

### User Pain Points

**Problem 1: Unpredictable Execution Price**
```
User sees: "BUY 100 shares for ~$52.30"
User gets: "BUY 100 shares for $54.87"
Difference: 4.9% worse than expected
```

**Problem 2: Front-Running Vulnerability**
```
1. User submits: BUY 1000 YES shares @ market
2. Bot sees transaction in mempool
3. Bot submits: BUY 500 YES shares @ higher fee
4. Bot's trade executes first, moves price up
5. User's trade executes at worse price
6. Bot sells at profit
```

**Problem 3: Large Order Impact**
```
User wants: BUY 5000 YES shares
Current price: $0.65/share
Expected cost: ~$3250
Actual cost: $4100 (26% slippage!)
```

**Problem 4: Partial Fill Confusion**
```
User submits: BUY 1000 shares for $650
Available liquidity: Only 600 shares at that price
Result: Transaction fails completely
Better: Execute 600 shares, refund rest
```

---

## Proposed Solution

### Guard Types

We propose **4 types of guards** that can be combined:

1. **Price Limit Guards**: Min/max price per share
2. **Slippage Guards**: Max % deviation from quoted price
3. **Execution Mode Guards**: All-or-nothing vs partial fills
4. **Cost Limit Guards**: Max total cost for BUY orders

### Design Principles

✅ **Backward Compatible**: Existing unguarded trades still work
✅ **Composable**: Guards can be combined
✅ **Gas Efficient**: Minimal computation overhead
✅ **User Friendly**: Simple UI with smart defaults
✅ **Fail Fast**: Reject invalid guards before on-chain execution

---

## Transaction Types

### Type 1: Market Order (Current Behavior)

**No guards, immediate execution at current market price**

```typescript
{
  type: 'MARKET',
  action: 'BUY' | 'SELL',
  side: 'YES' | 'NO',
  shares: number,
  guards: null
}
```

**Example:**
```
BUY 100 YES shares @ market
- Executes immediately at whatever price LMSR calculates
- No protection against slippage
```

**Use Case**: Fast execution, don't care about price

---

### Type 2: Limit Order

**Execute only if price is better than or equal to limit**

```typescript
{
  type: 'LIMIT',
  action: 'BUY' | 'SELL',
  side: 'YES' | 'NO',
  shares: number,
  guards: {
    priceLimit: number  // Price per share in e6
  }
}
```

**BUY Limit Logic:**
```
Average price per share ≤ priceLimit
```

**SELL Limit Logic:**
```
Average price per share ≥ priceLimit
```

**Example BUY:**
```
BUY 100 YES shares @ limit $0.60
- Current avg price: $0.55 → ✅ Execute
- Current avg price: $0.65 → ❌ Reject
```

**Example SELL:**
```
SELL 100 YES shares @ limit $0.70
- Current avg price: $0.75 → ✅ Execute
- Current avg price: $0.65 → ❌ Reject
```

**Use Case**:
- BUY: "I'll only buy if I can get shares for $0.60 or better"
- SELL: "I'll only sell if I can get $0.70 or better"

---

### Type 3: Slippage Protected Order

**Execute only if slippage is within tolerance**

```typescript
{
  type: 'SLIPPAGE_PROTECTED',
  action: 'BUY' | 'SELL',
  side: 'YES' | 'NO',
  shares: number,
  guards: {
    maxSlippageBps: number,      // Max slippage in basis points (1% = 100)
    quotePrice: number,           // Reference price from quote
    quoteTimestamp: number        // When quote was generated
  }
}
```

**Slippage Calculation:**
```rust
// For BUY:
actual_avg_price = total_cost / shares
slippage_bps = ((actual_avg_price - quote_price) / quote_price) * 10000
require!(slippage_bps <= max_slippage_bps)

// For SELL:
actual_avg_price = total_proceeds / shares
slippage_bps = ((quote_price - actual_avg_price) / quote_price) * 10000
require!(slippage_bps <= max_slippage_bps)
```

**Example:**
```
Quote: BUY 100 YES shares @ avg $0.55 → total $55
Max slippage: 2% (200 bps)
Acceptable range: $0.539 - $0.561/share → total $53.90 - $56.10

Execution scenarios:
- Actual: $55.50 → 1% slippage → ✅ Execute
- Actual: $56.50 → 2.7% slippage → ❌ Reject
```

**Use Case**: "I quoted $55, I'm okay paying up to $56.10 (+2%)"

---

### Type 4: All-or-Nothing Order

**Execute full amount or revert completely**

```typescript
{
  type: 'ALL_OR_NOTHING',
  action: 'BUY' | 'SELL',
  side: 'YES' | 'NO',
  shares: number,
  guards: {
    allowPartial: false,
    maxCost?: number  // Optional: max total cost for BUY
  }
}
```

**Execution Logic:**
```rust
// For BUY:
let total_cost = calculate_buy_cost(shares);
if let Some(max_cost) = guards.max_cost {
    require!(total_cost <= max_cost, ErrorCode::CostExceedsLimit);
}
// Execute full shares or revert

// For SELL:
require!(user_shares >= shares, ErrorCode::InsufficientShares);
// Execute full shares or revert
```

**Example:**
```
BUY 1000 YES shares, all-or-nothing, max cost $700

Scenarios:
- Cost: $650 → ✅ Execute all 1000
- Cost: $720 → ❌ Reject completely (exceeds max cost)
```

**Use Case**: "I want exactly 1000 shares, or nothing at all"

---

### Type 5: Partial Fill Order

**Execute as much as possible within limits**

```typescript
{
  type: 'PARTIAL_FILL',
  action: 'BUY' | 'SELL',
  side: 'YES' | 'NO',
  shares: number,
  guards: {
    allowPartial: true,
    minFillShares: number,        // Minimum shares to execute
    maxCostPerShare?: number,     // For BUY: max price
    minProceedsPerShare?: number  // For SELL: min price
  }
}
```

**Execution Logic:**
```rust
// For BUY:
let mut shares_bought = 0;
let mut total_cost = 0;

// Binary search to find max shares within price limit
while shares_bought < requested_shares {
    let cost_for_next = calculate_incremental_cost(shares_bought, 1);
    let price_per_share = cost_for_next / 1_000_000;

    if price_per_share > max_cost_per_share {
        break;  // Stop, price too high
    }

    shares_bought += 1;
    total_cost += cost_for_next;
}

require!(shares_bought >= min_fill_shares, ErrorCode::MinFillNotMet);
// Execute shares_bought
```

**Example:**
```
BUY 1000 YES shares, partial allowed
- Min fill: 500 shares
- Max price: $0.65/share

Scenarios:
- Can get 800 shares @ avg $0.63 → ✅ Execute 800
- Can get 300 shares @ avg $0.62 → ❌ Reject (< 500 min)
- Can get 600 shares @ avg $0.64, rest @ $0.68 → ✅ Execute 600 only
```

**Use Case**: "Buy as many shares as possible under $0.65, but at least 500"

---

### Type 6: Combined Guards (Advanced)

**Multiple protection mechanisms**

```typescript
{
  type: 'LIMIT_WITH_SLIPPAGE',
  action: 'BUY',
  side: 'YES',
  shares: 500,
  guards: {
    priceLimit: 0.70,           // Don't pay more than $0.70/share
    maxSlippageBps: 150,        // Max 1.5% slippage from quote
    quotePrice: 0.68,           // Quote was $0.68/share
    allowPartial: true,         // Can execute less than 500
    minFillShares: 250          // But at least 250
  }
}
```

**Combined Logic:**
```
1. Check price limit: avg_price ≤ $0.70 ✓
2. Check slippage: (actual - $0.68) / $0.68 ≤ 1.5% ✓
3. Calculate max shares at these limits
4. If max_shares ≥ 250, execute max_shares
5. If max_shares < 250, reject
```

**Use Case**: Professional traders wanting multiple safety layers

---

## Implementation Strategy

### Phase 1: Smart Contract Updates

#### 1.1 New Instruction: `trade_guarded`

```rust
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct GuardConfig {
    pub guard_type: u8,           // 0=none, 1=limit, 2=slippage, 3=combined
    pub price_limit: Option<i64>, // Price per share in e6
    pub max_slippage_bps: Option<u16>,
    pub quote_price: Option<i64>,
    pub allow_partial: bool,
    pub min_fill_shares: Option<i64>,
    pub max_total_cost: Option<i64>,
}

pub fn trade_guarded(
    ctx: Context<Trade>,
    side: u8,
    action: u8,
    amount: i64,
    guards: GuardConfig
) -> Result<TradeResult> {
    // ... implementation
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct TradeResult {
    pub shares_executed: i64,
    pub cost: i64,
    pub avg_price: i64,
    pub fully_executed: bool,
}
```

#### 1.2 Guard Validation Logic

```rust
fn validate_guards(
    action: u8,
    side: u8,
    amount: i64,
    guards: &GuardConfig,
    amm: &Amm
) -> Result<i64> {
    let shares_to_execute = amount;

    // Calculate actual cost
    let (cost, avg_price) = if action == 0 {  // BUY
        calculate_buy_cost_and_price(side, amount, amm)
    } else {  // SELL
        calculate_sell_proceeds_and_price(side, amount, amm)
    };

    // Validate price limit
    if let Some(limit) = guards.price_limit {
        if action == 0 {  // BUY
            require!(avg_price <= limit, ErrorCode::PriceLimitExceeded);
        } else {  // SELL
            require!(avg_price >= limit, ErrorCode::PriceLimitNotMet);
        }
    }

    // Validate slippage
    if let Some(max_slip) = guards.max_slippage_bps {
        if let Some(quote) = guards.quote_price {
            let slippage_bps = calculate_slippage_bps(avg_price, quote, action);
            require!(slippage_bps <= max_slip, ErrorCode::SlippageExceeded);
        }
    }

    // Validate max cost
    if let Some(max_cost) = guards.max_total_cost {
        require!(cost <= max_cost, ErrorCode::CostExceedsLimit);
    }

    // If all-or-nothing and any guard failed, revert
    if !guards.allow_partial {
        return Ok(shares_to_execute);
    }

    // If partial allowed, binary search for max executable
    if guards.allow_partial {
        let max_shares = binary_search_max_shares(
            action,
            side,
            amount,
            &guards,
            amm
        )?;

        // Check minimum fill
        if let Some(min_fill) = guards.min_fill_shares {
            require!(max_shares >= min_fill, ErrorCode::MinFillNotMet);
        }

        return Ok(max_shares);
    }

    Ok(shares_to_execute)
}
```

#### 1.3 Binary Search for Partial Fills

```rust
fn binary_search_max_shares(
    action: u8,
    side: u8,
    max_shares: i64,
    guards: &GuardConfig,
    amm: &Amm
) -> Result<i64> {
    let mut left = 0;
    let mut right = max_shares;
    let mut best = 0;

    while left <= right {
        let mid = (left + right) / 2;

        let (cost, avg_price) = if action == 0 {
            calculate_buy_cost_and_price(side, mid, amm)
        } else {
            calculate_sell_proceeds_and_price(side, mid, amm)
        };

        // Check if this quantity passes all guards
        let passes = check_guards(avg_price, cost, guards, action);

        if passes {
            best = mid;
            left = mid + 1;  // Try more shares
        } else {
            right = mid - 1;  // Try fewer shares
        }
    }

    Ok(best)
}
```

#### 1.4 Error Codes

```rust
#[error_code]
pub enum ErrorCode {
    #[msg("Price limit exceeded - cannot execute at current price")]
    PriceLimitExceeded,

    #[msg("Price limit not met - cannot execute at current price")]
    PriceLimitNotMet,

    #[msg("Slippage exceeded maximum tolerance")]
    SlippageExceeded,

    #[msg("Total cost exceeds maximum allowed")]
    CostExceedsLimit,

    #[msg("Minimum fill amount not met")]
    MinFillNotMet,

    #[msg("Insufficient shares for sale")]
    InsufficientShares,

    #[msg("Quote too stale - maximum 30 seconds old")]
    StaleQuote,
}
```

### Phase 2: Frontend Updates

#### 2.1 Guard Configuration UI

**Desktop Layout:**
```
┌─────────────────────────────────────────────────────┐
│  TRADING PANEL                                      │
├─────────────────────────────────────────────────────┤
│  Action: [BUY v]    Side: [YES v]                  │
│  Amount: [_____] shares                             │
│                                                      │
│  ⚡ RAPID FIRE: [OFF]                               │
│  🛡️ GUARDS: [Configure...]                         │
│                                                      │
│  Estimated Cost: ~$52.30                           │
│  [BUY 100 YES SHARES]                              │
└─────────────────────────────────────────────────────┘
```

**Guard Configuration Modal:**
```
┌─────────────────────────────────────────────────────┐
│  🛡️ Configure Trade Guards                          │
├─────────────────────────────────────────────────────┤
│                                                      │
│  Protection Type:                                   │
│  ○ None (Market Order)                             │
│  ● Limit Order                                      │
│  ○ Slippage Protection                             │
│  ○ All-or-Nothing                                  │
│  ○ Partial Fill Allowed                            │
│  ○ Advanced (Multiple Guards)                      │
│                                                      │
│  ┌─ Limit Order Settings ───────────────────────┐ │
│  │ Max Price Per Share: [0.70____] XNT          │ │
│  │ (Current avg: $0.65/share)                   │ │
│  └──────────────────────────────────────────────┘ │
│                                                      │
│  Execution Preview:                                 │
│  ✓ Will execute if price ≤ $0.70/share             │
│  ✗ Will reject if price > $0.70/share              │
│                                                      │
│  [Cancel]  [Apply Guards]                          │
└─────────────────────────────────────────────────────┘
```

**Advanced Guards Modal:**
```
┌─────────────────────────────────────────────────────┐
│  🛡️ Advanced Guard Configuration                    │
├─────────────────────────────────────────────────────┤
│                                                      │
│  ┌─ Price Limit ──────────────────────────────────┐│
│  │ [✓] Enable Price Limit                         ││
│  │ Max Price: [0.70____] XNT/share                ││
│  └────────────────────────────────────────────────┘│
│                                                      │
│  ┌─ Slippage Protection ──────────────────────────┐│
│  │ [✓] Enable Slippage Guard                      ││
│  │ Max Slippage: [2.0____] %                      ││
│  │ Quote Price: $0.65 (refreshed 3s ago)          ││
│  └────────────────────────────────────────────────┘│
│                                                      │
│  ┌─ Execution Mode ───────────────────────────────┐│
│  │ ○ All-or-Nothing (500 shares or nothing)       ││
│  │ ● Partial Fill Allowed                         ││
│  │   Min Fill: [250____] shares (50% minimum)     ││
│  └────────────────────────────────────────────────┘│
│                                                      │
│  ┌─ Cost Limit ───────────────────────────────────┐│
│  │ [✓] Max Total Cost: [$400.00__] XNT           ││
│  └────────────────────────────────────────────────┘│
│                                                      │
│  Simulation:                                        │
│  Best case: 500 shares @ $0.65 = $325.00          │
│  Worst case: 500 shares @ $0.70 = $350.00         │
│  With guards: Guaranteed ≤ $350.00                 │
│                                                      │
│  [Cancel]  [Save & Apply]                          │
└─────────────────────────────────────────────────────┘
```

#### 2.2 Quick Guard Presets

**One-Click Protection Buttons:**
```
┌─────────────────────────────────────────────────────┐
│  Quick Guards:                                      │
│  [Market] [+2% Slip] [+5% Slip] [Limit] [Custom]   │
│                                                      │
│  Selected: +2% Slippage Protection                  │
│  ✓ Max 2% worse than quote                         │
│  Current quote: $0.65/share                         │
└─────────────────────────────────────────────────────┘
```

#### 2.3 Guard Indicator in Trade Button

```javascript
// Visual feedback on button
<button id="tradeBtn" class="trade-buy-btn">
  {guards ? '🛡️' : ''} BUY 100 YES SHARES
  {guards ? <span class="guard-badge">PROTECTED</span> : null}
</button>
```

#### 2.4 Post-Trade Result Display

```
┌─────────────────────────────────────────────────────┐
│  ✅ Trade Executed Successfully                      │
├─────────────────────────────────────────────────────┤
│  Requested: 500 YES shares                          │
│  Executed: 450 YES shares (90%)                     │
│  Reason: Price limit reached after 450 shares       │
│                                                      │
│  Average Price: $0.6925/share                       │
│  Total Cost: $311.63                                │
│  Slippage: 1.2% (within 2% limit) ✓                │
│                                                      │
│  Remaining: 50 shares not executed                  │
│  Refunded: $35.00                                   │
│                                                      │
│  [OK]  [View Transaction]                          │
└─────────────────────────────────────────────────────┘
```

#### 2.5 JavaScript Implementation

```javascript
// Guard configuration state
let activeGuards = null;

// Guard configuration modal
function openGuardConfigModal() {
    const modal = document.getElementById('guardConfigModal');
    modal.classList.add('show');

    // Pre-populate with current settings
    if (activeGuards) {
        populateGuardForm(activeGuards);
    }
}

// Apply guards
function applyGuards() {
    const guardType = document.querySelector('input[name="guardType"]:checked').value;

    switch (guardType) {
        case 'LIMIT':
            activeGuards = {
                type: 'LIMIT',
                priceLimit: parseFloat(document.getElementById('priceLimitInput').value) * 1_000_000,
                allowPartial: false
            };
            break;

        case 'SLIPPAGE':
            activeGuards = {
                type: 'SLIPPAGE_PROTECTED',
                maxSlippageBps: parseFloat(document.getElementById('slippageInput').value) * 100,
                quotePrice: currentQuotePrice * 1_000_000,
                quoteTimestamp: Date.now(),
                allowPartial: false
            };
            break;

        case 'ADVANCED':
            activeGuards = buildAdvancedGuards();
            break;

        default:
            activeGuards = null;
    }

    updateGuardIndicators();
    closeModal('guardConfigModal');
}

// Update trade execution to use guards
async function executeTradeWithGuards(tradeData) {
    const { action, side, numShares } = tradeData;

    // Build guard config for smart contract
    const guardConfig = activeGuards ? {
        guard_type: getGuardTypeCode(activeGuards.type),
        price_limit: activeGuards.priceLimit || null,
        max_slippage_bps: activeGuards.maxSlippageBps || null,
        quote_price: activeGuards.quotePrice || null,
        allow_partial: activeGuards.allowPartial || false,
        min_fill_shares: activeGuards.minFillShares || null,
        max_total_cost: activeGuards.maxTotalCost || null
    } : null;

    // Call trade_guarded instruction
    const instruction = await program.methods
        .tradeGuarded(side, action, numShares * 1_000_000, guardConfig)
        .accounts({
            amm: ammPda,
            position: positionPda,
            user: wallet.publicKey,
            vault: vaultPda,
            systemProgram: SystemProgram.programId
        })
        .instruction();

    // Execute transaction
    const tx = await sendAndConfirm(instruction);

    // Parse result
    const result = parseTradeResult(tx);
    showTradeResult(result);

    return result;
}

// Show result with partial fill info
function showTradeResult(result) {
    const { shares_executed, shares_requested, cost, avg_price, fully_executed } = result;

    let message = `✅ Trade Executed\n\n`;
    message += `Executed: ${shares_executed} shares\n`;
    message += `Average Price: $${(avg_price / 1_000_000).toFixed(4)}/share\n`;
    message += `Total Cost: $${(cost / 1_000_000).toFixed(2)}\n`;

    if (!fully_executed) {
        const remaining = shares_requested - shares_executed;
        message += `\n⚠️ Partial Fill\n`;
        message += `Remaining: ${remaining} shares not executed\n`;
        message += `Reason: Guard limit reached\n`;
    }

    if (activeGuards) {
        message += `\n🛡️ Guards Active\n`;
        message += formatGuardStatus(activeGuards, result);
    }

    showModal(message);
}
```

#### 2.6 Real-time Quote Updates

```javascript
// Quote refresh system
let quoteRefreshTimer = null;
let lastQuoteTime = 0;

function startQuoteRefresh() {
    if (quoteRefreshTimer) clearInterval(quoteRefreshTimer);

    quoteRefreshTimer = setInterval(() => {
        if (activeGuards && activeGuards.type === 'SLIPPAGE_PROTECTED') {
            const age = Date.now() - activeGuards.quoteTimestamp;

            // Update quote age indicator
            document.getElementById('quoteAge').textContent = `(${Math.floor(age / 1000)}s ago)`;

            // Warn if quote is stale (> 30s)
            if (age > 30000) {
                showQuoteStaleWarning();
            }
        }
    }, 1000);
}

// Refresh quote
async function refreshQuote() {
    const shares = parseFloat(document.getElementById('tradeAmountShares').value);
    const action = getSelectedAction();
    const side = getSelectedSide();

    // Get fresh quote from smart contract
    const quote = await getTradeQuote(action, side, shares);

    // Update guard with fresh quote
    if (activeGuards && activeGuards.quotePrice) {
        activeGuards.quotePrice = quote.avgPrice;
        activeGuards.quoteTimestamp = Date.now();
    }

    // Update UI
    updateQuoteDisplay(quote);
}
```

### Phase 3: Backend/API Updates

#### 3.1 Quote Endpoint

**New API endpoint to get trade quote:**

```typescript
// GET /api/ts/trade-quote
app.get('/api/ts/trade-quote', async (req, res) => {
    const { action, side, shares } = req.query;

    try {
        // Fetch current AMM state
        const amm = await program.account.amm.fetch(ammPda);

        // Calculate quote
        const quote = calculateTradeQuote(
            action,
            side,
            parseInt(shares),
            amm
        );

        res.json({
            shares: parseInt(shares),
            avgPrice: quote.avgPrice,
            totalCost: quote.totalCost,
            timestamp: Date.now(),
            validFor: 30000,  // Valid for 30 seconds
            marketState: {
                qYes: amm.qYes.toString(),
                qNo: amm.qNo.toString(),
                b: amm.b.toString()
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
```

#### 3.2 Guard Validation Endpoint

**Validate guards before submission:**

```typescript
// POST /api/ts/validate-guards
app.post('/api/ts/validate-guards', async (req, res) => {
    const { action, side, shares, guards } = req.body;

    try {
        // Simulate guard validation
        const result = await simulateGuardedTrade(
            action,
            side,
            shares,
            guards
        );

        res.json({
            valid: result.valid,
            errors: result.errors,
            expectedOutcome: {
                sharesExecuted: result.sharesExecuted,
                cost: result.cost,
                avgPrice: result.avgPrice
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
```

---

## Testing Plan

### Unit Tests (Rust)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_price_limit_guard_buy() {
        // Setup: Market where avg price would be $0.70
        let mut amm = create_test_amm();

        let guards = GuardConfig {
            guard_type: 1,  // LIMIT
            price_limit: Some(600_000),  // $0.60 limit
            ..Default::default()
        };

        // Should fail because $0.70 > $0.60
        let result = validate_guards(0, 0, 100_000_000, &guards, &amm);
        assert!(result.is_err());
    }

    #[test]
    fn test_slippage_guard() {
        let mut amm = create_test_amm();

        let guards = GuardConfig {
            guard_type: 2,  // SLIPPAGE
            max_slippage_bps: Some(200),  // 2%
            quote_price: Some(650_000),   // $0.65
            ..Default::default()
        };

        // Actual price: $0.67 = 3% slippage
        // Should fail
        let result = validate_guards(0, 0, 100_000_000, &guards, &amm);
        assert!(result.is_err());
    }

    #[test]
    fn test_partial_fill() {
        let mut amm = create_test_amm();

        let guards = GuardConfig {
            guard_type: 1,
            price_limit: Some(700_000),  // $0.70
            allow_partial: true,
            min_fill_shares: Some(50_000_000),  // 50 shares min
            ..Default::default()
        };

        // Request 100 shares, but only 60 fit under limit
        let result = validate_guards(0, 0, 100_000_000, &guards, &amm);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), 60_000_000);  // 60 shares
    }
}
```

### Integration Tests (TypeScript)

```typescript
describe('Guarded Trades', () => {
    it('should execute limit order when price is favorable', async () => {
        const guards = {
            guard_type: 1,
            price_limit: 700_000,  // $0.70
            allow_partial: false
        };

        const tx = await program.methods
            .tradeGuarded(0, 0, 100_000_000, guards)
            .accounts({...})
            .rpc();

        const result = await parseTradeResult(tx);
        expect(result.shares_executed).toBe(100_000_000);
        expect(result.fully_executed).toBe(true);
    });

    it('should reject limit order when price exceeds limit', async () => {
        const guards = {
            guard_type: 1,
            price_limit: 600_000,  // $0.60 (too low)
            allow_partial: false
        };

        await expect(
            program.methods
                .tradeGuarded(0, 0, 100_000_000, guards)
                .accounts({...})
                .rpc()
        ).rejects.toThrow('PriceLimitExceeded');
    });

    it('should execute partial fill when limit allows', async () => {
        const guards = {
            guard_type: 1,
            price_limit: 700_000,
            allow_partial: true,
            min_fill_shares: 50_000_000
        };

        const tx = await program.methods
            .tradeGuarded(0, 0, 100_000_000, guards)
            .accounts({...})
            .rpc();

        const result = await parseTradeResult(tx);
        expect(result.shares_executed).toBeGreaterThanOrEqual(50_000_000);
        expect(result.shares_executed).toBeLessThanOrEqual(100_000_000);
    });
});
```

### UI Tests (Playwright)

```typescript
test('user can set price limit guard', async ({ page }) => {
    await page.goto('http://localhost:3434');

    // Open guard config
    await page.click('text=Configure Guards');
    await page.click('input[value="LIMIT"]');

    // Set price limit
    await page.fill('#priceLimitInput', '0.70');
    await page.click('text=Apply Guards');

    // Verify guard indicator
    await expect(page.locator('.guard-badge')).toHaveText('PROTECTED');

    // Execute trade
    await page.fill('#tradeAmountShares', '100');
    await page.click('#tradeBtn');

    // Should see guard protection in result
    await expect(page.locator('.trade-result')).toContainText('Price Limit: $0.70');
});
```

---

## Migration Path

### Backward Compatibility

**The existing `trade` instruction remains unchanged:**
```rust
pub fn trade(ctx: Context<Trade>, side: u8, action: u8, amount: i64) -> Result<()>
```

**New `trade_guarded` instruction is additive:**
```rust
pub fn trade_guarded(
    ctx: Context<Trade>,
    side: u8,
    action: u8,
    amount: i64,
    guards: GuardConfig
) -> Result<TradeResult>
```

### Rollout Plan

**Phase 1: Smart Contract Deployment (Week 1)**
- Deploy updated program with `trade_guarded` instruction
- Keep `trade` instruction for backward compatibility
- Test on devnet

**Phase 2: Frontend Beta (Week 2)**
- Add guard UI behind feature flag
- Beta test with small group
- Collect feedback

**Phase 3: Gradual Rollout (Week 3)**
- Enable for all users
- Default to market orders (current behavior)
- Add "Try Guards" prompts for large trades

**Phase 4: Default Guards (Week 4+)**
- Set smart defaults (e.g., 5% slippage for trades > $100)
- Users can disable if desired

---

## Security Considerations

### Attack Vectors

**1. Griefing with Partial Fills**
```
Attack: Submit order with tight limits, force small partial fills
Defense: Charge minimum gas fee regardless of execution size
```

**2. Quote Staleness Abuse**
```
Attack: Use stale quote when price moves favorably
Defense: Reject quotes > 30 seconds old on-chain
```

**3. Gas Cost DOS**
```
Attack: Submit complex multi-guard orders to burn compute
Defense: Limit guard combinations, optimize binary search
```

### Mitigations

✅ **Quote Age Validation**
```rust
if let Some(quote_ts) = guards.quote_timestamp {
    let now = Clock::get()?.unix_timestamp;
    require!(now - quote_ts < 30, ErrorCode::StaleQuote);
}
```

✅ **Guard Complexity Limits**
```rust
let guard_count = [
    guards.price_limit.is_some(),
    guards.max_slippage_bps.is_some(),
    guards.max_total_cost.is_some()
].iter().filter(|&&x| x).count();

require!(guard_count <= 3, ErrorCode::TooManyGuards);
```

✅ **Binary Search Iteration Limit**
```rust
const MAX_BINARY_SEARCH_ITERATIONS: u8 = 20;
```

✅ **Minimum Fill Threshold**
```rust
// Prevent griefing with tiny partial fills
if guards.allow_partial {
    require!(
        guards.min_fill_shares.unwrap_or(0) >= 1_000_000,  // 1 share minimum
        ErrorCode::MinFillTooSmall
    );
}
```

---

## Performance Analysis

### Gas Cost Comparison

**Market Order (Current):**
- Base cost: ~50,000 CU
- LMSR calc: ~20,000 CU
- Total: ~70,000 CU

**Limit Order:**
- Base cost: ~50,000 CU
- LMSR calc: ~20,000 CU
- Guard validation: ~5,000 CU
- Total: ~75,000 CU (+7%)

**Partial Fill (Binary Search):**
- Base cost: ~50,000 CU
- LMSR calc (per iteration): ~20,000 CU
- Iterations: ~10 avg
- Total: ~250,000 CU (+257%)

**Optimization: Partial fills are expensive, discourage with higher fees**

### Latency Impact

**Market Order:** 400ms
**Limit Order:** 450ms (+12.5%)
**Partial Fill:** 800ms (+100%)

**Acceptable for improved UX and protection**

---

## Alternatives Considered

### Alternative 1: Off-Chain Order Book

**Pros:**
- Lower gas costs
- More complex order types
- Professional exchange feel

**Cons:**
- Centralization risk
- Complex infrastructure
- Delayed execution

**Decision: Rejected** - On-chain guards are simpler and more trustless

### Alternative 2: Oracle-Based Limits

**Pros:**
- Can use external price feeds
- Cross-market protection

**Cons:**
- Oracle dependency
- Additional attack surface
- Higher gas costs

**Decision: Rejected** - LMSR is deterministic, oracle not needed

### Alternative 3: Time-Weighted Average Guards

**Pros:**
- Protection against temporary spikes
- Smoother execution

**Cons:**
- Complex to implement
- Requires price history storage
- Higher gas costs

**Decision: Deferred** - Consider for v2

---

## Future Enhancements

### V2 Features

1. **Stop-Loss Orders**
   - Automatically sell when price drops below threshold
   - Requires continuous monitoring or event triggers

2. **Take-Profit Orders**
   - Automatically sell when price exceeds threshold
   - Same infrastructure as stop-loss

3. **Trailing Stop-Loss**
   - Stop-loss that adjusts with favorable price movements
   - More complex state management

4. **Good-Till-Cancelled (GTC) Orders**
   - Orders that persist until filled or cancelled
   - Requires order book infrastructure

5. **Iceberg Orders**
   - Hide total order size, execute in chunks
   - Professional trading feature

6. **Time-In-Force Options**
   - Fill-or-Kill (FOK)
   - Immediate-or-Cancel (IOC)
   - Good-Till-Time (GTT)

---

## Success Metrics

### Adoption Metrics

**Target (3 months post-launch):**
- 30% of trades use some guard
- 15% use limit orders
- 10% use slippage protection
- 5% use advanced guards

### UX Metrics

**Target:**
- < 2% guard-related transaction failures
- < 5% quote staleness warnings
- > 90% user satisfaction (surveys)

### Technical Metrics

**Target:**
- Gas cost increase < 20% avg
- Latency increase < 25% avg
- Zero critical guard bypasses

---

## Conclusion

Guarded transactions provide essential protection for users trading in the prediction market AMM. The proposed design:

✅ **Maintains Backward Compatibility** - Existing trades work unchanged
✅ **Provides Flexible Protection** - Multiple guard types for different needs
✅ **Optimizes for Common Cases** - Simple guards have minimal overhead
✅ **Enables Advanced Features** - Foundation for future order types
✅ **Improves User Trust** - Professional-grade protection mechanisms

### Recommendation

**Proceed with implementation in phases:**
1. Smart contract updates (2 weeks)
2. Frontend UI (2 weeks)
3. Beta testing (1 week)
4. Gradual rollout (2 weeks)

**Total timeline: ~7 weeks to full deployment**

---

**Status**: PROPOSED - Awaiting approval to proceed
**Next Steps**: Review design, prioritize guard types, begin Phase 1 implementation

**Document Version**: 1.0
**Last Updated**: 2025-11-02
