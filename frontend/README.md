# BTC Prediction Market - Frontend

A retro VT100-style terminal interface for the Solana-based Bitcoin prediction market.

## Features

- 🔌 **Wallet Integration**: Connect with Backpack, Phantom, or Solflare
- 💼 **Session Accounts**: Fund a session account for gasless trading
- 📊 **Oracle Display**: Real-time BTC price from on-chain oracle
- 🎮 **Market Controls**: Initialize, snapshot, stop, and resolve markets
- 📈 **Position Tracking**: View your YES/NO share holdings
- 🖥️ **VT100 Theme**: Classic green phosphor terminal aesthetic

## Quick Start

### Prerequisites

- Node.js 18+ and npm/yarn
- Local Solana validator running (or update RPC endpoint)
- Deployed prediction market program
- Oracle program with BTC price feed

### Installation

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.local.example .env.local

# Update .env.local with your program IDs and oracle state
```

### Environment Variables

Edit `.env.local`:

```env
NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8899
NEXT_PUBLIC_PROGRAM_ID=EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF
NEXT_PUBLIC_ORACLE_PROGRAM_ID=7ARBeYF5rGCanAGiRaxhVpiuZZpGXazo5UJqHMoJgkuE
NEXT_PUBLIC_ORACLE_STATE=<your_oracle_state_pubkey>
NEXT_PUBLIC_AMM_SEED=amm_btc_v3
NEXT_PUBLIC_LAMPORTS_PER_E6=100
```

### Development

```bash
# Start development server (runs on port 3434)
npm run dev

# Build for production
npm run build

# Start production server (runs on port 3434)
npm start
```

Open [http://localhost:3434](http://localhost:3434) in your browser.

## Usage Flow

1. **Connect Wallet**: Click the wallet button to connect (Backpack/Phantom/Solflare)
2. **Create Session**: Create a session account for gasless trading
3. **Fund Session**: Deposit SOL from your main wallet to the session account
4. **Initialize Market**: Set liquidity (b) and fee parameters, then initialize
5. **Snapshot Start**: Record the starting BTC price from oracle
6. **Trade**: (CLI for now - UI coming soon)
7. **Stop Market**: Halt trading when ready
8. **Resolve**: Compare current oracle price to start price, determine winner
9. **Redeem**: Winners claim their payouts
10. **Withdraw**: Transfer remaining session SOL back to main wallet

## Architecture

### Session Account Pattern

The webapp uses a "session account" pattern to avoid requiring user signatures for every trade:

- User connects with main wallet (Backpack/Phantom)
- User creates a session keypair (stored in browser localStorage)
- User funds the session account with SOL
- All trades are signed by the session keypair (no approval needed)
- User can withdraw funds back to main wallet at any time

**Security Note**: Session keypairs are stored in browser localStorage. Only fund with amounts you're comfortable having in browser storage. For production, consider using Solana session keys or similar solutions.

### Components

- `WalletProvider.tsx`: Solana wallet adapter integration
- `SessionAccount.tsx`: Session account creation, deposit, withdraw
- `MarketControls.tsx`: Initialize, snapshot, stop, resolve market
- `OracleDisplay.tsx`: Live BTC price from oracle
- `PositionDisplay.tsx`: User's YES/NO share holdings

### Utilities

- `lib/constants.ts`: Program IDs, seeds, conversion constants
- `lib/sessionAccount.ts`: Session keypair management
- `lib/program.ts`: Anchor program client helpers

## Styling

The UI uses a VT100 terminal aesthetic with:

- Classic green phosphor (#00FF00) on black (#000000)
- Monospace fonts (Courier New)
- Text glow effects
- Scanline overlays
- Terminal-style borders and buttons

Customize colors in `tailwind.config.ts` and `app/globals.css`.

## Trading (CLI Integration)

The frontend currently focuses on market administration. For trading:

```bash
# From project root
cd ..

# Use CLI tools to trade
ANCHOR_WALLET=./userA.json node app/trade.js buy yes 1000000

# Or use session account from frontend
# (extract session keypair from browser localStorage)
```

A full trading UI will be added in future iterations.

## Troubleshooting

### "Oracle account not found"

- Verify `NEXT_PUBLIC_ORACLE_STATE` in `.env.local`
- Ensure oracle program is deployed and state account exists

### "Program account not found"

- Verify `NEXT_PUBLIC_PROGRAM_ID` matches deployed program
- Ensure you're connected to the correct network (localhost/devnet)

### Wallet won't connect

- Check that Backpack/Phantom extension is installed
- Ensure wallet is set to correct network (localhost/devnet)
- Try refreshing the page

### Market initialization fails

- Ensure session account has sufficient SOL
- Check program logs: `solana logs` in another terminal
- Verify AMM seed matches program: `NEXT_PUBLIC_AMM_SEED=amm_btc_v3`

## Future Enhancements

- [ ] Full trading interface (buy/sell YES/NO)
- [ ] Trade history and analytics
- [ ] Multiple market support
- [ ] Advanced charting
- [ ] Mobile responsive design
- [ ] Session key delegation (Solana session keys spec)

## License

MIT
