/**
 * Quote history repository - handles LMSR quote snapshots per market cycle
 */
import Database from 'better-sqlite3';
import { QuoteHistoryRow, CycleInfo } from '../types';
/**
 * Repository for managing quote (probability) history across market cycles
 */
export declare class QuoteHistoryRepository {
    private db;
    constructor(db: Database.Database);
    /**
     * Add a quote snapshot for a cycle
     */
    insert(cycleId: string, upPrice: number, downPrice: number): boolean;
    /**
     * Get quote history for a specific cycle
     */
    findByCycle(cycleId: string): QuoteHistoryRow[];
    /**
     * Get list of recent cycles
     */
    getRecentCycles(limit?: number): CycleInfo[];
    /**
     * Clean up old quote history records
     */
    cleanup(maxAgeHours: number): number;
    /**
     * Get the most recent quote for a cycle
     */
    getLatestForCycle(cycleId: string): QuoteHistoryRow | null;
    /**
     * Get quote count for a specific cycle
     */
    countByCycle(cycleId: string): number;
    /**
     * Get quote history for a time range within a cycle
     */
    findByCycleAndTimeRange(cycleId: string, startTime: number, endTime: number): QuoteHistoryRow[];
}
//# sourceMappingURL=quote-history.repository.d.ts.map