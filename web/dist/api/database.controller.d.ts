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
import type { PriceHistoryRequest, PriceHistoryResponse, CurrentPriceResponse, AddPriceRequest, VolumeResponse, VolumeUpdateRequest, SettlementHistoryResponse, AddSettlementRequest, TradingHistoryResponse, AddTradingRequest, QuoteSnapshotRequest, QuoteHistoryResponse, RecentCyclesResponse, SuccessResponse } from '../types/api.types';
/**
 * Database Controller Configuration
 */
export interface DatabaseControllerConfig {
    dbPath: string;
    enableLogging?: boolean;
}
/**
 * Database Controller
 *
 * Manages all database-related API operations with full type safety
 */
export declare class DatabaseController {
    private db;
    private priceRepo;
    private volumeRepo;
    private historyRepo;
    private quoteRepo;
    constructor(config: DatabaseControllerConfig);
    /**
     * Get price history for a time range
     */
    getPriceHistory(request: PriceHistoryRequest): Promise<PriceHistoryResponse>;
    /**
     * Add a new price record
     */
    addPrice(request: AddPriceRequest): Promise<SuccessResponse>;
    /**
     * Get current price (most recent)
     */
    getCurrentPrice(): Promise<CurrentPriceResponse>;
    /**
     * Cleanup old price records
     */
    cleanupOldPrices(retentionHours?: number): Promise<number>;
    /**
     * Get cumulative volume for active cycle
     */
    getVolume(cycleId?: string): Promise<VolumeResponse>;
    /**
     * Add volume to active cycle
     */
    addVolume(request: VolumeUpdateRequest): Promise<SuccessResponse>;
    /**
     * Reset volume for a cycle
     */
    resetVolume(cycleId: string): Promise<SuccessResponse>;
    /**
     * Initialize a new cycle
     */
    initializeCycle(cycleId: string): Promise<SuccessResponse>;
    /**
     * Get settlement history
     */
    getSettlementHistory(limit?: number): Promise<SettlementHistoryResponse>;
    /**
     * Add settlement record
     */
    addSettlement(request: AddSettlementRequest): Promise<SuccessResponse>;
    /**
     * Get trading history for a user
     */
    getTradingHistory(userPrefix: string, limit?: number): Promise<TradingHistoryResponse>;
    /**
     * Add trading record
     */
    addTrade(request: AddTradingRequest): Promise<SuccessResponse>;
    /**
     * Add quote snapshot
     */
    addQuoteSnapshot(request: QuoteSnapshotRequest): Promise<SuccessResponse>;
    /**
     * Get quote history for a cycle
     */
    getQuoteHistory(cycleId: string, limit?: number): Promise<QuoteHistoryResponse>;
    /**
     * Get recent cycles
     */
    getRecentCycles(limit?: number): Promise<RecentCyclesResponse>;
    /**
     * Get active cycle ID
     */
    getActiveCycleId(): string | null;
    /**
     * Get database statistics
     */
    getDatabaseStats(): Promise<{
        priceRecords: number;
        settlements: number;
        trades: number;
        quoteSnapshots: number;
        cycles: number;
    } | null>;
    /**
     * Close database connection
     */
    close(): void;
    /**
     * Get raw database instance (for advanced operations)
     */
    getDatabase(): Database;
}
//# sourceMappingURL=database.controller.d.ts.map