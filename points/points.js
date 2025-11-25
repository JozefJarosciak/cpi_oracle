// points/points.js — SQLite-based points system
// Points are awarded for deposits, trades, and wins

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Point multipliers (configurable)
const POINTS_CONFIG = {
    // Deposit: 1 point per 0.1 XNT deposited (10 points per XNT)
    DEPOSIT_POINTS_PER_XNT: 10,

    // Trade: 1 point per 1 share traded
    TRADE_POINTS_PER_SHARE: 1,

    // Win: 2 points per 0.1 XNT won (20 points per XNT)
    WIN_POINTS_PER_XNT: 20,
};

// Conversion constants (must match program)
const LAMPORTS_PER_E6 = 100;
const E6_PER_XNT = 10_000_000;
const LAMPORTS_PER_XNT = E6_PER_XNT * LAMPORTS_PER_E6;

class PointsDB {
    constructor(dbPath = null) {
        const defaultPath = path.join(__dirname, 'points.db');
        this.dbPath = dbPath || defaultPath;
        this.db = new Database(this.dbPath);
        this.db.pragma('journal_mode = WAL');
        this._initSchema();
    }

    _initSchema() {
        const schemaPath = path.join(__dirname, 'schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf8');
        this.db.exec(schema);
    }

    // ============= POINT CALCULATIONS =============

    calculateDepositPoints(amountLamports) {
        const xnt = amountLamports / LAMPORTS_PER_XNT;
        return Math.floor(xnt * POINTS_CONFIG.DEPOSIT_POINTS_PER_XNT);
    }

    calculateTradePoints(sharesE6) {
        const shares = sharesE6 / 1_000_000;
        return Math.floor(shares * POINTS_CONFIG.TRADE_POINTS_PER_SHARE);
    }

    calculateWinPoints(payoutLamports) {
        const xnt = payoutLamports / LAMPORTS_PER_XNT;
        return Math.floor(xnt * POINTS_CONFIG.WIN_POINTS_PER_XNT);
    }

    // ============= RECORD EVENTS =============

    recordDeposit(masterPubkey, amountLamports, txSignature = null, marketId = null) {
        const points = this.calculateDepositPoints(amountLamports);
        if (points <= 0) return { points: 0, eventId: null };

        const stmt = this.db.prepare(`
            INSERT INTO point_events (master_pubkey, event_type, points, tx_signature, amount_lamports, market_id)
            VALUES (?, 'deposit', ?, ?, ?, ?)
        `);
        const result = stmt.run(masterPubkey, points, txSignature, amountLamports, marketId);
        return { points, eventId: result.lastInsertRowid };
    }

    recordTrade(masterPubkey, sharesE6, side, direction, txSignature = null, marketId = null) {
        const points = this.calculateTradePoints(sharesE6);
        if (points <= 0) return { points: 0, eventId: null };

        const stmt = this.db.prepare(`
            INSERT INTO point_events (master_pubkey, event_type, points, tx_signature, shares_e6, side, direction, market_id)
            VALUES (?, 'trade', ?, ?, ?, ?, ?, ?)
        `);
        const result = stmt.run(masterPubkey, points, txSignature, sharesE6, side, direction, marketId);
        return { points, eventId: result.lastInsertRowid };
    }

    recordWin(masterPubkey, payoutLamports, txSignature = null, marketId = null) {
        const points = this.calculateWinPoints(payoutLamports);
        if (points <= 0) return { points: 0, eventId: null };

        const stmt = this.db.prepare(`
            INSERT INTO point_events (master_pubkey, event_type, points, tx_signature, payout_lamports, market_id)
            VALUES (?, 'win', ?, ?, ?, ?)
        `);
        const result = stmt.run(masterPubkey, points, txSignature, payoutLamports, marketId);
        return { points, eventId: result.lastInsertRowid };
    }

    // ============= QUERIES =============

    getUser(masterPubkey) {
        const stmt = this.db.prepare(`
            SELECT * FROM users WHERE master_pubkey = ?
        `);
        return stmt.get(masterPubkey) || null;
    }

    getUserPoints(masterPubkey) {
        const user = this.getUser(masterPubkey);
        return user ? user.total_points : 0;
    }

    getUserHistory(masterPubkey, limit = 50) {
        const stmt = this.db.prepare(`
            SELECT * FROM point_events
            WHERE master_pubkey = ?
            ORDER BY created_at DESC
            LIMIT ?
        `);
        return stmt.all(masterPubkey, limit);
    }

