import { Connection, PublicKey } from '@solana/web3.js';
import { AmmState, MarketConfig, LMSRPrices } from '../types';
/**
 * Market Service - Fetches AMM state from Solana program account
 *
 * Deserializes the AMM account structure:
 * - Discriminator (8 bytes)
 * - Bump (1 byte)
 * - Decimals (1 byte)
 * - b_scaled (8 bytes)
 * - fee_bps (2 bytes)
 * - q_yes, q_no, fees_collected, vault_e6 (8 bytes each)
 * - status, winner (1 byte each)
 * - winning_total, price_per_share (8 bytes each)
 * - fee_dest (32 bytes)
 * - vault_sol_bump (1 byte)
 * - start_price_e6 (8 bytes)
 * - market_end_time (8 bytes, optional)
 */
export declare class MarketService {
    private connection;
    private programId;
    private config;
    constructor(connection: Connection, programId: string, config?: Partial<MarketConfig>);
    /**
     * Fetch current AMM state from Solana
     * @returns AmmState or null if fetch fails
     */
    fetchMarketState(): Promise<AmmState | null>;
    /**
     * Derive AMM PDA from program ID and seed
     */
    private deriveAmmPda;
    /**
     * Deserialize AMM account data
     * @param accountInfo - Raw account info from Solana
     * @returns Parsed AMM state or null
     */
    private deserializeAmmAccount;
    /**
     * Parse market status enum
     */
    private parseMarketStatus;
    /**
     * Parse winner enum
     */
    private parseWinner;
    /**
     * Calculate LMSR prices from AMM state
     * @param ammState - Current AMM state
     * @returns Calculated YES/NO probabilities
     */
    calculatePrices(ammState: AmmState): LMSRPrices;
    /**
     * Get AMM PDA address
     */
    getAmmAddress(): PublicKey;
    /**
     * Get market configuration
     */
    getConfig(): MarketConfig;
    /**
     * Update configuration
     */
    updateConfig(config: Partial<MarketConfig>): void;
    /**
     * Log info message if logging enabled
     */
    private log;
    /**
     * Log error message
     */
    private logError;
}
//# sourceMappingURL=market.service.d.ts.map