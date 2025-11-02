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
import { type AdvancedGuardConfig, type SimulationResult } from './guarded-trade-simulator';
import type { CumulativeVolume, CycleInfo, SettlementHistoryRow, TradingHistoryRow } from '../types';
export interface ApiControllerConfig {
    rpcUrl: string;
    oracleStateKey: string;
    programId: string;
    ammSeed: string;
    dbPath: string;
    enableLogging?: boolean;
}
export type VolumeResponse = CumulativeVolume;
export type RecentCyclesResponse = {
    cycles: CycleInfo[];
};
export type SettlementHistoryResponse = {
    history: SettlementHistoryRow[];
};
export type TradingHistoryResponse = {
    history: TradingHistoryRow[];
};
export declare class ApiController {
    private connection;
    private oracleService;
    private marketService;
    private db;
    private enableLogging;
    constructor(config: ApiControllerConfig);
    /**
     * GET /api/current-price
     * Returns current BTC price from oracle
     */
    getCurrentPrice(): Promise<import("../types").OraclePrice | null>;
    /**
     * GET /api/volume
     * Returns current volume cycle data
     */
    getVolume(): VolumeResponse | null;
    /**
     * GET /api/recent-cycles
     * Returns recent volume cycles
     */
    getRecentCycles(limit?: number): RecentCyclesResponse;
    /**
     * GET /api/settlement-history
     * Returns settlement history (matches JavaScript API format)
     */
    getSettlementHistory(limit?: number): SettlementHistoryResponse;
    /**
     * GET /api/market-data (enhanced version combining oracle + market + LMSR)
     */
    getMarketData(): Promise<{
        oracle: import("../types").OraclePrice;
        market: import("../types").AmmState;
        lmsr: import("../types").LMSRPrices;
        timestamp: number;
    } | null>;
    /**
     * Get trading history for a user
     */
    getTradingHistory(userPrefix: string, limit?: number): TradingHistoryResponse;
    /**
     * Get database statistics
     */
    getStats(): {
        priceCount: number;
        settlementCount: number;
        tradingCount: number;
        volumeCount: number;
        quoteCount: number;
    };
    /**
     * POST /api/simulate-guarded-trade
     * Simulates a guarded trade execution and returns expected results
     */
    simulateGuardedTrade(side: number, action: number, amountE6: number, guards: AdvancedGuardConfig): Promise<SimulationResult | null>;
    /**
     * Close database connection
     */
    close(): void;
}
//# sourceMappingURL=api.controller.d.ts.map