    getLeaderboard(limit = 100) {
        const stmt = this.db.prepare(`
            SELECT master_pubkey, total_points, deposit_points, trade_points, win_points, updated_at
            FROM users
            ORDER BY total_points DESC
            LIMIT ?
        `);
        return stmt.all(limit);
    }

    getUserRank(masterPubkey) {
        const stmt = this.db.prepare(`
            SELECT COUNT(*) + 1 as rank
            FROM users
            WHERE total_points > (SELECT COALESCE(total_points, 0) FROM users WHERE master_pubkey = ?)
        `);
        const result = stmt.get(masterPubkey);
        return result ? result.rank : null;
    }

    getTotalUsers() {
        const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM users`);
        return stmt.get().count;
    }

    getTotalPoints() {
        const stmt = this.db.prepare(`SELECT COALESCE(SUM(total_points), 0) as total FROM users`);
        return stmt.get().total;
    }

    getStats() {
        const stmt = this.db.prepare(`
            SELECT
                COUNT(*) as total_users,
                COALESCE(SUM(total_points), 0) as total_points,
                COALESCE(SUM(deposit_points), 0) as total_deposit_points,
                COALESCE(SUM(trade_points), 0) as total_trade_points,
                COALESCE(SUM(win_points), 0) as total_win_points
            FROM users
        `);
        return stmt.get();
    }

    // Check if tx signature already recorded (prevent duplicates)
    txExists(txSignature) {
        if (!txSignature) return false;
        const stmt = this.db.prepare(`
            SELECT 1 FROM point_events WHERE tx_signature = ? LIMIT 1
        `);
        return stmt.get(txSignature) !== undefined;
    }

    close() {
        this.db.close();
    }
}

module.exports = { PointsDB, POINTS_CONFIG };

// CLI usage
if (require.main === module) {
    const db = new PointsDB();
    const args = process.argv.slice(2);
    const cmd = args[0];

    switch (cmd) {
        case 'leaderboard':
            const limit = parseInt(args[1]) || 20;
            const leaders = db.getLeaderboard(limit);
            console.log('\n=== POINTS LEADERBOARD ===\n');
            console.log('Rank  | Points    | Pubkey');
            console.log('------|-----------|' + '-'.repeat(50));
            leaders.forEach((u, i) => {
                const pubkey = u.master_pubkey.slice(0, 8) + '...' + u.master_pubkey.slice(-4);
                console.log(`#${(i+1).toString().padStart(4)} | ${u.total_points.toString().padStart(9)} | ${pubkey}`);
            });
            console.log(`\nTotal users: ${db.getTotalUsers()}`);
            break;

        case 'user':
            const pubkey = args[1];
            if (!pubkey) {
                console.log('Usage: node points.js user <pubkey>');
                process.exit(1);
            }
            const user = db.getUser(pubkey);
            if (!user) {
                console.log('User not found');
            } else {
                console.log('\n=== USER POINTS ===');
                console.log(`Pubkey: ${pubkey}`);
                console.log(`Total:    ${user.total_points}`);
                console.log(`Deposits: ${user.deposit_points}`);
                console.log(`Trades:   ${user.trade_points}`);
                console.log(`Wins:     ${user.win_points}`);
                console.log(`Rank:     #${db.getUserRank(pubkey)}`);
            }
            break;

        case 'stats':
            const stats = db.getStats();
            console.log('\n=== POINTS STATS ===');
            console.log(`Total Users:    ${stats.total_users}`);
            console.log(`Total Points:   ${stats.total_points}`);
            console.log(`From Deposits:  ${stats.total_deposit_points}`);
            console.log(`From Trades:    ${stats.total_trade_points}`);
            console.log(`From Wins:      ${stats.total_win_points}`);
            break;

        case 'test':
            // Add test data
            console.log('Adding test data...');
            const testPubkey = 'TestUser' + Date.now();
            db.recordDeposit(testPubkey, 10 * LAMPORTS_PER_XNT, 'test_deposit_sig');
            db.recordTrade(testPubkey, 100_000_000, 'yes', 'buy', 'test_trade_sig');
            db.recordWin(testPubkey, 5 * LAMPORTS_PER_XNT, 'test_win_sig');
            const testUser = db.getUser(testPubkey);
            console.log('Test user:', testUser);
            break;

        default:
            console.log('Usage: node points.js <command>');
            console.log('Commands:');
            console.log('  leaderboard [limit]  - Show top users by points');
            console.log('  user <pubkey>        - Show user points');
            console.log('  stats                - Show global stats');
            console.log('  test                 - Add test data');
    }

    db.close();
}
