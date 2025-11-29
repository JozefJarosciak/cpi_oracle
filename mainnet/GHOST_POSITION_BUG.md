# Ghost Position Bug - Trade Monitor Race Condition

## Status: FIXED (2025-11-29)

## Problem Summary

Users are receiving payouts for positions that don't appear in their trading history. These "ghost positions" exist on-chain but are not recorded in the database.

## Example Case

**User:** 61sKon
**Date:** 2025-11-29

Settlement log showed:
```
Redeeming for 61sKon47... (UP: 12.00, DOWN: 0.00)
Expected payout: 6.1177 XNT
```

But trading_history for that cycle showed:
- BUY 10 UP shares
- SELL 10 UP shares
- **Net: 0 shares** (not 12)

The 12 shares came from trades logged as "Unknown":
```
01:54:11: Unkno BUY YES: 6.00 shares @ 0.5150 XNT
01:54:11: Unkno BUY YES: 6.00 shares @ 0.5180 XNT
```

## Root Cause

Race condition in `trade_monitor.js` (lines 655-668):

```javascript
const tx = await connection.getTransaction(logs.signature, {
    maxSupportedTransactionVersion: 0
});
if (tx && tx.transaction && tx.transaction.message) {
    const accountKeys = tx.transaction.message.getAccountKeys();
    const feePayer = accountKeys.get(0);
    userPubkey = feePayer ? feePayer.toString() : 'Unknown';
}
```

The `onLogs` callback fires immediately when logs are received from the RPC, but `getTransaction()` may return `null` if the RPC hasn't fully indexed the transaction yet.

When this happens:
1. `userPubkey` remains `'Unknown'`
2. The trade is logged to console but NOT saved to `trading_history` (line 714-716)
3. Cumulative volume IS updated (line 705-711)
4. On-chain position IS updated (blockchain state)

## Impact

1. **Incorrect P&L calculations** - settlement uses trading_history to calculate cost basis
2. **Free money** - users get payouts for positions with $0 recorded cost
3. **Leaderboard inaccuracy** - win/loss records don't reflect actual trading
4. **Audit trail gaps** - on-chain activity not reflected in database

## Evidence in Logs

Successful trade (user identified):
```
01:52:20: 9BC2h BUY NO: 2.00 shares @ 0.5005 XNT
01:52:20: [POS] 9BC2ho DOWN: +2.00 shares @ ...
01:52:20: [POINTS] +2 trade points to 9BC2ho (buy no)
01:52:20: Cumulative volume updated: NO +1.0035 XNT
01:52:20: Trading history saved for 9BC2ho        <-- SAVED
```

Failed trade (user not identified):
```
01:54:11: Unkno BUY YES: 6.00 shares @ 0.5150 XNT
01:54:11: Cumulative volume updated: YES +3.0977 XNT
                                                   <-- NO "Trading history saved" message
```

## Fix Applied

Added retry logic with exponential backoff in `trade_monitor.js`:

```javascript
async function getTransactionWithRetry(connection, signature, maxRetries = 5) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const tx = await connection.getTransaction(signature, {
                maxSupportedTransactionVersion: 0
            });
            if (tx) return tx;

            // Wait before retry: 100ms, 200ms, 400ms, 800ms, 1600ms
            const delay = 100 * Math.pow(2, i);
            if (i < maxRetries - 1) {
                await new Promise(r => setTimeout(r, delay));
            }
        } catch (err) {
            console.error(`[RETRY ${i + 1}/${maxRetries}] Failed to fetch tx:`, err.message);
            if (i < maxRetries - 1) {
                await new Promise(r => setTimeout(r, 100 * Math.pow(2, i)));
            }
        }
    }
    console.error(`[RETRY] All ${maxRetries} attempts failed for tx ${signature.slice(0, 8)}`);
    return null;
}
```

**Total retry time:** ~3.1 seconds (100 + 200 + 400 + 800 + 1600ms)

## Temporary Mitigation

The `cycle_positions` table was added to track positions in real-time right after orders are filled. This provides an independent record to compare against on-chain state:

```
GET /api/cycle-positions
GET /api/cycle-positions/:userPrefix
```

## Files Involved

- `/home/ubuntu/dev/cpi_oracle_mainnet/web/trade_monitor.js` - Main monitoring logic
- `/home/ubuntu/dev/cpi_oracle_mainnet/web/server.js` - Trading history storage
- `/home/ubuntu/dev/cpi_oracle_mainnet/web/price_history.db` - SQLite database

## Related Issues

- Settlement calculates cost basis from trading_history only
- Points system awards "win points" based on profit calculation using trading_history
- Leaderboard shows incorrect statistics when trades are missed
