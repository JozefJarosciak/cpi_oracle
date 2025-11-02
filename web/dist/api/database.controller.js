"use strict";
/**
 * Database Controller
 *
 * Provides type-safe API handlers for database operations:
 * - Price history
 * - Volume tracking
 * - Settlement history
 * - Trading history
 * - Quote snapshots
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DatabaseController = void 0;
const database_service_1 = require("../database/database.service");
const price_history_repository_1 = require("../database/price-history.repository");
const volume_repository_1 = require("../database/volume.repository");
const history_repository_1 = require("../database/history.repository");
const quote_history_repository_1 = require("../database/quote-history.repository");
/**
 * Database Controller
 *
 * Manages all database-related API operations with full type safety
 */
class DatabaseController {
    constructor(config) {
        this.db = new database_service_1.DatabaseService({ dbFile: config.dbPath });
        // Initialize repositories
        this.priceRepo = new price_history_repository_1.PriceHistoryRepository(this.db.getDatabase());
        this.volumeRepo = new volume_repository_1.VolumeRepository(this.db.getDatabase());
        this.historyRepo = new history_repository_1.HistoryRepository(this.db.getDatabase());
        this.quoteRepo = new quote_history_repository_1.QuoteHistoryRepository(this.db.getDatabase());
    }
    // ========================================================================
    // Price History Operations
    // ========================================================================
    /**
     * Get price history for a time range
     */
    async getPriceHistory(request) {
        try {
            const seconds = request.seconds || 3600; // Default: 1 hour
            const prices = this.priceRepo.find({ seconds });
            return {
                prices,
                totalPoints: prices.length,
                lastUpdate: prices.length > 0 ? prices[prices.length - 1].timestamp : 0
            };
        }
        catch (error) {
            console.error('Error getting price history:', error);
            return {
                prices: [],
                totalPoints: 0,
                lastUpdate: 0
            };
        }
    }
    /**
     * Add a new price record
     */
    async addPrice(request) {
        try {
            const timestamp = Date.now();
            this.priceRepo.insert(request.price, timestamp);
            return { success: true };
        }
        catch (error) {
            console.error('Error adding price:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }
    /**
     * Get current price (most recent)
     */
    async getCurrentPrice() {
        try {
            const latest = this.priceRepo.getLatest();
            if (!latest) {
                return {
                    price: null,
                    lastUpdate: null
                };
            }
            return {
                price: latest.price,
                lastUpdate: latest.timestamp
            };
        }
        catch (error) {
            console.error('Error getting current price:', error);
            return {
                price: null,
                lastUpdate: null
            };
        }
    }
    /**
     * Cleanup old price records
     */
    async cleanupOldPrices(retentionHours = 24) {
        try {
            return this.priceRepo.cleanup(retentionHours);
        }
        catch (error) {
            console.error('Error cleaning up prices:', error);
            return 0;
        }
    }
    // ========================================================================
    // Volume Operations
    // ========================================================================
    /**
     * Get cumulative volume for active cycle
     */
    async getVolume(cycleId) {
        try {
            const activeCycleId = cycleId || this.volumeRepo.getActiveCycleId();
            if (!activeCycleId) {
                return {
                    success: false,
                    error: 'No active cycle'
                };
            }
            const volume = this.volumeRepo.getVolume(activeCycleId);
            return {
                success: true,
                volume
            };
        }
        catch (error) {
            console.error('Error getting volume:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }
    /**
     * Add volume to active cycle
     */
    async addVolume(request) {
        try {
            const cycleId = this.volumeRepo.getActiveCycleId();
            if (!cycleId) {
                return {
                    success: false,
                    error: 'No active cycle'
                };
            }
            this.volumeRepo.addVolume(cycleId, request.side, request.amount, request.shares);
            return { success: true };
        }
        catch (error) {
            console.error('Error adding volume:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }
    /**
     * Reset volume for a cycle
     */
    async resetVolume(cycleId) {
        try {
            this.volumeRepo.resetVolume(cycleId);
            return { success: true };
        }
        catch (error) {
            console.error('Error resetting volume:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }
    /**
     * Initialize a new cycle
     */
    async initializeCycle(cycleId) {
        try {
            this.volumeRepo.initializeCycle(cycleId);
            return { success: true };
        }
        catch (error) {
            console.error('Error initializing cycle:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }
    // ========================================================================
    // Settlement History Operations
    // ========================================================================
    /**
     * Get settlement history
     */
    async getSettlementHistory(limit = 50) {
        try {
            const history = this.historyRepo.getSettlementHistory(limit);
            return { history };
        }
        catch (error) {
            console.error('Error getting settlement history:', error);
            return { history: [] };
        }
    }
    /**
     * Add settlement record
     */
    async addSettlement(request) {
        try {
            this.historyRepo.addSettlement(request.userPrefix, request.result, request.amount, request.side, request.snapshotPrice, request.settlePrice);
            return { success: true };
        }
        catch (error) {
            console.error('Error adding settlement:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }
    // ========================================================================
    // Trading History Operations
    // ========================================================================
    /**
     * Get trading history for a user
     */
    async getTradingHistory(userPrefix, limit = 50) {
        try {
            const history = this.historyRepo.getTradingHistory(userPrefix, limit);
            return { history };
        }
        catch (error) {
            console.error('Error getting trading history:', error);
            return { history: [] };
        }
    }
    /**
     * Add trading record
     */
    async addTrade(request) {
        try {
            this.historyRepo.addTrade(request.userPrefix, request.action, request.side, request.shares, request.costUsd, request.avgPrice, request.pnl);
            return { success: true };
        }
        catch (error) {
            console.error('Error adding trade:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }
    // ========================================================================
    // Quote Snapshot Operations
    // ========================================================================
    /**
     * Add quote snapshot
     */
    async addQuoteSnapshot(request) {
        try {
            this.quoteRepo.insertSnapshot(request.cycleId, request.upPrice, request.downPrice);
            return { success: true };
        }
        catch (error) {
            console.error('Error adding quote snapshot:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }
    /**
     * Get quote history for a cycle
     */
    async getQuoteHistory(cycleId, limit = 100) {
        try {
            const history = this.quoteRepo.getHistory(cycleId, limit);
            return {
                cycleId,
                history
            };
        }
        catch (error) {
            console.error('Error getting quote history:', error);
            return {
                cycleId,
                history: []
            };
        }
    }
    // ========================================================================
    // Cycle Management Operations
    // ========================================================================
    /**
     * Get recent cycles
     */
    async getRecentCycles(limit = 10) {
        try {
            const cycles = this.volumeRepo.getRecentCycles(limit);
            return { cycles };
        }
        catch (error) {
            console.error('Error getting recent cycles:', error);
            return { cycles: [] };
        }
    }
    /**
     * Get active cycle ID
     */
    getActiveCycleId() {
        return this.volumeRepo.getActiveCycleId();
    }
    // ========================================================================
    // Database Management
    // ========================================================================
    /**
     * Get database statistics
     */
    async getDatabaseStats() {
        try {
            const db = this.db.getDb();
            const priceCount = db.prepare('SELECT COUNT(*) as count FROM price_history').get();
            const settlementCount = db.prepare('SELECT COUNT(*) as count FROM settlement_history').get();
            const tradingCount = db.prepare('SELECT COUNT(*) as count FROM trading_history').get();
            const quoteCount = db.prepare('SELECT COUNT(*) as count FROM quote_history').get();
            const cycleCount = db.prepare('SELECT COUNT(*) as count FROM cumulative_volume').get();
            return {
                priceRecords: priceCount.count,
                settlements: settlementCount.count,
                trades: tradingCount.count,
                quoteSnapshots: quoteCount.count,
                cycles: cycleCount.count
            };
        }
        catch (error) {
            console.error('Error getting database stats:', error);
            return null;
        }
    }
    /**
     * Close database connection
     */
    close() {
        this.db.close();
    }
    /**
     * Get raw database instance (for advanced operations)
     */
    getDatabase() {
        return this.db.getDb();
    }
}
exports.DatabaseController = DatabaseController;
//# sourceMappingURL=database.controller.js.map