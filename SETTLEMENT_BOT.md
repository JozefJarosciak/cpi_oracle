# Settlement Bot - Automated Market Cycles

The settlement bot automatically runs 10-minute prediction market cycles:

## Cycle Structure

Each 10-minute cycle consists of:
1. **5 minutes ACTIVE** - Market is open for trading
2. **Stop & Settle** - Market closes and settles based on oracle price
3. **5 minutes WAITING** - Cool-down period before next cycle

## Features

- Markets start on minutes ending in **0** (e.g., 19:30, 19:40, 19:50, 20:00)
- Automatic market initialization with snapshot
- Automatic stop and settlement via oracle
- Real-time status updates to webpage
- Continuous operation with error recovery

## Running the Bot

### Prerequisites

1. Set environment variables:
```bash
export ORACLE_STATE=4KYeNyv1B9YjjQkfJk2C6Uqo71vKzFZriRe5NXg6GyCq
export ANCHOR_WALLET=./operator.json
export ANCHOR_PROVIDER_URL=https://rpc.testnet.x1.xyz
```

2. Ensure operator wallet has sufficient funds

### Start the Bot

```bash
node app/settlement_bot.js
```

Or run in background with nohup:
```bash
nohup node app/settlement_bot.js > settlement.log 2>&1 &
```

### Monitor the Bot

Check the log output:
```bash
tail -f settlement.log
```

Check status file:
```bash
cat market_status.json
```

### Stop the Bot

Find the process:
```bash
ps aux | grep settlement_bot
```

Kill it:
```bash
kill <PID>
```

## Status File

The bot writes to `market_status.json` every 10 seconds with:

```json
{
  "state": "ACTIVE",           // ACTIVE, WAITING, or ERROR
  "cycleStartTime": 1234567890,
  "marketEndTime": 1234567890,
  "nextCycleStartTime": 1234567890,
  "timeRemaining": 180000,     // milliseconds
  "lastUpdate": 1234567890
}
```

## Web Interface Integration

The webpage automatically:
- Fetches status every 1 second
- Shows market state (ACTIVE/WAITING/OFFLINE)
- Displays countdown timer
- Updates in real-time

## Timing Details

- **Cycle starts**: Next minute ending in 0 (e.g., if current time is 19:37, next start is 19:40)
- **Market duration**: Exactly 5 minutes
- **Wait duration**: Exactly 5 minutes
- **Total cycle**: Exactly 10 minutes
- **Update frequency**: Status file updated every 10 seconds

## Market Operations

The bot performs these operations automatically:

1. **Close existing market** (if any)
2. **Initialize new market** (b=500, fee=25bps)
3. **Take oracle snapshot** (records BTC price)
4. **Wait 5 minutes** (active trading period)
5. **Stop market** (halt trading)
6. **Settle by oracle** (compare current price to snapshot)
7. **Wait 5 minutes** (cool-down period)
8. **Repeat**

## Error Handling

- If any operation fails, the bot logs the error
- Status is set to "ERROR"
- Bot waits 30 seconds before retrying
- Continuous operation resumes after recovery

## Notes

- The bot must run continuously for proper timing
- Status file is crucial for web interface updates
- Oracle state must be set correctly
- Operator wallet must have funds for transactions
