/**
 * Price history repository - handles price data storage and retrieval
 */
import Database from 'better-sqlite3';
import { PriceHistoryRow, PriceHistoryOptions } from '../types';
/**
 * Repository for managing price history data
 */
export declare class PriceHistoryRepository {
    private db;
    constructor(db: Database.Database);
    /**
     * Get total count of price records
     */
    count(): number;
    /**
     * Find price history records with optional filters
     */
    find(options?: PriceHistoryOptions): PriceHistoryRow[];
    /**
     * Insert a new price record
     */
    insert(price: number, timestamp?: number): boolean;
    /**
     * Delete old price records beyond the retention period
     */
    cleanup(maxAgeHours: number): number;
    /**
     * Get the most recent price
     */
    getLatest(): PriceHistoryRow | null;
    /**
     * Get price history for a specific time range
     */
    findByTimeRange(startTime: number, endTime: number): PriceHistoryRow[];
}
//# sourceMappingURL=price-history.repository.d.ts.map