# X1 Prediction Market - Test Suite

Comprehensive integration and unit tests for the X1 Prediction Market web application.

## Overview

This test suite verifies that all trading operations (BUY, SELL, REDEEM) work correctly and that the UI state accurately reflects on-chain data.

## Test Coverage

### 1. Market Integration Tests (`market.test.js`)

Tests all on-chain operations and verifies balance/position changes:

- **Market State Verification**
  - Fetch and parse AMM account data
  - Verify market status affects trading permissions

- **Position Management**
  - Initialize position accounts
  - Fetch position data correctly

- **BUY Operations**
  - BUY YES shares with balance verification
  - BUY NO shares with balance verification
  - Reject trades below minimum amount
  - Verify vault increases after buys
  - Verify position increases match transaction

- **SELL Operations**
  - SELL YES shares with balance verification
  - SELL NO shares with balance verification
  - Reject sells with insufficient shares
  - Verify vault decreases after sells
  - Verify position decreases match transaction

- **REDEEM Operations**
  - Reject redeem when market not settled
  - Execute redeem when settled and verify payouts
  - Verify position wiped after redeem
  - Calculate correct payout based on pps (payout per share)

- **Market Status Constraints**
  - Trading disabled when market STOPPED (status=1)
  - Trading disabled when market SETTLED (status=2)
  - Redeem only enabled when SETTLED

- **LMSR Pricing**
  - Verify on-chain pricing matches LMSR formula
  - Probabilities sum to 1.0
  - Prices always between 0 and 1

### 2. UI State Management Tests (`ui-state.test.js`)

Tests UI consistency and display updates:

- **Button State Management**
  - Trade buttons enabled only when market OPEN (status=0)
  - Trade buttons disabled when STOPPED or SETTLED
  - Redeem button enabled only when SETTLED (status=2)

- **Market Status Badge**
  - Correct text display for all statuses (OPEN, STOPPED, SETTLED)
  - Status badge updates when market state changes

- **Price Display Updates**
  - YES/NO prices calculated from LMSR
  - Share quantities display correctly
  - Vault balance displays correctly

- **Position Display**
  - Position shares from on-chain data
  - Position values calculated using current prices
  - Net exposure calculated correctly (YES-biased, NO-biased, Neutral)

- **Redeemable Balance Calculations**
  - Correct calculation for YES winner
  - Correct calculation for NO winner
  - Zero when market not settled

- **Wallet Balance Display**
  - Lamports to SOL conversion
  - Correct decimal precision (2 decimals in nav, 4 in sidebar)
  - Handle zero balance

- **LMSR Consistency**
  - Prices always sum to 1.0
  - Prices always between 0 and 1
  - Stable across different market states

## Installation

```bash
cd /home/ubuntu/dev/cpi_oracle/web/test
npm install
```

## Running Tests

### Run all tests
```bash
npm test
```

### Run market integration tests only
```bash
npm run test:market
```

### Run UI state tests only
```bash
npm run test:ui
```

### Run with coverage report
```bash
npm run test:coverage
```

## Environment Setup

The market tests require access to a Solana RPC endpoint. Set the environment variable:

```bash
export ANCHOR_PROVIDER_URL="https://rpc.testnet.x1.xyz"
```

Or use the default configured in the test file.

## Test Wallets

Market tests use `userA.json` from the project root by default. If not found, a new wallet is created and funded via airdrop.

## Understanding Test Results

### Market Tests

Each test performs actual on-chain transactions and verifies:

1. **Before State**: Captures wallet balance, position, and market state
2. **Execute Transaction**: Sends transaction to blockchain
3. **After State**: Captures updated state
4. **Assertions**: Verifies expected changes occurred

Example output:
```
  Market State Verification
    ✓ should fetch and parse market data correctly
    Market status: 0 (0=OPEN, 1=STOPPED, 2=SETTLED)
    Liquidity (b): 500
    Fee: 0.25%

  BUY Operations
    Buying YES shares with 0.1 XNT...
    Trade TX: 3mF7...
    ✓ Received 0.1853 YES shares
    ✓ Vault increased by 0.0975 XNT
    ✓ should execute BUY YES trade and update balances (1523ms)
```

### UI Tests

UI tests use a virtual DOM (jsdom) to verify display logic without a browser:

```
  Button State Management
    ✓ Trade buttons enabled when market OPEN
    ✓ Trade buttons disabled when market STOPPED
    ✓ Redeem button state correct for all market statuses

  LMSR Price Consistency
    ✓ LMSR prices sum to 1.0 for all test cases
    ✓ LMSR prices always within valid bounds
```

## Common Issues

### Market Not Found
If you see "AMM account not found", the market hasn't been initialized. Run:
```bash
cd /home/ubuntu/dev/cpi_oracle
ANCHOR_WALLET=./userA.json node app/trade.js init 500 25
```

### Position Not Initialized
Tests automatically initialize positions if needed. If manual initialization is required:
```bash
ANCHOR_WALLET=./userA.json node app/trade.js init-pos
```

### Insufficient Balance
Market tests require SOL for transactions. Fund the test wallet:
```bash
# On testnet
solana airdrop 2 <WALLET_ADDRESS> --url https://rpc.testnet.x1.xyz
```

### Market Status Wrong
Some tests require specific market states:
- BUY/SELL tests need market OPEN (status=0)
- REDEEM tests need market SETTLED (status=2)

Check market status:
```bash
node app/trade.js quote
```

Change market state:
```bash
# Stop market
ANCHOR_WALLET=./userA.json node app/trade.js stop

# Settle market
ANCHOR_WALLET=./userA.json node app/trade.js settle-oracle --oracle <ORACLE_ADDRESS>
```

## Test Design Principles

1. **Integration First**: Market tests interact with real blockchain to catch integration issues
2. **State Verification**: All tests verify expected state changes occurred
3. **Edge Cases**: Tests include boundary conditions (minimum amounts, insufficient funds, etc.)
4. **UI Consistency**: UI tests ensure display matches on-chain reality
5. **LMSR Correctness**: Mathematical properties verified (sum to 1, bounds, etc.)

## Adding New Tests

### For new on-chain features:

1. Add test to `market.test.js`
2. Follow pattern: capture before state → execute → verify after state
3. Use descriptive test names and console.log for visibility
4. Handle market status requirements (skip if wrong status)

### For new UI features:

1. Add test to `ui-state.test.js`
2. Add required DOM elements to before() setup
3. Test both display logic and edge cases
4. Verify calculations match on-chain formulas

## Coverage Goals

- **Market Operations**: 100% coverage of BUY, SELL, REDEEM paths
- **Status Transitions**: All market statuses tested (OPEN, STOPPED, SETTLED)
- **Error Conditions**: Invalid inputs, insufficient funds, wrong status
- **UI State**: All display fields verified for correctness
- **Mathematical Correctness**: LMSR properties maintained

## Contributing

When adding features to the web app:

1. Write tests first (TDD approach)
2. Ensure tests pass before merging
3. Add tests to this suite for any new UI elements
4. Verify on-chain changes with integration tests
5. Update this README with new test descriptions

## CI/CD Integration

To integrate with CI/CD:

```yaml
# .github/workflows/test.yml
- name: Run Market Tests
  run: |
    cd web/test
    npm install
    npm test
  env:
    ANCHOR_PROVIDER_URL: ${{ secrets.RPC_URL }}
```

## License

Same as parent project
