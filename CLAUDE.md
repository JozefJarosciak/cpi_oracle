# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Solana prediction market AMM (Automated Market Maker) built with Anchor that uses Cross-Program Invocation (CPI) to read oracle prices. The market implements LMSR (Logarithmic Market Scoring Rule) for binary YES/NO prediction markets on BTC price movements.

**Key Components:**
- **Solana Program**: Rust/Anchor smart contract (`programs/cpi_oracle/src/lib.rs`)
- **Client Applications**: JavaScript trading bots and utilities (`app/`)
- **Test Suite**: TypeScript tests using Anchor framework (`tests/`)

## Development Commands

### Building
```bash
# Build the Solana program
anchor build

# Compile IDL types for TypeScript
anchor build && anchor idl parse -f programs/cpi_oracle/src/lib.rs -o target/idl/cpi_oracle.json
```

### Testing
```bash
# Run all tests (configured in Anchor.toml)
anchor test

# Or use yarn directly
yarn run ts-mocha -p ./tsconfig.json -t 1000000 "tests/**/*.ts"
```

### Linting
```bash
# Check formatting
yarn lint

# Fix formatting issues
yarn lint:fix
```

### Running the Market
```bash
# Run a complete market simulation with multiple users
bash run.sh

# The script:
# 1. Closes existing market (if any)
# 2. Initializes fresh market with b=500, fee=25bps
# 3. Initializes positions for users A-E
# 4. Runs mixed trading simulation
# 5. Settles via oracle

# Other run scripts for different scenarios:
bash run2.sh   # Alternative configuration
bash run3.sh   # Different parameters
bash run4.sh   # Yet another variant
```

### Manual Market Operations
```bash
# Initialize market (b=liquidity param, fee_bps=fee in basis points)
ANCHOR_WALLET=./userA.json node app/trade.js init 500 25

# Initialize user position
ANCHOR_WALLET=./userB.json node app/trade.js init-pos

# Take start price snapshot
ANCHOR_WALLET=./userA.json node app/trade.js snapshot-start --oracle <ORACLE_STATE_PUBKEY>

# Run trading simulation
node app/trade.js run --wallets ./userA.json,./userB.json --steps 10 --mode mixed

# Stop market
ANCHOR_WALLET=./userA.json node app/trade.js stop

# Settle by oracle (compares current price to snapshot)
ANCHOR_WALLET=./userA.json node app/trade.js settle-oracle --oracle <ORACLE_STATE_PUBKEY>

# Close market account
ANCHOR_WALLET=./userA.json node app/trade.js close
```

### Web Interface

A simple web interface is available for monitoring the market (read-only):

```bash
cd webapp
./start.sh

# Or manually:
npm install
npm start
```

Access at: http://localhost:3434

**Features:**
- Real-time oracle price display (BTC)
- Market state monitoring
- Terminal-style UI (VT100 inspired)
- Minimal dependencies (Express + Solana web3.js)
- No build process required

**Note:** The web interface is read-only. Use CLI tools in `app/` for market operations (init, trade, settle).

**Alternative:** A full-featured Next.js/React frontend is available in `frontend/` with wallet integration, but requires more setup.

## Architecture

### Smart Contract Structure

**Core State Accounts:**
- `Amm`: Main market state including LMSR parameters (b, q_yes, q_no), vault accounting, oracle snapshots
- `Position`: Per-user position tracking YES/NO shares
- PDAs: `vault_sol` (system-owned SOL vault), `amm` (market state), `pos` (user positions)

**Key Instructions:**
1. `init_amm`: Creates new market with liquidity parameter b and fee
2. `init_position`: Initializes user's position account
3. `trade`: Executes BUY/SELL for YES/NO sides with LMSR pricing
4. `snapshot_start`: Records BTC price from oracle for settlement reference
5. `stop_market`: Halts trading
6. `settle_by_oracle`: Compares current oracle price to snapshot and determines winner
7. `settle_market`: Manual settlement (alternative to oracle-based)
8. `redeem`: Users claim winnings post-settlement
9. `wipe_position`: Admin function to zero out positions

