"use strict";
/**
 * StreamService - Server-Sent Events (SSE) stream management
 *
 * Provides type-safe SSE streaming for real-time data:
 * - Price updates (Oracle BTC price)
 * - Market state updates
 * - Volume cycle tracking
 * - Database synchronization
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.StreamService = void 0;
const oracle_service_1 = require("../solana/oracle.service");
const market_service_1 = require("../solana/market.service");
class StreamService {
    constructor(config) {
        // Active stream clients
        this.priceClients = new Set();
        this.marketClients = new Set();
        this.volumeClients = new Set();
        this.cycleClients = new Set();
        // Stream intervals (undefined or Timeout, not mixed)
        this.priceInterval = undefined;
        this.marketInterval = undefined;
        this.volumeInterval = undefined;
        this.cycleInterval = undefined;
        this.oracleService = new oracle_service_1.OracleService(config.connection, config.oracleStateKey, { enableLogging: config.enableLogging ?? false, pollInterval: 1000, maxAge: 90 });
        this.marketService = new market_service_1.MarketService(config.connection, config.programId, { ammSeed: config.ammSeed, enableLogging: config.enableLogging ?? false, pollInterval: 1500, lamportsPerE6: 100 });
        if (config.volumeRepo) {
            this.volumeRepo = config.volumeRepo;
        }
        this.enableLogging = config.enableLogging ?? false;
    }
    /**
     * Initialize SSE response headers
     */
    initSSE(res) {
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
    sendEvent(res, _event, data) {
        try {
            // Don't send event name - just data for compatibility with .onmessage listeners
            res.write(`data: ${JSON.stringify(data)}\n\n`);
            return true;
        }
        catch (err) {
            return false;
        }
    }
    /**
     * Price Stream - Oracle BTC price updates
     */
    async addPriceClient(res) {
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
    async addMarketClient(res) {
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
    async addVolumeClient(res) {
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
                const currentVolume = this.volumeRepo.loadCurrent();
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
    async addCycleClient(res) {
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
                const currentVolume = this.volumeRepo.loadCurrent();
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
     * Broadcast event to all clients in a set
     */
    broadcastToClients(clients, event, data) {
        const deadClients = [];
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
    cleanup() {
        if (this.priceInterval)
            clearInterval(this.priceInterval);
        if (this.marketInterval)
            clearInterval(this.marketInterval);
        if (this.volumeInterval)
            clearInterval(this.volumeInterval);
        if (this.cycleInterval)
            clearInterval(this.cycleInterval);
        this.priceClients.clear();
        this.marketClients.clear();
        this.volumeClients.clear();
        this.cycleClients.clear();
    }
}
exports.StreamService = StreamService;
//# sourceMappingURL=stream.service.js.map