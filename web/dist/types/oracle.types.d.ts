/**
 * Oracle-related type definitions
 * Based on the X1 oracle program structure
 */
/**
 * Oracle price data with triplet structure
 */
export interface OracleTriplet {
    param1: number;
    param2: number;
    param3: number;
    ts1: number;
    ts2: number;
    ts3: number;
}
/**
 * Parsed oracle price result
 */
export interface OraclePrice {
    /** BTC price in USD (with decimal precision) */
    price: number;
    /** Age of the price data in seconds */
    age: number;
    /** Timestamp when this price was fetched (ms) */
    timestamp: number;
    /** Raw triplet data from oracle */
    triplet: OracleTriplet;
}
/**
 * Raw oracle account data structure
 */
export interface OracleAccountData {
    /** Account discriminator (8 bytes) */
    discriminator: Buffer;
    /** Update authority public key (32 bytes) */
    updateAuthority: Buffer;
    /** BTC price triplet */
    btc: OracleTriplet;
    /** ETH price triplet */
    eth: OracleTriplet;
    /** SOL price triplet */
    sol: OracleTriplet;
    /** Decimals used for price values */
    decimals: number;
}
/**
 * Oracle configuration
 */
export interface OracleConfig {
    /** Polling interval in milliseconds */
    pollInterval: number;
    /** Maximum age for valid price data (seconds) */
    maxAge: number;
    /** Enable console logging */
    enableLogging: boolean;
}
//# sourceMappingURL=oracle.types.d.ts.map