/**
 * Simplified Database Controller
 *
 * Provides basic type-safe wrappers for database repositories
 * Note: This is a thin wrapper - complex operations should use repositories directly
 */
import type Database from 'better-sqlite3';
import { PriceHistoryRepository } from '../database/price-history.repository';
import { VolumeRepository } from '../database/volume.repository';
import { HistoryRepository } from '../database/history.repository';
import { QuoteHistoryRepository } from '../database/quote-history.repository';
export interface SimpleDatabaseControllerConfig {
    dbPath: string;
}
/**
 * Simplified Database Controller
 *
 * Use this for basic operations. For complex workflows, access repositories directly.
 */
export declare class SimpleDatabaseController {
    private db;
    readonly priceRepo: PriceHistoryRepository;
    readonly volumeRepo: VolumeRepository;
    readonly historyRepo: HistoryRepository;
    readonly quoteRepo: QuoteHistoryRepository;
    constructor(config: SimpleDatabaseControllerConfig);
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
     * Close database connection
     */
    close(): void;
    /**
     * Get raw database instance
     */
    getDatabase(): Database.Database;
}
//# sourceMappingURL=simple-database.controller.d.ts.map