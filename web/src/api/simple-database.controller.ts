/**
 * Simplified Database Controller
 *
 * Provides basic type-safe wrappers for database repositories
 * Note: This is a thin wrapper - complex operations should use repositories directly
 */

import type Database from 'better-sqlite3';
import { DatabaseService } from '../database/database.service';
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
export class SimpleDatabaseController {
  private db: DatabaseService;
  public readonly priceRepo: PriceHistoryRepository;
  public readonly volumeRepo: VolumeRepository;
  public readonly historyRepo: HistoryRepository;
  public readonly quoteRepo: QuoteHistoryRepository;

  constructor(config: SimpleDatabaseControllerConfig) {
    this.db = new DatabaseService({
      dbFile: config.dbPath,
      maxPriceHistoryHours: 24,
      maxSettlementHistoryHours: 720,  // 30 days
      maxTradingHistoryHours: 720       // 30 days
    });

    // Expose repositories publicly for direct access
    this.priceRepo = new PriceHistoryRepository(this.db.getDatabase());
    this.volumeRepo = new VolumeRepository(this.db.getDatabase());
    this.historyRepo = new HistoryRepository(this.db.getDatabase());
    this.quoteRepo = new QuoteHistoryRepository(this.db.getDatabase());
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
  close(): void {
    this.db.close();
  }

  /**
   * Get raw database instance
   */
  getDatabase(): Database.Database {
    return this.db.getDatabase();
  }
}
