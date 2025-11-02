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
import { OracleService } from '../solana/oracle.service';
import { MarketService } from '../solana/market.service';
import { VolumeRepository } from '../database/volume.repository';
import type { ServerResponse } from 'http';
import * as fs from 'fs';
import * as path from 'path';

export interface StreamServiceConfig {
  connection: Connection;
  oracleStateKey: string;
  programId: string;
  ammSeed: string;
  volumeRepo?: VolumeRepository;
  enableLogging?: boolean;
}

export class StreamService {
  private oracleService: OracleService;
  private marketService: MarketService;
  private volumeRepo?: VolumeRepository;
  private enableLogging: boolean;

  // Active stream clients
  private priceClients: Set<ServerResponse> = new Set();
  private marketClients: Set<ServerResponse> = new Set();
  private volumeClients: Set<ServerResponse> = new Set();
  private cycleClients: Set<ServerResponse> = new Set();
  private statusClients: Set<ServerResponse> = new Set();

  // Stream intervals (undefined or Timeout, not mixed)
  private priceInterval: NodeJS.Timeout | undefined = undefined;
  private marketInterval: NodeJS.Timeout | undefined = undefined;
  private volumeInterval: NodeJS.Timeout | undefined = undefined;
  private cycleInterval: NodeJS.Timeout | undefined = undefined;

  // File watcher for market_status.json
  private statusFileWatcher: fs.FSWatcher | undefined = undefined;
  private readonly statusFilePath: string;

  constructor(config: StreamServiceConfig) {
    this.oracleService = new OracleService(
      config.connection,
      config.oracleStateKey,
      { enableLogging: config.enableLogging ?? false, pollInterval: 1000, maxAge: 90 }
    );

    this.marketService = new MarketService(
      config.connection,
      config.programId,
      { ammSeed: config.ammSeed, enableLogging: config.enableLogging ?? false, pollInterval: 1500, lamportsPerE6: 100 }
    );

    if (config.volumeRepo) {
      this.volumeRepo = config.volumeRepo;
    }
    this.enableLogging = config.enableLogging ?? false;

    // Path to market_status.json (one level up from web/)
    this.statusFilePath = path.join(__dirname, '..', '..', '..', 'market_status.json');
  }

  /**
   * Initialize SSE response headers
   */
  private initSSE(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write('\n');
  }

  /**
   * Send SSE event (without event name for compatibility with .onmessage)
   */
  private sendEvent(res: ServerResponse, _event: string, data: any): boolean {
    try {
      // Don't send event name - just data for compatibility with .onmessage listeners
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch (err) {
      return false;
    }
  }

  /**
   * Price Stream - Oracle BTC price updates
   */
  async addPriceClient(res: ServerResponse): Promise<void> {
    this.initSSE(res);
    this.priceClients.add(res);

    if (this.enableLogging) {
      console.log(`[StreamService] Price client added (${this.priceClients.size} active)`);
    }

    // Send initial data
    const price = await this.oracleService.fetchPrice();
    if (price) {
      this.sendEvent(res, 'price', price);
    }

    // Start polling if first client
    if (this.priceClients.size === 1) {
      this.priceInterval = setInterval(async () => {
        const currentPrice = await this.oracleService.fetchPrice();
        if (currentPrice) {
          this.broadcastToClients(this.priceClients, 'price', currentPrice);
        }
      }, 1000);
    }

    // Cleanup on disconnect
    res.on('close', () => {
      this.priceClients.delete(res);
      if (this.enableLogging) {
        console.log(`[StreamService] Price client removed (${this.priceClients.size} active)`);
      }
      if (this.priceClients.size === 0 && this.priceInterval) {
        clearInterval(this.priceInterval);
        this.priceInterval = undefined;
      }
    });
  }

  /**
   * Market Stream - Market state updates
   */
  async addMarketClient(res: ServerResponse): Promise<void> {
    this.initSSE(res);
    this.marketClients.add(res);

    if (this.enableLogging) {
      console.log(`[StreamService] Market client added (${this.marketClients.size} active)`);
    }

    // Send initial data
    const marketState = await this.marketService.fetchMarketState();
    if (marketState) {
      const lmsrPrices = this.marketService.calculatePrices(marketState);
      this.sendEvent(res, 'market', { ...marketState, lmsrPrices });
    }

    // Start polling if first client
    if (this.marketClients.size === 1) {
      this.marketInterval = setInterval(async () => {
        const currentMarket = await this.marketService.fetchMarketState();
        if (currentMarket) {
          const lmsrPrices = this.marketService.calculatePrices(currentMarket);
          this.broadcastToClients(this.marketClients, 'market', { ...currentMarket, lmsrPrices });
        }
      }, 1500);
    }

    // Cleanup on disconnect
    res.on('close', () => {
      this.marketClients.delete(res);
      if (this.enableLogging) {
        console.log(`[StreamService] Market client removed (${this.marketClients.size} active)`);
      }
      if (this.marketClients.size === 0 && this.marketInterval) {
        clearInterval(this.marketInterval);
        this.marketInterval = undefined;
      }
    });
  }

  /**
   * Volume Stream - Current cycle volume updates
   */
  async addVolumeClient(res: ServerResponse): Promise<void> {
    if (!this.volumeRepo) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Volume repository not configured' }));
      return;
    }

    this.initSSE(res);
    this.volumeClients.add(res);

    if (this.enableLogging) {
      console.log(`[StreamService] Volume client added (${this.volumeClients.size} active)`);
    }

    // Send initial data
    const volumeData = this.volumeRepo.loadCurrent();
    if (volumeData) {
      this.sendEvent(res, 'volume', volumeData);
    }

    // Start polling if first client
    if (this.volumeClients.size === 1) {
      this.volumeInterval = setInterval(() => {
        const currentVolume = this.volumeRepo!.loadCurrent();
        if (currentVolume) {
          this.broadcastToClients(this.volumeClients, 'volume', currentVolume);
        }
      }, 1000);
    }

    // Cleanup on disconnect
    res.on('close', () => {
      this.volumeClients.delete(res);
      if (this.enableLogging) {
        console.log(`[StreamService] Volume client removed (${this.volumeClients.size} active)`);
      }
      if (this.volumeClients.size === 0 && this.volumeInterval) {
        clearInterval(this.volumeInterval);
        this.volumeInterval = undefined;
      }
    });
  }

