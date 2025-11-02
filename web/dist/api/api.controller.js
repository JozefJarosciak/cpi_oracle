"use strict";
/**
 * ApiController - Complete TypeScript API Layer
 *
 * Provides all REST endpoints needed for proto2 frontend:
 * - Current price (oracle)
 * - Volume data
 * - Recent cycles
 * - Settlement history
 * - Market data
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApiController = void 0;
const web3_js_1 = require("@solana/web3.js");
const oracle_service_1 = require("../solana/oracle.service");
const market_service_1 = require("../solana/market.service");
const simple_database_controller_1 = require("./simple-database.controller");
const guarded_trade_simulator_1 = require("./guarded-trade-simulator");
class ApiController {
    constructor(config) {
        this.connection = new web3_js_1.Connection(config.rpcUrl, 'confirmed');
        this.oracleService = new oracle_service_1.OracleService(this.connection, config.oracleStateKey, {
            pollInterval: 1000,
            maxAge: 90,
            enableLogging: config.enableLogging ?? false
        });
        this.marketService = new market_service_1.MarketService(this.connection, config.programId, {
            ammSeed: config.ammSeed,
            pollInterval: 1500,
            lamportsPerE6: 100,
            enableLogging: config.enableLogging ?? false
        });
        this.db = new simple_database_controller_1.SimpleDatabaseController({ dbPath: config.dbPath });
        this.enableLogging = config.enableLogging ?? false;
    }
    /**
     * GET /api/current-price
     * Returns current BTC price from oracle
     */
    async getCurrentPrice() {
        try {
            return await this.oracleService.fetchPrice();
        }
        catch (err) {
            if (this.enableLogging) {
                console.error('[ApiController] getCurrentPrice error:', err);
            }
            return null;
        }
    }
    /**
     * GET /api/volume
     * Returns current volume cycle data
     */
    getVolume() {
        try {
            return this.db.volumeRepo.loadCurrent();
        }
        catch (err) {
            if (this.enableLogging) {
                console.error('[ApiController] getVolume error:', err);
            }
            return null;
        }
    }
    /**
     * GET /api/recent-cycles
     * Returns recent volume cycles
     */
    getRecentCycles(limit = 10) {
        try {
            const cycles = this.db.quoteRepo.getRecentCycles(limit);
            return { cycles };
        }
        catch (err) {
            if (this.enableLogging) {
                console.error('[ApiController] getRecentCycles error:', err);
            }
            return { cycles: [] };
        }
    }
    /**
     * GET /api/settlement-history
     * Returns settlement history (matches JavaScript API format)
     */
    getSettlementHistory(limit = 100) {
        try {
            const settlements = this.db.historyRepo.getSettlements(limit);
            return { history: settlements };
        }
        catch (err) {
            if (this.enableLogging) {
                console.error('[ApiController] getSettlementHistory error:', err);
            }
            return { history: [] };
        }
    }
    /**
     * GET /api/market-data (enhanced version combining oracle + market + LMSR)
     */
    async getMarketData() {
        try {
            const [oraclePrice, marketState] = await Promise.all([
                this.oracleService.fetchPrice(),
                this.marketService.fetchMarketState()
            ]);
            if (!oraclePrice || !marketState) {
                return null;
            }
            const lmsrPrices = this.marketService.calculatePrices(marketState);
            return {
                oracle: oraclePrice,
                market: marketState,
                lmsr: lmsrPrices,
                timestamp: Date.now()
            };
        }
        catch (err) {
            if (this.enableLogging) {
                console.error('[ApiController] getMarketData error:', err);
            }
            return null;
        }
    }
    /**
     * Get trading history for a user
     */
    getTradingHistory(userPrefix, limit = 100) {
        try {
            const history = this.db.getTradingHistory(userPrefix, limit);
            return { history };
        }
        catch (err) {
            if (this.enableLogging) {
                console.error('[ApiController] getTradingHistory error:', err);
            }
            return { history: [] };
        }
    }
    /**
     * Get database statistics
     */
    getStats() {
        return this.db.getStats();
    }
    /**
     * POST /api/simulate-guarded-trade
     * Simulates a guarded trade execution and returns expected results
     */
    async simulateGuardedTrade(side, action, amountE6, guards) {
        try {
            const marketState = await this.marketService.fetchMarketState();
            if (!marketState) {
                return {
                    success: false,
                    sharesToExecute: 0,
                    executionPrice: 0,
                    totalCost: 0,
                    isPartialFill: false,
                    guardsStatus: {},
                    error: 'Failed to fetch current market state'
                };
            }
            return (0, guarded_trade_simulator_1.simulateGuardedTrade)(side, action, amountE6, guards, marketState);
        }
        catch (err) {
            if (this.enableLogging) {
                console.error('[ApiController] simulateGuardedTrade error:', err);
            }
            return {
                success: false,
                sharesToExecute: 0,
                executionPrice: 0,
                totalCost: 0,
                isPartialFill: false,
                guardsStatus: {},
                error: err instanceof Error ? err.message : 'Simulation failed'
            };
        }
    }
    /**
     * Close database connection
     */
    close() {
        this.db.close();
    }
}
exports.ApiController = ApiController;
//# sourceMappingURL=api.controller.js.map