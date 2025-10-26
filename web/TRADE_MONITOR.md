# Live Trade Monitor

Real-time monitoring system that displays ALL user trades across the entire market, not just individual user trades.

## Architecture

```
┌─────────────────┐
│  Solana Chain   │ Emits TradeSnapshot events
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ trade_monitor.js│ Listens to program logs via RPC
│  (Node.js)      │ Parses trade events
└────────┬────────┘
         │ WebSocket (port 3435)
         │
         ▼
┌─────────────────┐
│  Web Frontend   │ Displays all trades in real-time
│  (proto1.html)  │ Shows BUY/SELL for ALL users
└─────────────────┘
```

## Features

✅ **Real-time Trade Feed**: See every trade from every user instantly
✅ **Historical Data**: Load last 100 trades on page load
✅ **Trade Details**: Action (BUY/SELL), Side (UP/DOWN), Shares, Price, Amount
✅ **Auto-Reconnect**: WebSocket reconnects automatically if disconnected
✅ **Persistent Storage**: Trades saved to `recent_trades.json`
✅ **Color-Coded**: Green for UP trades, Red for DOWN trades

## Components

### 1. Trade Monitor (`trade_monitor.js`)

**What it does:**
- Connects to Solana RPC endpoint
- Subscribes to program logs using `connection.onLogs(PROGRAM_ID)`
- Parses `TradeSnapshot` events from base64-encoded program data
- Broadcasts trades to all connected WebSocket clients
- Saves recent trades to disk

**Event Structure:**
```javascript
{
  side: 'YES' | 'NO',      // Trading side
  action: 'BUY' | 'SELL',  // Trade action
  amount: '10.50',         // XNT spent/received
  shares: '15.23',         // Shares bought/sold
  avgPrice: '0.6890',      // Average price per share
  signature: '4dQTe8k...', // Transaction signature
  timestamp: 1234567890    // Unix timestamp
}
```

### 2. WebSocket Server (Built into trade_monitor.js)

- Runs on port **3435**
- Sends two message types:
  - `{ type: 'history', trades: [...] }` - Initial history on connect
  - `{ type: 'trade', trade: {...} }` - New trade event

### 3. Frontend Integration (proto1.html)

**Added WebSocket client:**
- Connects to `ws://localhost:3435`
- Receives real-time trade updates
- Displays in existing trade history UI
- Auto-reconnects on disconnect

## Usage

### Start Both Services

```bash
cd web
./start_with_monitor.sh
```

This starts:
- **Trade Monitor** (WebSocket on port 3435)
- **Web Server** (HTTP on port 3434)

### Start Individually

**Option 1: With trade monitor**
```bash
# Terminal 1: Trade Monitor
cd web
node trade_monitor.js

# Terminal 2: Web Server
cd web
node server.js
```

**Option 2: Web only (no live trades)**
```bash
cd web
./start.sh  # or node server.js
```

### Access the UI

Open browser to: **http://localhost:3434/proto1**

You'll see:
- Live Trades section on the left
- Trade counter showing total trades
- Color-coded trade cards with:
  - BUY UP / BUY DOWN / SELL UP / SELL DOWN
  - Shares amount
  - Price per share
  - Total cost
  - Timestamp

## How It Works

### 1. On-Chain Trade Execution

When ANY user executes a trade:

```rust
// In smart contract (lib.rs:887)
emit!(TradeSnapshot {
    side, action,
    net_e6, dq_e6,
    avg_price_e6: (avg_h * 1_000_000.0).round() as i64,
    q_yes: amm.q_yes, q_no: amm.q_no,
    vault_e6: amm.vault_e6,
    p_yes_e6, btc_price_e6,
    snapshot_ts: amm.start_ts,
});
```

### 2. Monitor Detects Event

```javascript
// trade_monitor.js
connection.onLogs(PROGRAM_ID, (logs, context) => {
    const trade = parseTradeFromLogs(logs.logs, logs.signature);
    if (trade) {
        broadcastTrade(trade);  // Send to all WebSocket clients
        saveTrades();           // Persist to disk
    }
});
```

### 3. Frontend Receives & Displays

```javascript
// proto1.html
tradeSocket.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'trade') {
        addTradeToHistory(data.trade);  // Add to UI
    }
};
```

## Trade Data Flow

```
User A executes trade → Smart contract emits event
                            ↓
                    Solana RPC logs
                            ↓
                    trade_monitor.js detects
                            ↓
                    Parse TradeSnapshot
                            ↓
                    Broadcast via WebSocket
                            ↓
        ┌───────────────────┴───────────────────┐
        ↓                                       ↓
   Browser 1                               Browser 2
   (User A's view)                         (User B's view)
   Shows ALL trades                        Shows ALL trades
```

## Configuration

**Environment Variables:**
```bash
# RPC endpoint (default: testnet)
RPC_URL=https://rpc.testnet.x1.xyz

# Program to monitor
PROGRAM_ID=EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF

# WebSocket port (default: 3435)
WS_PORT=3435
```

**Trade Storage:**
- File: `web/public/recent_trades.json`
- Max trades: 100 (configurable via `MAX_TRADES`)
- Format: JSON array of trade objects

## Testing

### 1. Start Services
```bash
cd web
./start_with_monitor.sh
```

### 2. Execute Test Trades
```bash
# In another terminal
ANCHOR_WALLET=./userA.json node app/trade.js buy YES 10
ANCHOR_WALLET=./userB.json node app/trade.js buy NO 5
```

### 3. Watch Live Feed
- Open http://localhost:3434/proto1
- Check browser console for WebSocket messages
- See trades appear in "Live Trades" section

## Troubleshooting

**WebSocket connection fails:**
- Check trade_monitor.js is running
- Verify port 3435 is not blocked
- Check browser console for errors

**No trades appearing:**
- Ensure RPC_URL is correct
- Check trade_monitor.js logs for parsing errors
- Verify PROGRAM_ID matches deployed contract

**Old trades not loading:**
- Check `recent_trades.json` exists
- Verify file has valid JSON
- Check file permissions

## Production Deployment

For production, consider:

1. **Use wss:// (secure WebSocket)** for HTTPS sites
2. **Add authentication** to WebSocket connections
3. **Rate limiting** on trade storage
4. **Database** instead of JSON file for persistence
5. **Load balancing** for multiple monitor instances
6. **Health checks** and auto-restart on failure

## Files

- `web/trade_monitor.js` - Main monitor service (182 lines)
- `web/start_with_monitor.sh` - Convenience startup script
- `web/public/proto1.html` - Frontend with WebSocket client
- `web/public/recent_trades.json` - Persisted trade history
- `web/TRADE_MONITOR.md` - This documentation

## Future Enhancements

- [ ] Show actual user addresses (extract from transaction)
- [ ] Filter trades by side (UP/DOWN) or action (BUY/SELL)
- [ ] Trade volume statistics
- [ ] Price charts based on trade history
- [ ] Export trades to CSV
- [ ] Trade alerts/notifications
- [ ] User rankings/leaderboard
