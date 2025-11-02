"use strict";
/**
 * Quote history repository - handles LMSR quote snapshots per market cycle
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.QuoteHistoryRepository = void 0;
/**
 * Repository for managing quote (probability) history across market cycles
 */
class QuoteHistoryRepository {
    constructor(db) {
        this.db = db;
    }
    /**
     * Add a quote snapshot for a cycle
     */
    insert(cycleId, upPrice, downPrice) {
        try {
            const stmt = this.db.prepare('INSERT INTO quote_history (cycle_id, up_price, down_price, timestamp) VALUES (?, ?, ?, ?)');
            stmt.run(cycleId, upPrice, downPrice, Date.now());
            return true;
        }
        catch (err) {
            console.error('Failed to add quote snapshot:', err.message);
            return false;
        }
    }
    /**
     * Get quote history for a specific cycle
     */
    findByCycle(cycleId) {
        try {
            const stmt = this.db.prepare('SELECT up_price, down_price, timestamp FROM quote_history WHERE cycle_id = ? ORDER BY timestamp ASC');
            return stmt.all(cycleId);
        }
        catch (err) {
            console.error('Failed to get quote history:', err.message);
            return [];
        }
    }
    /**
     * Get list of recent cycles
     */
    getRecentCycles(limit = 10) {
        try {
            const stmt = this.db.prepare('SELECT DISTINCT cycle_id, cycle_start_time FROM volume_history ORDER BY cycle_start_time DESC LIMIT ?');
            return stmt.all(limit);
        }
        catch (err) {
            console.error('Failed to get recent cycles:', err.message);
            return [];
        }
    }
    /**
     * Clean up old quote history records
     */
    cleanup(maxAgeHours) {
        try {
            const cutoffTime = Date.now() - (maxAgeHours * 60 * 60 * 1000);
            const stmt = this.db.prepare('DELETE FROM quote_history WHERE timestamp < ?');
            const result = stmt.run(cutoffTime);
            if (result.changes > 0) {
                console.log(`Cleaned up ${result.changes} old quote history records`);
            }
            return result.changes;
        }
        catch (err) {
            console.error('Failed to cleanup old quote history:', err.message);
            return 0;
        }
    }
    /**
     * Get the most recent quote for a cycle
     */
    getLatestForCycle(cycleId) {
        try {
            const stmt = this.db.prepare('SELECT up_price, down_price, timestamp FROM quote_history WHERE cycle_id = ? ORDER BY timestamp DESC LIMIT 1');
            return stmt.get(cycleId) || null;
        }
        catch (err) {
            console.error('Failed to get latest quote:', err.message);
            return null;
        }
    }
    /**
     * Get quote count for a specific cycle
     */
    countByCycle(cycleId) {
        try {
            const result = this.db.prepare('SELECT COUNT(*) as count FROM quote_history WHERE cycle_id = ?').get(cycleId);
            return result.count;
        }
        catch (err) {
            console.error('Failed to count quotes for cycle:', err.message);
            return 0;
        }
    }
    /**
     * Get quote history for a time range within a cycle
     */
    findByCycleAndTimeRange(cycleId, startTime, endTime) {
        try {
            const stmt = this.db.prepare('SELECT up_price, down_price, timestamp FROM quote_history WHERE cycle_id = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC');
            return stmt.all(cycleId, startTime, endTime);
        }
        catch (err) {
            console.error('Failed to get quote history by time range:', err.message);
            return [];
        }
    }
}
exports.QuoteHistoryRepository = QuoteHistoryRepository;
//# sourceMappingURL=quote-history.repository.js.map