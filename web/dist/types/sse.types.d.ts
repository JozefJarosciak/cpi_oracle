/**
 * Server-Sent Events (SSE) type definitions
 */
import { ServerResponse } from 'http';
/**
 * SSE client connection
 */
export type SSEClient = ServerResponse;
/**
 * SSE stream types
 */
export declare enum SSEStreamType {
    Price = "price",
    Market = "market",
    Volume = "volume",
    Cycle = "cycle"
}
/**
 * SSE message payload (generic)
 */
export interface SSEMessage<T = unknown> {
    data: T;
    event?: string;
    id?: string;
    retry?: number;
}
/**
 * SSE client manager interface
 */
export interface SSEClientManager {
    /** Add a new client to the pool */
    addClient(client: SSEClient): void;
    /** Remove a client from the pool */
    removeClient(client: SSEClient): void;
    /** Get number of connected clients */
    getClientCount(): number;
    /** Broadcast data to all connected clients */
    broadcast<T>(data: T): void;
    /** Clean up disconnected clients */
    cleanup(): void;
}
//# sourceMappingURL=sse.types.d.ts.map