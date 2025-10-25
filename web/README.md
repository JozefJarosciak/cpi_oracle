# BTC Prediction Market - Terminal UI

A terminal-style web interface for the Solana BTC Prediction Market with persistent session wallets.

## How It Works

### Session Wallet System

Instead of connecting Backpack every time, this uses a **deterministic session wallet** approach:

1. **Connect Backpack** - Click "CONNECT BACKPACK" button
2. **Sign Message** - Backpack asks you to sign a message (no gas, just signature)
3. **Session Created** - Your signature deterministically generates a session keypair
4. **Persist Across Refreshes** - The signature is saved, so the same session wallet is derived on every refresh

### Benefits

- **Same wallet every time** for a given Backpack address
- **No Phantom needed** - Works with Backpack
- **Persists across refreshes** - Your session wallet stays the same
- **Secure** - Private key never stored, only derived from your signature
- **Fundable** - You can send SOL to the session wallet and it will always be there

## Running

```bash
cd web
node server.js
```

Access at: http://localhost:3434

## Usage

1. **Connect Backpack**
   - Click "CONNECT BACKPACK"
   - Approve connection in Backpack
   - Sign the message (no fee)
   - Your session wallet is created!

2. **Fund Session Wallet**
   - Copy the session wallet address shown
   - Send SOL to it:
     ```bash
     solana transfer <SESSION_ADDRESS> 1 --allow-unfunded-recipient
     ```

3. **Trade**
   - Once funded, you can trade directly
   - The session wallet signs all transactions
   - No need to approve in Backpack each time!

4. **Refresh Page**
   - Your session automatically restores
   - Same session wallet, same balance
   - Just keep trading!

## Features

- ✓ Terminal-style CRT UI with scanlines
- ✓ Backpack wallet integration
- ✓ Persistent session wallets (deterministic from signature)
- ✓ Oracle BTC price display (triplet + median)
- ✓ Market state monitoring
- ✓ Trading (BUY/SELL YES/NO)
- ✓ Position tracking
- ✓ Market controls (Snapshot, Stop, Settle)
- ✓ Auto-refresh every 5 seconds

## Technical Details

**Session Derivation:**
- Backpack signs a message with timestamp
- First 32 bytes of signature = keypair seed
- Same Backpack address + signature = same session wallet
- Signature stored in localStorage (not private key!)

**Security:**
- Private key never touches localStorage
- Only signature is stored
- Keypair regenerated from signature on each load
- If you clear localStorage, just reconnect Backpack to recreate the same session

## Files

```
web/
├── server.js           # Simple HTTP server
├── package.json        # Minimal config
└── public/
    ├── index.html      # Terminal UI
    ├── style.css       # CRT styling
    └── app.js          # Logic (Backpack + session)
```

## Requirements

- Backpack wallet browser extension
- Local Solana validator running on 127.0.0.1:8899
- Node.js for the web server

That's it! No frameworks, no build process, just vanilla HTML/CSS/JS.
