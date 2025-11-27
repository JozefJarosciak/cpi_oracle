/**
 * StreamService - Server-Sent Events (SSE) stream management
 *
 * Provides type-safe SSE streaming for real-time data:
 * - Price updates (Oracle BTC price)
 * - Market state updates
 * - Volume cycle tracking
 * - Database synchronization
 */
import { Connection } from '@solana/web3.js';
import { VolumeRepository } from '../database/volume.repository';
import type { ServerResponse } from 'http';
export interface StreamServiceConfig {
    connection: Connection;
    oracleStateKey: string;
    programId: string;
    ammSeed: string;
    volumeRepo?: VolumeRepository;
    enableLogging?: boolean;
}
export declare class StreamService {
    private oracleService;
    private marketService;
    private volumeRepo?;
    private enableLogging;
    private priceClients;
    private marketClients;
    private volumeClients;
    private cycleClients;
    private statusClients;
    private priceInterval;
    private marketInterval;
    private volumeInterval;
    private cycleInterval;
    private statusFileWatcher;
    private readonly statusFilePath;
    constructor(config: StreamServiceConfig);
    /**
     * Start the price ticker on server startup (runs forever)
     */
    private startPriceTicker;
    /**
     * Initialize SSE response headers
     */
    private initSSE;
    /**
     * Send SSE event (without event name for compatibility with .onmessage)
     */
    private sendEvent;
    /**
     * Price Stream - Oracle BTC price updates
     */
    addPriceClient(res: ServerResponse): Promise<void>;
    /**
     * Market Stream - Market state updates
     */
    addMarketClient(res: ServerResponse): Promise<void>;
    /**
     * Volume Stream - Current cycle volume updates
     */
    addVolumeClient(res: ServerResponse): Promise<void>;
    /**
     * Cycle Stream - Volume cycle changes
     */
    addCycleClient(res: ServerResponse): Promise<void>;
    /**
     * Market Status Stream - Watches market_status.json for changes
     */
    addStatusClient(res: ServerResponse): Promise<void>;
    /**
     * Broadcast event to all clients in a set
     */
    private broadcastToClients;
    /**
     * Cleanup all streams
     */
    cleanup(): void;
}
//# sourceMappingURL=stream.service.d.ts.map