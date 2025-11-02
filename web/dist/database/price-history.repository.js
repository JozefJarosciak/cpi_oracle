"use strict";
/**
 * Price history repository - handles price data storage and retrieval
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PriceHistoryRepository = void 0;
/**
 * Repository for managing price history data
 */
class PriceHistoryRepository {
    constructor(db) {
        this.db = db;
    }
    /**
     * Get total count of price records
     */
    count() {
        try {
            const result = this.db.prepare('SELECT COUNT(*) as count FROM price_history').get();
            return result.count;
        }
        catch (err) {
            console.error('Failed to get price count:', err.message);
            return 0;
        }
    }
    /**
     * Find price history records with optional filters
     */
    find(options = {}) {
        try {
            let query = 'SELECT price, timestamp FROM price_history';
            const params = [];
            // Add time range filter
            if (options.seconds) {
                const cutoffTime = Date.now() - (options.seconds * 1000);
                query += ' WHERE timestamp >= ?';
                params.push(cutoffTime);
            }
            // Add ordering
            query += ' ORDER BY timestamp ASC';
            // Add pagination
            if (options.limit) {
                query += ' LIMIT ?';
                params.push(options.limit);
            }
            if (options.offset) {
                query += ' OFFSET ?';
                params.push(options.offset);
            }
            const stmt = this.db.prepare(query);
            return stmt.all(...params);
        }
        catch (err) {
            console.error('Failed to query price history:', err.message);
            return [];
        }
    }
    /**
     * Insert a new price record
     */
    insert(price, timestamp = Date.now()) {
        try {
            const stmt = this.db.prepare('INSERT INTO price_history (price, timestamp) VALUES (?, ?)');
            stmt.run(price, timestamp);
            return true;
        }
        catch (err) {
            console.error('Failed to add price:', err.message);
            return false;
        }
    }
    /**
     * Delete old price records beyond the retention period
     */
    cleanup(maxAgeHours) {
        try {
            const cutoffTime = Date.now() - (maxAgeHours * 60 * 60 * 1000);
            const stmt = this.db.prepare('DELETE FROM price_history WHERE timestamp < ?');
            const result = stmt.run(cutoffTime);
            if (result.changes > 0) {
                console.log(`Cleaned up ${result.changes} old price records`);
            }
            return result.changes;
        }
        catch (err) {
            console.error('Failed to cleanup old prices:', err.message);
            return 0;
        }
    }
    /**
     * Get the most recent price
     */
    getLatest() {
        try {
            const stmt = this.db.prepare('SELECT price, timestamp FROM price_history ORDER BY timestamp DESC LIMIT 1');
            return stmt.get() || null;
        }
        catch (err) {
            console.error('Failed to get latest price:', err.message);
            return null;
        }
    }
    /**
     * Get price history for a specific time range
     */
    findByTimeRange(startTime, endTime) {
        try {
            const stmt = this.db.prepare('SELECT price, timestamp FROM price_history WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC');
            return stmt.all(startTime, endTime);
        }
        catch (err) {
            console.error('Failed to query price history by time range:', err.message);
            return [];
        }
    }
}
exports.PriceHistoryRepository = PriceHistoryRepository;
//# sourceMappingURL=price-history.repository.js.map