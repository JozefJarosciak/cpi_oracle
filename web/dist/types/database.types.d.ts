/**
 * Database schema type definitions
 * Represents SQLite table row structures
 */
/**
 * Price history table row
 */
export interface PriceHistoryRow {
    id: number;
    price: number;
    timestamp: number;
}
/**
 * Settlement history table row
 */
export interface SettlementHistoryRow {
    id: number;
    user_prefix: string;
    result: string;
    amount: number;
    side: string;
    timestamp: number;
    snapshot_price: number | null;
    settle_price: number | null;
    total_buys?: number;
    total_sells?: number;
    net_spent?: number;
}
/**
 * Trading history table row
 */
export interface TradingHistoryRow {
    id: number;
    user_prefix: string;
    action: string;
    side: string;
    shares: number;
    cost_usd: number;
    avg_price: number;
    pnl: number | null;
    timestamp: number;
}
/**
 * Volume history table row
 */
export interface VolumeHistoryRow {
    id: number;
    cycle_id: string;
    cycle_start_time: number;
    up_volume: number;
    down_volume: number;
    total_volume: number;
    up_shares: number;
    down_shares: number;
    total_shares: number;
    last_update: number;
    market_state: string | null;
}
/**
 * Quote history table row
 */
export interface QuoteHistoryRow {
    id: number;
    cycle_id: string;
    up_price: number;
    down_price: number;
    timestamp: number;
}
/**
 * Cumulative volume state (in-memory and persisted)
 */
export interface CumulativeVolume {
    /** Unique ID for this market cycle */
    cycleId: string;
    /** Total XNT spent on UP/YES trades this cycle */
    upVolume: number;
    /** Total XNT spent on DOWN/NO trades this cycle */
    downVolume: number;
    /** Sum of both sides */
    totalVolume: number;
    /** Total shares bought on UP/YES side */
    upShares: number;
    /** Total shares bought on DOWN/NO side */
    downShares: number;
    /** Sum of both sides */
    totalShares: number;
    /** Timestamp of last update */
    lastUpdate: number;
    /** When this market cycle started */
    cycleStartTime: number;
}
/**
 * Database configuration
 */
export interface DatabaseConfig {
    /** Path to SQLite database file */
    dbFile: string;
    /** Maximum hours to keep price history */
    maxPriceHistoryHours: number;
    /** Maximum hours to keep settlement history */
    maxSettlementHistoryHours: number;
    /** Maximum hours to keep trading history */
    maxTradingHistoryHours: number;
}
/**
 * Database query result with count
 */
export interface QueryResult<T> {
    data: T[];
    count: number;
}
/**
 * Price history query options
 */
export interface PriceHistoryOptions {
    /** Filter by time range (seconds) */
    seconds?: number;
    /** Limit number of results */
    limit?: number;
    /** Offset for pagination */
    offset?: number;
}
/**
 * Cycle information
 */
export interface CycleInfo {
    cycle_id: string;
    cycle_start_time: number;
}
//# sourceMappingURL=database.types.d.ts.map