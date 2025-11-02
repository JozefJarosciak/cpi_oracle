"use strict";
/**
 * History repository - handles settlement and trading history
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.HistoryRepository = void 0;
/**
 * Repository for managing settlement and trading history
 */
class HistoryRepository {
    constructor(db) {
        this.db = db;
    }
    // ==================== Settlement History ====================
    /**
     * Add a settlement record
     */
    addSettlement(userPrefix, result, amount, side, snapshotPrice = null, settlePrice = null) {
        try {
            const timestamp = Date.now();
            // Get timestamp of last settlement for this user to determine cycle boundary
            let cycleStartTime = 0;
            const lastSettlementStmt = this.db.prepare('SELECT timestamp FROM settlement_history WHERE user_prefix = ? ORDER BY timestamp DESC LIMIT 1');
            const lastSettlement = lastSettlementStmt.get(userPrefix);
            if (lastSettlement) {
                cycleStartTime = lastSettlement.timestamp;
            }
            // Calculate total buys, sells, and net spent from trading history SINCE LAST SETTLEMENT
            let totalBuys = 0;
            let totalSells = 0;
            const tradingStmt = this.db.prepare('SELECT action, cost_usd FROM trading_history WHERE user_prefix = ? AND timestamp > ? AND timestamp <= ? ORDER BY timestamp ASC');
            const trades = tradingStmt.all(userPrefix, cycleStartTime, timestamp);
            for (const trade of trades) {
                if (trade.action === 'BUY') {
                    totalBuys += trade.cost_usd;
                }
                else if (trade.action === 'SELL') {
                    totalSells += trade.cost_usd;
                }
            }
            const netSpent = totalBuys - totalSells;
            const stmt = this.db.prepare('INSERT INTO settlement_history (user_prefix, result, amount, side, timestamp, snapshot_price, settle_price, total_buys, total_sells, net_spent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
            stmt.run(userPrefix, result, amount, side, timestamp, snapshotPrice, settlePrice, totalBuys, totalSells, netSpent);
            return true;
        }
        catch (err) {
            console.error('Failed to add settlement:', err.message);
            return false;
        }
    }
    /**
     * Get settlement history (most recent first)
     */
    getSettlements(limit = 100) {
        try {
            const stmt = this.db.prepare('SELECT * FROM settlement_history ORDER BY timestamp DESC LIMIT ?');
            return stmt.all(limit);
        }
        catch (err) {
            console.error('Failed to get settlement history:', err.message);
            return [];
        }
    }
    /**
     * Get settlement history for a specific user
     */
    getSettlementsByUser(userPrefix, limit = 100) {
        try {
            const stmt = this.db.prepare('SELECT * FROM settlement_history WHERE user_prefix = ? ORDER BY timestamp DESC LIMIT ?');
            return stmt.all(userPrefix, limit);
        }
        catch (err) {
            console.error('Failed to get user settlement history:', err.message);
            return [];
        }
    }
    /**
     * Clean up old settlement records
     */
    cleanupSettlements(maxAgeHours) {
        try {
            const cutoffTime = Date.now() - (maxAgeHours * 60 * 60 * 1000);
            const stmt = this.db.prepare('DELETE FROM settlement_history WHERE timestamp < ?');
            const result = stmt.run(cutoffTime);
            if (result.changes > 0) {
                console.log(`Cleaned up ${result.changes} old settlement records`);
            }
            return result.changes;
        }
        catch (err) {
            console.error('Failed to cleanup old settlements:', err.message);
            return 0;
        }
    }
    // ==================== Trading History ====================
    /**
     * Add a trading record
     */
    addTrade(userPrefix, action, side, shares, costUsd, avgPrice, pnl = null) {
        try {
            const stmt = this.db.prepare('INSERT INTO trading_history (user_prefix, action, side, shares, cost_usd, avg_price, pnl, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
            stmt.run(userPrefix, action, side, shares, costUsd, avgPrice, pnl, Date.now());
            return true;
        }
        catch (err) {
            console.error('Failed to add trading history:', err.message);
            return false;
        }
    }
    /**
     * Get trading history for a specific user
     */
    getTradesByUser(userPrefix, limit = 100) {
        try {
            const stmt = this.db.prepare('SELECT * FROM trading_history WHERE user_prefix = ? ORDER BY timestamp DESC LIMIT ?');
            return stmt.all(userPrefix, limit);
        }
        catch (err) {
            console.error('Failed to get trading history:', err.message);
            return [];
        }
    }
    /**
     * Get all trading history (most recent first)
     */
    getAllTrades(limit = 100) {
        try {
            const stmt = this.db.prepare('SELECT * FROM trading_history ORDER BY timestamp DESC LIMIT ?');
            return stmt.all(limit);
        }
        catch (err) {
            console.error('Failed to get all trading history:', err.message);
            return [];
        }
    }
    /**
     * Clean up old trading records
     */
    cleanupTrades(maxAgeHours) {
        try {
            const cutoffTime = Date.now() - (maxAgeHours * 60 * 60 * 1000);
            const stmt = this.db.prepare('DELETE FROM trading_history WHERE timestamp < ?');
            const result = stmt.run(cutoffTime);
            if (result.changes > 0) {
                console.log(`Cleaned up ${result.changes} old trading records`);
            }
            return result.changes;
        }
        catch (err) {
            console.error('Failed to cleanup old trading history:', err.message);
            return 0;
        }
    }
}
exports.HistoryRepository = HistoryRepository;
//# sourceMappingURL=history.repository.js.map