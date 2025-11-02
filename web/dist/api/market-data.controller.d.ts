/**
 * Market Data Controller
 *
 * Provides type-safe API handlers for market data endpoints combining
 * oracle price data and AMM market state
 */
import { PublicKey } from '@solana/web3.js';
import type { AmmState, LMSRPrices } from '../types/market.types';
import type { OraclePrice } from '../types/oracle.types';
/**
 * Combined market data response
 */
export interface MarketDataResponse {
    oracle: {
        price: number;
        age: number;
        timestamp: number;
        triplet?: {
            param1: number;
            param2: number;
            param3: number;
            ts1: number;
            ts2: number;
            ts3: number;
        };
    };
    market: {
        bump: number;
        decimals: number;
        bScaled: number;
        feeBps: number;
        qYes: number;
        qNo: number;
        feesCollected: number;
        vault: number;
        status: number;
        winner: number;
        winningTotal: number;
        pricePerShare: number;
        feeDest: string;
        vaultSolBump: number;
        startPrice: number;
        marketEndTime?: number;
        timestamp: number;
    };
    lmsr: {
        probYes: number;
        probNo: number;
        yesPrice: number;
        noPrice: number;
    };
}
/**
 * Controller configuration
 */
export interface MarketDataControllerConfig {
    rpcUrl: string;
    oracleStateKey: string;
    programId: string;
    ammSeed: string;
    enableLogging?: boolean;
}
/**
 * Market Data Controller
 *
 * Manages fetching and combining data from Oracle and Market services
 */
export declare class MarketDataController {
    private connection;
    private oracleService;
    private marketService;
    private config;
    constructor(config: MarketDataControllerConfig);
    /**
     * Fetch complete market data (oracle + market + LMSR)
     */
    getMarketData(): Promise<MarketDataResponse | null>;
    /**
     * Fetch only oracle price
     */
    getOraclePrice(): Promise<OraclePrice | null>;
    /**
     * Fetch only market state
     */
    getMarketState(): Promise<AmmState | null>;
    /**
     * Calculate LMSR prices from market state
     */
    calculateLMSRPrices(marketState: AmmState): LMSRPrices;
    /**
     * Get AMM PDA address
     */
    getAmmAddress(): PublicKey;
    /**
     * Get Oracle key
     */
    getOracleKey(): PublicKey;
    /**
     * Update configuration
     */
    updateConfig(config: Partial<MarketDataControllerConfig>): void;
}
//# sourceMappingURL=market-data.controller.d.ts.map