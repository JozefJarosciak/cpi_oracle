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

import { Connection } from '@solana/web3.js';
import { OracleService } from '../solana/oracle.service';
import { MarketService } from '../solana/market.service';
import { SimpleDatabaseController } from './simple-database.controller';
import type { CumulativeVolume, CycleInfo, SettlementHistoryRow } from '../types';

export interface ApiControllerConfig {
  rpcUrl: string;
  oracleStateKey: string;
  programId: string;
  ammSeed: string;
  dbPath: string;
  enableLogging?: boolean;
}

// Use existing database types directly
export type VolumeResponse = CumulativeVolume;
export type RecentCyclesResponse = { cycles: CycleInfo[] };
export type SettlementHistoryResponse = { history: SettlementHistoryRow[] };

export class ApiController {
  private connection: Connection;
  private oracleService: OracleService;
  private marketService: MarketService;
  private db: SimpleDatabaseController;
  private enableLogging: boolean;

  constructor(config: ApiControllerConfig) {
    this.connection = new Connection(config.rpcUrl, 'confirmed');

    this.oracleService = new OracleService(
      this.connection,
      config.oracleStateKey,
      {
        pollInterval: 1000,
        maxAge: 90,
        enableLogging: config.enableLogging ?? false
      }
    );

    this.marketService = new MarketService(
      this.connection,
      config.programId,
      {
        ammSeed: config.ammSeed,
        pollInterval: 1500,
        lamportsPerE6: 100,
        enableLogging: config.enableLogging ?? false
      }
    );

    this.db = new SimpleDatabaseController({ dbPath: config.dbPath });
    this.enableLogging = config.enableLogging ?? false;
  }

  /**
   * GET /api/current-price
   * Returns current BTC price from oracle
   */
  async getCurrentPrice() {
    try {
      return await this.oracleService.fetchPrice();
    } catch (err) {
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
  getVolume(): VolumeResponse | null {
    try {
      return this.db.volumeRepo.loadCurrent();
    } catch (err) {
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
  getRecentCycles(limit: number = 10): RecentCyclesResponse {
    try {
      const cycles = this.db.quoteRepo.getRecentCycles(limit);
      return { cycles };
    } catch (err) {
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
  getSettlementHistory(limit: number = 100): SettlementHistoryResponse {
    try {
      const settlements = this.db.historyRepo.getSettlements(limit);
      return { history: settlements };
    } catch (err) {
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
    } catch (err) {
      if (this.enableLogging) {
        console.error('[ApiController] getMarketData error:', err);
      }
      return null;
    }
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
}
