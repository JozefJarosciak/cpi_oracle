import { Connection, PublicKey } from '@solana/web3.js';
import { OraclePrice, OracleConfig } from '../types';
/**
 * Oracle Service - Fetches BTC price from Solana oracle account
 *
 * Reads oracle state account and deserializes the triplet structure:
 * - Discriminator (8 bytes)
 * - Update authority (32 bytes)
 * - BTC triplet: param1, param2, param3, ts1, ts2, ts3 (48 bytes)
 * - ETH triplet (48 bytes)
 * - SOL triplet (48 bytes)
 * - Decimals (1 byte)
 */
export declare class OracleService {
    private connection;
    private oracleKey;
    private config;
    constructor(connection: Connection, oracleStateAddress: string, config?: Partial<OracleConfig>);
    /**
     * Fetch current BTC price from oracle
     * @returns OraclePrice or null if fetch fails
     */
    fetchPrice(): Promise<OraclePrice | null>;
    /**
     * Deserialize oracle account data
     * @param accountInfo - Raw account info from Solana
     * @returns Parsed oracle price or null
     */
    private deserializeOracleAccount;
    /**
     * Calculate median of three bigints
     */
    private median3;
    /**
     * Calculate maximum of three bigints
     */
    private max3;
    /**
     * Log info message if logging enabled
     */
    private log;
    /**
     * Log error message
     */
    private logError;
    /**
     * Get oracle configuration
     */
    getConfig(): OracleConfig;
    /**
     * Get oracle public key
     */
    getOracleKey(): PublicKey;
    /**
     * Update configuration
     */
    updateConfig(config: Partial<OracleConfig>): void;
}
//# sourceMappingURL=oracle.service.d.ts.map