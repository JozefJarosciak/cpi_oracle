// Backfill points from trading_history and settlement_history
// Usage: node backfill.js [--dry-run]

const Database = require('better-sqlite3');
const path = require('path');
const { PointsDB, POINTS_CONFIG } = require('./points.js');

const isDryRun = process.argv.includes('--dry-run');

// Open databases
const priceHistoryDb = new Database(path.join(__dirname, '../web/price_history.db'), { readonly: true });
const pointsDb = new PointsDB(path.join(__dirname, 'points.db'));

// Conversion constants (must match program)
const LAMPORTS_PER_E6 = 100;
const E6_PER_XNT = 10_000_000;
const LAMPORTS_PER_XNT = E6_PER_XNT * LAMPORTS_PER_E6;

console.log('=== POINTS BACKFILL ===');
console.log(`Mode: ${isDryRun ? 'DRY RUN' : 'LIVE'}`);
console.log(`Points config:`, POINTS_CONFIG);
console.log('');

// Get all trading history
const trades = priceHistoryDb.prepare(`
    SELECT user_prefix, action, side, shares, cost_usd, timestamp
    FROM trading_history
    ORDER BY timestamp ASC
`).all();

console.log(`Found ${trades.length} trades to process`);

// Get all settlement history (wins only for win points)
const settlements = priceHistoryDb.prepare(`
    SELECT user_prefix, result, amount, side, timestamp
    FROM settlement_history
    WHERE result = 'WIN'
    ORDER BY timestamp ASC
`).all();

console.log(`Found ${settlements.length} winning settlements to process`);
console.log('');

// Track points by user
const userPoints = {};

function addPoints(userPrefix, type, points) {
    if (!userPoints[userPrefix]) {
        userPoints[userPrefix] = { trade: 0, win: 0, total: 0 };
    }
    userPoints[userPrefix][type] += points;
    userPoints[userPrefix].total += points;
}

// Process trades - 1 point per share traded
console.log('Processing trades...');
let tradePointsTotal = 0;
for (const trade of trades) {
    // shares is already in normal units (not e6)
    const sharesE6 = Math.floor(trade.shares * 1_000_000);
    const points = Math.floor(trade.shares * POINTS_CONFIG.TRADE_POINTS_PER_SHARE);

    if (points > 0) {
        addPoints(trade.user_prefix, 'trade', points);
        tradePointsTotal += points;
    }
}
console.log(`  Trade points calculated: ${tradePointsTotal}`);

// Process wins - 20 points per XNT won
console.log('Processing wins...');
let winPointsTotal = 0;
for (const settlement of settlements) {
    // amount is in XNT
    const points = Math.floor(settlement.amount * POINTS_CONFIG.WIN_POINTS_PER_XNT);

    if (points > 0) {
        addPoints(settlement.user_prefix, 'win', points);
        winPointsTotal += points;
    }
}
console.log(`  Win points calculated: ${winPointsTotal}`);
console.log('');

// Show summary
const users = Object.entries(userPoints).sort((a, b) => b[1].total - a[1].total);
console.log(`=== SUMMARY: ${users.length} users ===`);
console.log('');
console.log('User      | Trade Pts | Win Pts   | Total');
console.log('----------|-----------|-----------|----------');
for (const [prefix, pts] of users) {
    console.log(`${prefix.padEnd(9)} | ${pts.trade.toString().padStart(9)} | ${pts.win.toString().padStart(9)} | ${pts.total.toString().padStart(9)}`);
}
console.log('');
console.log(`Total trade points: ${tradePointsTotal}`);
console.log(`Total win points:   ${winPointsTotal}`);
console.log(`Grand total:        ${tradePointsTotal + winPointsTotal}`);
console.log('');

if (isDryRun) {
    console.log('DRY RUN - No changes made. Run without --dry-run to apply.');
} else {
    console.log('Applying points to database...');

    // Clear existing backfilled events (those without tx_signature)
    const clearStmt = pointsDb.db.prepare(`
        DELETE FROM point_events WHERE tx_signature IS NULL OR tx_signature LIKE 'backfill_%'
    `);
    const cleared = clearStmt.run();
    console.log(`  Cleared ${cleared.changes} old backfill events`);

    // Insert new events
    let inserted = 0;
    for (const [userPrefix, pts] of users) {
        // Use prefix as the pubkey (since we don't have full pubkeys)
        const pubkey = userPrefix;

        if (pts.trade > 0) {
            const stmt = pointsDb.db.prepare(`
                INSERT INTO point_events (master_pubkey, event_type, points, tx_signature, shares_e6, side, direction)
                VALUES (?, 'trade', ?, ?, ?, 'mixed', 'mixed')
            `);
            stmt.run(pubkey, pts.trade, `backfill_trade_${userPrefix}`, pts.trade * 1_000_000);
            inserted++;
        }

        if (pts.win > 0) {
            const stmt = pointsDb.db.prepare(`
                INSERT INTO point_events (master_pubkey, event_type, points, tx_signature, payout_lamports)
                VALUES (?, 'win', ?, ?, ?)
            `);
            // Convert XNT won to lamports for the record
            const payoutLamports = Math.floor((pts.win / POINTS_CONFIG.WIN_POINTS_PER_XNT) * LAMPORTS_PER_XNT);
            stmt.run(pubkey, pts.win, `backfill_win_${userPrefix}`, payoutLamports);
            inserted++;
        }
    }
    console.log(`  Inserted ${inserted} point events`);

    // Verify
    const stats = pointsDb.getStats();
    console.log('');
    console.log('=== VERIFICATION ===');
    console.log(`Total users:  ${stats.total_users}`);
    console.log(`Total points: ${stats.total_points}`);
    console.log(`Trade points: ${stats.total_trade_points}`);
    console.log(`Win points:   ${stats.total_win_points}`);
}

// Cleanup
priceHistoryDb.close();
pointsDb.close();
console.log('');
console.log('Done!');
