import { Connection, PublicKey, AccountInfo } from '@solana/web3.js';
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
export class OracleService {
  private connection: Connection;
  private oracleKey: PublicKey;
  private config: OracleConfig;

  constructor(connection: Connection, oracleStateAddress: string, config?: Partial<OracleConfig>) {
    this.connection = connection;
    this.oracleKey = new PublicKey(oracleStateAddress);
    this.config = {
      pollInterval: config?.pollInterval ?? 1000,
      maxAge: config?.maxAge ?? 90,
      enableLogging: config?.enableLogging ?? true,
    };
  }

  /**
   * Fetch current BTC price from oracle
   * @returns OraclePrice or null if fetch fails
   */
  async fetchPrice(): Promise<OraclePrice | null> {
    try {
      const accountInfo = await this.connection.getAccountInfo(this.oracleKey);

      if (!accountInfo) {
        this.logError('Oracle account not found');
        return null;
      }

      return this.deserializeOracleAccount(accountInfo);
    } catch (err) {
      const error = err as Error;
      this.logError(`Failed to fetch oracle price: ${error.message}`);
      return null;
    }
  }

  /**
   * Deserialize oracle account data
   * @param accountInfo - Raw account info from Solana
   * @returns Parsed oracle price or null
   */
  private deserializeOracleAccount(accountInfo: AccountInfo<Buffer>): OraclePrice | null {
    try {
      const d = accountInfo.data;

      // Validate minimum size: 8 (disc) + 32 (auth) + 48*3 (triplets) + 1 (decimals) = 185
      const MIN_SIZE = 8 + 32 + 48 * 3 + 1;
      if (d.length < MIN_SIZE) {
        this.logError(`Oracle data invalid: expected at least ${MIN_SIZE} bytes, got ${d.length}`);
        return null;
      }

      let offset = 8; // Skip discriminator
      offset += 32; // Skip update_authority

      // Read BTC triplet (3 prices + 3 timestamps)
      const readI64 = (): bigint => {
        const value = d.readBigInt64LE(offset);
        offset += 8;
        return value;
      };

      const param1 = readI64();
      const param2 = readI64();
      const param3 = readI64();
      const ts1 = readI64();
      const ts2 = readI64();
      const ts3 = readI64();

      // Mainnet oracle uses 8 decimals (1e8 scaling)
      const decimals = 8;

      // Calculate median price from triplet
      const medianPrice = this.median3(param1, param2, param3);
      const scale = 10n ** BigInt(decimals);
      const btcPrice = Number(medianPrice) / Number(scale);

      // Calculate age from most recent timestamp
      // Timestamps are in milliseconds, convert to seconds for age calculation
      const maxTimestamp = this.max3(ts1, ts2, ts3);
      const nowMs = Date.now();
      const ageSeconds = Math.floor((nowMs - Number(maxTimestamp)) / 1000);

      this.log(`Oracle: BTC $${btcPrice.toFixed(2)} (age: ${ageSeconds}s)`);

      return {
        price: btcPrice,
        age: ageSeconds,
        timestamp: Date.now(),
        triplet: {
          param1: Number(param1),
          param2: Number(param2),
          param3: Number(param3),
          ts1: Number(ts1),
          ts2: Number(ts2),
          ts3: Number(ts3),
        },
      };
    } catch (err) {
      const error = err as Error;
      this.logError(`Failed to deserialize oracle account: ${error.message}`);
      return null;
    }
  }

  /**
   * Calculate median of three bigints
   */
  private median3(a: bigint, b: bigint, c: bigint): bigint {
    const sorted = [a, b, c].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    return sorted[1] as bigint;
  }

  /**
   * Calculate maximum of three bigints
   */
  private max3(a: bigint, b: bigint, c: bigint): bigint {
    return a > b ? (a > c ? a : c) : b > c ? b : c;
  }

  /**
   * Log info message if logging enabled
   */
  private log(message: string): void {
    if (this.config.enableLogging) {
      console.log(`📊 ${message}`);
    }
  }

  /**
   * Log error message
   */
  private logError(message: string): void {
    console.error(`[OracleService] ${message}`);
  }

  /**
   * Get oracle configuration
   */
  getConfig(): OracleConfig {
    return { ...this.config };
  }

  /**
   * Get oracle public key
   */
  getOracleKey(): PublicKey {
    return this.oracleKey;
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<OracleConfig>): void {
    this.config = { ...this.config, ...config };
  }
}
