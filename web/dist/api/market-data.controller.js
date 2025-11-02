"use strict";
/**
 * Market Data Controller
 *
 * Provides type-safe API handlers for market data endpoints combining
 * oracle price data and AMM market state
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MarketDataController = void 0;
const web3_js_1 = require("@solana/web3.js");
const oracle_service_1 = require("../solana/oracle.service");
const market_service_1 = require("../solana/market.service");
/**
 * Market Data Controller
 *
 * Manages fetching and combining data from Oracle and Market services
 */
class MarketDataController {
    constructor(config) {
        this.config = config;
        this.connection = new web3_js_1.Connection(config.rpcUrl, 'confirmed');
        // Initialize Oracle Service
        this.oracleService = new oracle_service_1.OracleService(this.connection, config.oracleStateKey, {
            pollInterval: 1000,
            maxAge: 90,
            enableLogging: config.enableLogging ?? false
        });
        // Initialize Market Service
        this.marketService = new market_service_1.MarketService(this.connection, config.programId, {
            ammSeed: config.ammSeed,
            pollInterval: 1500,
            lamportsPerE6: 100,
            enableLogging: config.enableLogging ?? false
        });
    }
    /**
     * Fetch complete market data (oracle + market + LMSR)
     */
    async getMarketData() {
        try {
            // Fetch oracle and market data in parallel
            const [oraclePrice, marketState] = await Promise.all([
                this.oracleService.fetchPrice(),
                this.marketService.fetchMarketState()
            ]);
            if (!oraclePrice || !marketState) {
                console.error('Failed to fetch oracle or market data');
                return null;
            }
            // Calculate LMSR prices
            const lmsrPrices = this.marketService.calculatePrices(marketState);
            // Build response (handle optional marketEndTime properly)
            const baseMarket = {
                bump: marketState.bump,
                decimals: marketState.decimals,
                bScaled: marketState.bScaled,
                feeBps: marketState.feeBps,
                qYes: marketState.qYes,
                qNo: marketState.qNo,
                feesCollected: marketState.feesCollected,
                vault: marketState.vault,
                status: marketState.status,
                winner: marketState.winner,
                winningTotal: marketState.winningTotal,
                pricePerShare: marketState.pricePerShare,
                feeDest: marketState.feeDest.toBase58(),
                vaultSolBump: marketState.vaultSolBump,
                startPrice: marketState.startPrice,
                timestamp: marketState.timestamp
            };
            const marketData = marketState.marketEndTime !== undefined
                ? { ...baseMarket, marketEndTime: marketState.marketEndTime }
                : baseMarket;
            return {
                oracle: {
                    price: oraclePrice.price,
                    age: oraclePrice.age,
                    timestamp: oraclePrice.timestamp,
                    triplet: oraclePrice.triplet
                },
                market: marketData,
                lmsr: {
                    probYes: lmsrPrices.probYes,
                    probNo: lmsrPrices.probNo,
                    yesPrice: lmsrPrices.yesPrice,
                    noPrice: lmsrPrices.noPrice
                }
            };
        }
        catch (error) {
            console.error('Error fetching market data:', error);
            return null;
        }
    }
    /**
     * Fetch only oracle price
     */
    async getOraclePrice() {
        try {
            return await this.oracleService.fetchPrice();
        }
        catch (error) {
            console.error('Error fetching oracle price:', error);
            return null;
        }
    }
    /**
     * Fetch only market state
     */
    async getMarketState() {
        try {
            return await this.marketService.fetchMarketState();
        }
        catch (error) {
            console.error('Error fetching market state:', error);
            return null;
        }
    }
    /**
     * Calculate LMSR prices from market state
     */
    calculateLMSRPrices(marketState) {
        return this.marketService.calculatePrices(marketState);
    }
    /**
     * Get AMM PDA address
     */
    getAmmAddress() {
        return this.marketService.getAmmAddress();
    }
    /**
     * Get Oracle key
     */
    getOracleKey() {
        return this.oracleService.getOracleKey();
    }
    /**
     * Update configuration
     */
    updateConfig(config) {
        if (config.rpcUrl && config.rpcUrl !== this.config.rpcUrl) {
            this.config.rpcUrl = config.rpcUrl;
            this.connection = new web3_js_1.Connection(config.rpcUrl, 'confirmed');
            // Recreate services with new connection
            this.oracleService = new oracle_service_1.OracleService(this.connection, this.config.oracleStateKey, {
                pollInterval: 1000,
                maxAge: 90,
                enableLogging: this.config.enableLogging ?? false
            });
            this.marketService = new market_service_1.MarketService(this.connection, this.config.programId, {
                ammSeed: this.config.ammSeed,
                pollInterval: 1500,
                lamportsPerE6: 100,
                enableLogging: this.config.enableLogging ?? false
            });
        }
        Object.assign(this.config, config);
    }
}
exports.MarketDataController = MarketDataController;
//# sourceMappingURL=market-data.controller.js.map