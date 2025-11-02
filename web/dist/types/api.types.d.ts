/**
 * API request and response type definitions
 */
import { CumulativeVolume, PriceHistoryRow, SettlementHistoryRow, TradingHistoryRow, QuoteHistoryRow, CycleInfo } from './database.types';
import { AmmState } from './market.types';
/**
 * Volume update request
 */
export interface VolumeUpdateRequest {
    side: 'YES' | 'NO';
    amount: number;
    shares: number;
}
/**
 * Volume API response
 */
export interface VolumeResponse {
    success: boolean;
    volume?: CumulativeVolume;
    error?: string;
}
/**
 * Price history request
 */
export interface PriceHistoryRequest {
    seconds?: number;
}
/**
 * Price history response
 */
export interface PriceHistoryResponse {
    prices: PriceHistoryRow[];
    totalPoints: number;
    lastUpdate: number;
}
/**
 * Add price request
 */
export interface AddPriceRequest {
    price: number;
}
/**
 * Current price response
 */
export interface CurrentPriceResponse {
    price: number | null;
    lastUpdate: number | null;
}
/**
 * Settlement history request
 */
export interface AddSettlementRequest {
    userPrefix: string;
    result: string;
    amount: number;
    side: string;
    snapshotPrice?: number;
    settlePrice?: number;
}
/**
 * Settlement history response
 */
export interface SettlementHistoryResponse {
    history: SettlementHistoryRow[];
}
/**
 * Trading history request
 */
export interface AddTradingRequest {
    userPrefix: string;
    action: string;
    side: string;
    shares: number;
    costUsd: number;
    avgPrice: number;
    pnl?: number;
}
/**
 * Trading history response
 */
export interface TradingHistoryResponse {
    history: TradingHistoryRow[];
}
/**
 * Quote snapshot request
 */
export interface QuoteSnapshotRequest {
    cycleId: string;
    upPrice: number;
    downPrice: number;
}
/**
 * Quote history response
 */
export interface QuoteHistoryResponse {
    cycleId: string;
    history: QuoteHistoryRow[];
}
/**
 * Recent cycles response
 */
export interface RecentCyclesResponse {
    cycles: CycleInfo[];
}
/**
 * Generic success response
 */
export interface SuccessResponse {
    success: boolean;
    error?: string;
}
/**
 * Error response
 */
export interface ErrorResponse {
    error: string;
}
/**
 * SSE price update payload
 */
export interface SSEPriceUpdate {
    price: number;
    timestamp: number;
}
/**
 * SSE market update payload (includes cycle ID)
 */
export interface SSEMarketUpdate extends AmmState {
    cycleId: string | null;
}
/**
 * SSE volume update payload
 */
export interface SSEVolumeUpdate extends CumulativeVolume {
}
/**
 * Cycle status (from market_status.json)
 */
export interface CycleStatus {
    state: string;
    cycleId?: string;
    startTime?: number;
    endTime?: number;
    [key: string]: unknown;
}
/**
 * WebSocket message types
 */
export interface WebSocketPriceMessage {
    type: 'price';
    price: number;
    age: number;
    timestamp: number;
}
export type WebSocketMessage = WebSocketPriceMessage;
//# sourceMappingURL=api.types.d.ts.map