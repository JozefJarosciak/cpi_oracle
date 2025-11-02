/**
 * History repository - handles settlement and trading history
 */
import Database from 'better-sqlite3';
import { SettlementHistoryRow, TradingHistoryRow } from '../types';
/**
 * Repository for managing settlement and trading history
 */
export declare class HistoryRepository {
    private db;
    constructor(db: Database.Database);
    /**
     * Add a settlement record
     */
    addSettlement(userPrefix: string, result: string, amount: number, side: string, snapshotPrice?: number | null, settlePrice?: number | null): boolean;
    /**
     * Get settlement history (most recent first)
     */
    getSettlements(limit?: number): SettlementHistoryRow[];
    /**
     * Get settlement history for a specific user
     */
    getSettlementsByUser(userPrefix: string, limit?: number): SettlementHistoryRow[];
    /**
     * Clean up old settlement records
     */
    cleanupSettlements(maxAgeHours: number): number;
    /**
     * Add a trading record
     */
    addTrade(userPrefix: string, action: string, side: string, shares: number, costUsd: number, avgPrice: number, pnl?: number | null): boolean;
    /**
     * Get trading history for a specific user
     */
    getTradesByUser(userPrefix: string, limit?: number): TradingHistoryRow[];
    /**
     * Get all trading history (most recent first)
     */
    getAllTrades(limit?: number): TradingHistoryRow[];
    /**
     * Clean up old trading records
     */
    cleanupTrades(maxAgeHours: number): number;
}
//# sourceMappingURL=history.repository.d.ts.map