/**
 * Market-related type definitions
 * Based on the Solana AMM program structure
 */

/**
 * Market status enum
 */
export enum MarketStatus {
  Open = 0,
  Stopped = 1,
  Settled = 2,
}

/**
 * Winner enum for settled markets
 */
export enum Winner {
  None = 0,
  Yes = 1,
  No = 2,
}

/**
 * Market side (YES/UP or NO/DOWN)
 */
export type MarketSide = 'YES' | 'NO';

/**
 * Trade action
 */
export type TradeAction = 'BUY' | 'SELL';

/**
 * AMM account state (from Solana program)
 */
export interface AmmState {
  /** PDA bump seed */
  bump: number;
  /** Decimals for fixed-point arithmetic (typically 6) */
  decimals: number;
  /** LMSR liquidity parameter (scaled by 1e6) */
  bScaled: number;
  /** Fee in basis points */
  feeBps: number;
  /** Quantity of YES shares outstanding (scaled by 1e6) */
  qYes: number;
  /** Quantity of NO shares outstanding (scaled by 1e6) */
  qNo: number;
  /** Accumulated fees (scaled by 1e6) */
  feesCollected: number;
  /** Vault balance in XNT (scaled by LAMPORTS_PER_E6 = 100) */
  vault: number;
  /** Market status (0=Open, 1=Stopped, 2=Settled) */
  status: MarketStatus;
  /** Winner side (0=None, 1=Yes, 2=No) */
  winner: Winner;
  /** Total winning shares (scaled by 1e6) */
  winningTotal: number;
  /** Price per share for settlement (scaled by 1e6) */
  pricePerShare: number;
  /** Fee destination public key */
  feeDest: import('@solana/web3.js').PublicKey;
  /** Vault SOL PDA bump seed */
  vaultSolBump: number;
  /** Start price snapshot from oracle (scaled by 1e6) */
  startPrice: number;
  /** Market end time (unix timestamp, optional) */
  marketEndTime?: number;
  /** Timestamp when data was fetched (ms) */
  timestamp: number;
}

/**
 * LMSR calculated prices
 */
export interface LMSRPrices {
  /** Probability for YES side (0-1) */
  probYes: number;
  /** Probability for NO side (0-1) */
  probNo: number;
  /** Price for YES side (0-1) */
  yesPrice: number;
  /** Price for NO side (0-1) */
  noPrice: number;
}

/**
 * User position data
 */
export interface Position {
  /** User's public key */
  user: string;
  /** YES shares held (scaled by 1e6) */
  yesShares: number;
  /** NO shares held (scaled by 1e6) */
  noShares: number;
  /** Last update timestamp */
  timestamp: number;
}

/**
 * Market configuration
 */
export interface MarketConfig {
  /** AMM PDA seed */
  ammSeed: string;
  /** Market polling interval in milliseconds */
  pollInterval: number;
  /** Lamports per e6 unit conversion factor */
  lamportsPerE6: number;
  /** Enable console logging */
  enableLogging: boolean;
}

/**
 * Market data with cycle information (for API responses)
 */
export interface MarketDataWithCycle extends AmmState {
  /** Current market cycle ID */
  cycleId: string | null;
}