**Oracle Integration:**
- Oracle program ID: `7ARBeYF5rGCanAGiRaxhVpiuZZpGXazo5UJqHMoJgkuE`
- Reads BTC price via CPI from external oracle state account
- Uses median of triplet values (param1, param2, param3) with timestamps
- Enforces freshness check (90 second max age)
- All prices converted to 1e6 fixed-point internally

**LMSR Pricing:**
- Cost function: `b * ln(e^(q_yes/b) + e^(q_no/b))`
- Binary search (32 iterations) to find quantity for given spend
- Fees deducted before net amount updates vault
- Average execution price tracked and emitted in events

**SOL Flow Architecture:**
- Users pay lamports directly for BUY operations
- Vault PDA holds all coverage lamports (system-owned, 0-space account)
- Parallel "mirror" accounting in `vault_e6` field (1e6 scale)
- Conversion: `LAMPORTS_PER_E6 = 100` (configurable in both Rust and JS)
- Minimum 1 SOL reserve kept in vault at all times

### Client Application Design

**app/trade.js** - Main CLI client with multiple modes:
- `--simple|-S`: Colored terminal output with BTC prices
- `--jsonl`: Machine-readable line-delimited JSON
- `--audit`: Detailed position tracking and PnL calculation
- `--quiet`: Minimal output
- Support for up to 5 concurrent users (A-E)
- Simulates random BUY/SELL with configurable probabilities

**Workflow:**
1. Snapshot oracle BTC price at market start
2. Random users execute trades (buy/sell YES/NO)
3. Stop market after N steps
4. Settle via oracle comparison (current vs start price)
5. Users redeem winnings
6. Optional: reinit market and repeat

**Other Utilities:**
- `app/read.js`, `app/read2.js`: Oracle state readers
- `app/bloomberg.js`, `app/ibm_hud.js`, `app/vt_hud.js`: Display utilities
- `app/tester.js`: Test harness
- `app/vault.js`: Vault inspection

## Important Constraints

1. **Oracle Freshness**: Price data must be ≤90 seconds old (see `ORACLE_MAX_AGE_SECS`)
2. **Trade Limits**:
   - Min buy: $0.10 (100_000 e6)
   - Min sell: 0.1 shares (100_000 e6)
   - Max spend: $50k per trade (50_000_000_000 e6)
   - Max shares: 50M per trade (50_000_000_000 e6)
3. **Vault Reserve**: Always keep ≥1 SOL in vault PDA (see `MIN_VAULT_LAMPORTS`)
4. **Fixed Point**: All USD/share amounts use 1e6 scaling (6 decimals)
5. **Settlement**: Must snapshot start price before can settle by oracle
6. **Lifecycle**: Open → Stopped → Settled (one-way state transitions)

## Program IDs and Seeds

- **Program**: `EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF`
- **Oracle Program**: `7ARBeYF5rGCanAGiRaxhVpiuZZpGXazo5UJqHMoJgkuE`
- **AMM Seed**: `b"amm_btc_v3"` (bump seed version to reset market)
- **Position Seed**: `b"pos"` + amm_key + user_key
- **Vault Seed**: `b"vault_sol"` + amm_key

## Environment Variables

```bash
# RPC endpoint (default: local validator)
export ANCHOR_PROVIDER_URL="http://127.0.0.1:8899"

# Wallet keypair path (default: ~/.config/solana/id.json)
export ANCHOR_WALLET="./userA.json"

# Oracle state account address (required for oracle operations)
export ORACLE_STATE="4KYeNyv1B9YjjQkfJk2C6Uqo71vKzFZriRe5NXg6GyCq"

# Optional: disable colors
export NO_COLOR=1
```

## Debugging

- Use `--verbose` or `-v` flag with trade.js for detailed logs
- Check on-chain logs: Program emits `TradeSnapshot` events with all market state
- Logs show BTC price (≤4 decimals) and timestamp on every trade
- Use `--audit` mode to track exact PnL per user across all operations
- Test different scenarios with run2.sh, run3.sh, run4.sh scripts

## Key Files

- `programs/cpi_oracle/src/lib.rs` - Main Solana program (1040 lines)
- `app/trade.js` - Primary CLI client and trading simulator
- `Anchor.toml` - Anchor framework configuration
- `run.sh` - Complete market lifecycle example
- User keypairs: `userA.json` through `userE.json`