  /**
   * Cycle Stream - Volume cycle changes
   */
  async addCycleClient(res: ServerResponse): Promise<void> {
    if (!this.volumeRepo) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Volume repository not configured' }));
      return;
    }

    this.initSSE(res);
    this.cycleClients.add(res);

    if (this.enableLogging) {
      console.log(`[StreamService] Cycle client added (${this.cycleClients.size} active)`);
    }

    // Track current cycle ID
    let lastCycleId = this.volumeRepo.loadCurrent()?.cycleId;

    // Start polling if first client
    if (this.cycleClients.size === 1) {
      this.cycleInterval = setInterval(() => {
        const currentVolume = this.volumeRepo!.loadCurrent();
        if (currentVolume && currentVolume.cycleId !== lastCycleId) {
          lastCycleId = currentVolume.cycleId;
          this.broadcastToClients(this.cycleClients, 'cycle', {
            cycleId: currentVolume.cycleId,
            timestamp: Date.now()
          });
        }
      }, 1000);
    }

    // Cleanup on disconnect
    res.on('close', () => {
      this.cycleClients.delete(res);
      if (this.enableLogging) {
        console.log(`[StreamService] Cycle client removed (${this.cycleClients.size} active)`);
      }
      if (this.cycleClients.size === 0 && this.cycleInterval) {
        clearInterval(this.cycleInterval);
        this.cycleInterval = undefined;
      }
    });
  }

  /**
   * Market Status Stream - Watches market_status.json for changes
   */
  async addStatusClient(res: ServerResponse): Promise<void> {
    this.initSSE(res);
    this.statusClients.add(res);

    if (this.enableLogging) {
      console.log(`[StreamService] Status client added (${this.statusClients.size} active)`);
    }

    // Send initial data
    try {
      const statusData = fs.readFileSync(this.statusFilePath, 'utf8');
      const status = JSON.parse(statusData);
      this.sendEvent(res, 'status', status);
    } catch (err) {
      // File doesn't exist yet or settlement bot not running
      this.sendEvent(res, 'status', { state: 'OFFLINE' });
    }

    // Start file watcher if first client
    if (this.statusClients.size === 1) {
      try {
        this.statusFileWatcher = fs.watch(this.statusFilePath, (eventType) => {
          if (eventType === 'change') {
            try {
              const statusData = fs.readFileSync(this.statusFilePath, 'utf8');
              const status = JSON.parse(statusData);
              if (this.enableLogging) {
                console.log(`[StreamService] Market status updated: ${status.state}`);
              }
              this.broadcastToClients(this.statusClients, 'status', status);
            } catch (err) {
              if (this.enableLogging) {
                console.error('[StreamService] Failed to read market status:', err);
              }
            }
          }
        });
      } catch (err) {
        if (this.enableLogging) {
          console.error('[StreamService] Failed to watch market status file:', err);
        }
      }
    }

    // Cleanup on disconnect
    res.on('close', () => {
      this.statusClients.delete(res);
      if (this.enableLogging) {
        console.log(`[StreamService] Status client removed (${this.statusClients.size} active)`);
      }
      if (this.statusClients.size === 0 && this.statusFileWatcher) {
        this.statusFileWatcher.close();
        this.statusFileWatcher = undefined;
      }
    });
  }

  /**
   * Broadcast event to all clients in a set
   */
  private broadcastToClients(clients: Set<ServerResponse>, event: string, data: any): void {
    const deadClients: ServerResponse[] = [];

    for (const client of clients) {
      const success = this.sendEvent(client, event, data);
      if (!success) {
        deadClients.push(client);
      }
    }

    // Remove dead clients
    for (const dead of deadClients) {
      clients.delete(dead);
    }
  }

  /**
   * Cleanup all streams
   */
  cleanup(): void {
    if (this.priceInterval) clearInterval(this.priceInterval);
    if (this.marketInterval) clearInterval(this.marketInterval);
    if (this.volumeInterval) clearInterval(this.volumeInterval);
    if (this.cycleInterval) clearInterval(this.cycleInterval);
    if (this.statusFileWatcher) this.statusFileWatcher.close();

    this.priceClients.clear();
    this.marketClients.clear();
    this.volumeClients.clear();
    this.cycleClients.clear();
    this.statusClients.clear();
  }
}
