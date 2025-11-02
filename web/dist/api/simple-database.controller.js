"use strict";
/**
 * Simplified Database Controller
 *
 * Provides basic type-safe wrappers for database repositories
 * Note: This is a thin wrapper - complex operations should use repositories directly
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SimpleDatabaseController = void 0;
const database_service_1 = require("../database/database.service");
const price_history_repository_1 = require("../database/price-history.repository");
const volume_repository_1 = require("../database/volume.repository");
const history_repository_1 = require("../database/history.repository");
const quote_history_repository_1 = require("../database/quote-history.repository");
/**
 * Simplified Database Controller
 *
 * Use this for basic operations. For complex workflows, access repositories directly.
 */
class SimpleDatabaseController {
    constructor(config) {
        this.db = new database_service_1.DatabaseService({
            dbFile: config.dbPath,
            maxPriceHistoryHours: 24,
            maxSettlementHistoryHours: 720, // 30 days
            maxTradingHistoryHours: 720 // 30 days
        });
        // Expose repositories publicly for direct access
        this.priceRepo = new price_history_repository_1.PriceHistoryRepository(this.db.getDatabase());
        this.volumeRepo = new volume_repository_1.VolumeRepository(this.db.getDatabase());
        this.historyRepo = new history_repository_1.HistoryRepository(this.db.getDatabase());
        this.quoteRepo = new quote_history_repository_1.QuoteHistoryRepository(this.db.getDatabase());
    }
    /**
     * Get database statistics
     */
    getStats() {
        return this.db.getStats();
    }
    /**
     * Close database connection
     */
    close() {
        this.db.close();
    }
    /**
     * Get raw database instance
     */
    getDatabase() {
        return this.db.getDatabase();
    }
}
exports.SimpleDatabaseController = SimpleDatabaseController;
//# sourceMappingURL=simple-database.controller.js.map