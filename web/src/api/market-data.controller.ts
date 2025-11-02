/**
 * Market Data Controller
 *
 * Provides type-safe API handlers for market data endpoints combining
 * oracle price data and AMM market state
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { OracleService } from '../solana/oracle.service';
import { MarketService } from '../solana/market.service';
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
export class MarketDataController {
  private connection: Connection;
  private oracleService: OracleService;
  private marketService: MarketService;
  private config: MarketDataControllerConfig;

  constructor(config: MarketDataControllerConfig) {
    this.config = config;
    this.connection = new Connection(config.rpcUrl, 'confirmed');

    // Initialize Oracle Service
    this.oracleService = new OracleService(
      this.connection,
      config.oracleStateKey,
      {
        pollInterval: 1000,
        maxAge: 90,
        enableLogging: config.enableLogging ?? false
      }
    );

    // Initialize Market Service
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
  }

  /**
   * Fetch complete market data (oracle + market + LMSR)
   */
  async getMarketData(): Promise<MarketDataResponse | null> {
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
    } catch (error) {
      console.error('Error fetching market data:', error);
      return null;
    }
  }

  /**
   * Fetch only oracle price
   */
  async getOraclePrice(): Promise<OraclePrice | null> {
    try {
      return await this.oracleService.fetchPrice();
    } catch (error) {
      console.error('Error fetching oracle price:', error);
      return null;
    }
  }

  /**
   * Fetch only market state
   */
  async getMarketState(): Promise<AmmState | null> {
    try {
      return await this.marketService.fetchMarketState();
    } catch (error) {
      console.error('Error fetching market state:', error);
      return null;
    }
  }

  /**
   * Calculate LMSR prices from market state
   */
  calculateLMSRPrices(marketState: AmmState): LMSRPrices {
    return this.marketService.calculatePrices(marketState);
  }

  /**
   * Get AMM PDA address
   */
  getAmmAddress(): PublicKey {
    return this.marketService.getAmmAddress();
  }

  /**
   * Get Oracle key
   */
  getOracleKey(): PublicKey {
    return this.oracleService.getOracleKey();
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<MarketDataControllerConfig>): void {
    if (config.rpcUrl && config.rpcUrl !== this.config.rpcUrl) {
      this.config.rpcUrl = config.rpcUrl;
      this.connection = new Connection(config.rpcUrl, 'confirmed');

      // Recreate services with new connection
      this.oracleService = new OracleService(
        this.connection,
        this.config.oracleStateKey,
        {
          pollInterval: 1000,
          maxAge: 90,
          enableLogging: this.config.enableLogging ?? false
        }
      );

      this.marketService = new MarketService(
        this.connection,
        this.config.programId,
        {
          ammSeed: this.config.ammSeed,
          pollInterval: 1500,
          lamportsPerE6: 100,
          enableLogging: this.config.enableLogging ?? false
        }
      );
    }

    Object.assign(this.config, config);
  }
}
