const http = require('http');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { Connection, PublicKey } = require('@solana/web3.js');
const WebSocket = require('ws');

const PORT = 3434;
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATUS_FILE = path.join(__dirname, '..', 'market_status.json');
const DB_FILE = path.join(__dirname, 'price_history.db');
const VOLUME_FILE = path.join(__dirname, 'cumulative_volume.json');

// Solana Oracle Configuration
const RPC_URL = 'https://rpc.testnet.x1.xyz';
const ORACLE_STATE = '4KYeNyv1B9YjjQkfJk2C6Uqo71vKzFZriRe5NXg6GyCq';
const ORACLE_POLL_INTERVAL = 1000; // 1 second (for real-time UI updates)

// Solana connection
const connection = new Connection(RPC_URL, 'confirmed');
const oracleKey = new PublicKey(ORACLE_STATE);

// Current BTC price cache
let currentBTCPrice = null;
let lastOracleUpdate = null;

// SSE clients for price updates
const sseClients = new Set();

// SSE clients for market data updates
const marketStreamClients = new Set();

// SSE clients for volume updates
const volumeStreamClients = new Set();

// SSE clients for cycle status updates
const cycleStreamClients = new Set();

// AMM Configuration
const PROGRAM_ID = 'EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF';
const AMM_SEED = 'amm_btc_v6';
const MARKET_POLL_INTERVAL = 1500; // 1.5 seconds

// Current market data cache
let currentMarketData = null;
let lastMarketUpdate = null;

// SQLite database for price history
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL'); // Better concurrency

// Ensure schema exists
db.exec(`
    CREATE TABLE IF NOT EXISTS price_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        price REAL NOT NULL,
        timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON price_history(timestamp);

    CREATE TABLE IF NOT EXISTS settlement_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_prefix TEXT NOT NULL,
        result TEXT NOT NULL,
        amount REAL NOT NULL,
        side TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        snapshot_price REAL,
        settle_price REAL
    );
    CREATE INDEX IF NOT EXISTS idx_settlement_timestamp ON settlement_history(timestamp);

    CREATE TABLE IF NOT EXISTS trading_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_prefix TEXT NOT NULL,
        action TEXT NOT NULL,
        side TEXT NOT NULL,
        shares REAL NOT NULL,
        cost_usd REAL NOT NULL,
        avg_price REAL NOT NULL,
        pnl REAL,
        timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trading_user_timestamp ON trading_history(user_prefix, timestamp DESC);

    CREATE TABLE IF NOT EXISTS volume_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cycle_id TEXT NOT NULL UNIQUE,
        cycle_start_time INTEGER NOT NULL,
        up_volume REAL NOT NULL DEFAULT 0,
        down_volume REAL NOT NULL DEFAULT 0,
        total_volume REAL NOT NULL DEFAULT 0,
        up_shares REAL NOT NULL DEFAULT 0,
        down_shares REAL NOT NULL DEFAULT 0,
        total_shares REAL NOT NULL DEFAULT 0,
        last_update INTEGER NOT NULL,
        market_state TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_volume_cycle ON volume_history(cycle_id);
    CREATE INDEX IF NOT EXISTS idx_volume_start_time ON volume_history(cycle_start_time DESC);
`);

const MAX_PRICE_HISTORY_HOURS = 24; // Keep up to 24 hours of price data
const MAX_SETTLEMENT_HISTORY_HOURS = 168; // Keep 7 days of settlement history
const MAX_TRADING_HISTORY_HOURS = 168; // Keep 7 days of trading history

// Current market volume (persisted to SQLite per cycle)
let cumulativeVolume = {
    cycleId: null,   // Unique ID for this market cycle (timestamp-based)
    upVolume: 0,     // Total XNT spent on UP/YES trades this cycle
    downVolume: 0,   // Total XNT spent on DOWN/NO trades this cycle
    totalVolume: 0,  // Sum of both
    upShares: 0,     // Total shares bought on UP/YES side
    downShares: 0,   // Total shares bought on DOWN/NO side
    totalShares: 0,  // Sum of both
    lastUpdate: 0,   // Timestamp of last update
    cycleStartTime: Date.now() // When this market cycle started
};

// Get price history count
function getPriceHistoryCount() {
    try {
        const result = db.prepare('SELECT COUNT(*) as count FROM price_history').get();
        return result.count;
    } catch (err) {
        console.error('Failed to get price count:', err.message);
        return 0;
    }
}

// Get price history for a time range
function getPriceHistory(seconds = null) {
    try {
        let stmt;
        if (seconds) {
            const cutoffTime = Date.now() - (seconds * 1000);
            stmt = db.prepare('SELECT price, timestamp FROM price_history WHERE timestamp >= ? ORDER BY timestamp ASC');
            return stmt.all(cutoffTime);
        } else {
            stmt = db.prepare('SELECT price, timestamp FROM price_history ORDER BY timestamp ASC');
            return stmt.all();
        }
    } catch (err) {
        console.error('Failed to query price history:', err.message);
        return [];
    }
}

// Add price to history
function addPriceToHistory(price, timestamp = Date.now()) {
    try {
        const stmt = db.prepare('INSERT INTO price_history (price, timestamp) VALUES (?, ?)');
        stmt.run(price, timestamp);
        return true;
    } catch (err) {
        console.error('Failed to add price:', err.message);
        return false;
    }
}

// Cleanup old price data (older than MAX_PRICE_HISTORY_HOURS)
function cleanupOldPrices() {
    try {
        const cutoffTime = Date.now() - (MAX_PRICE_HISTORY_HOURS * 60 * 60 * 1000);
        const stmt = db.prepare('DELETE FROM price_history WHERE timestamp < ?');
        const result = stmt.run(cutoffTime);
        if (result.changes > 0) {
            console.log(`Cleaned up ${result.changes} old price records`);
        }
        return result.changes;
    } catch (err) {
        console.error('Failed to cleanup old prices:', err.message);
        return 0;
    }
}

// Fetch BTC price from Solana oracle
async function fetchOraclePrice() {
    try {
        const accountInfo = await connection.getAccountInfo(oracleKey);

        if (!accountInfo) {
            console.error('Oracle account not found');
            return null;
        }

        const d = accountInfo.data;
        if (d.length < 8 + 32 + 48*3 + 2) {
            console.error('Oracle data invalid');
            return null;
        }

        let o = 8; // Skip discriminator
        o += 32; // Skip update_authority

        // Read triplet (price values and timestamps)
        const readI64 = () => {
            const v = d.readBigInt64LE(o);
            o += 8;
            return v;
        };

        const p1 = readI64();
        const p2 = readI64();
        const p3 = readI64();
        const t1 = readI64();
        const t2 = readI64();
        const t3 = readI64();

        o += 96; // Skip ETH + SOL
        const decimals = d.readUInt8(o);

        // Calculate median price
        const median3 = (a, b, c) => {
            const arr = [a, b, c].sort((x, y) => (x < y ? -1 : (x > y ? 1 : 0)));
            return arr[1];
        };

        const priceRaw = median3(p1, p2, p3);
        const scale = 10n ** BigInt(decimals);
        const price_e6 = (priceRaw * 1_000_000n) / scale;
        const btcPrice = Number(price_e6) / 1_000_000;

        // Calculate age
        const maxTs = [t1, t2, t3].reduce((a, b) => a > b ? a : b);
        const age = Math.floor(Date.now() / 1000) - Number(maxTs);

        console.log(`📊 Oracle: BTC $${btcPrice.toFixed(2)} (age: ${age}s)`);

        return {
            price: btcPrice,
            age: age,
            timestamp: Date.now()
        };
    } catch (err) {
        console.error('Failed to fetch oracle price:', err.message);
        return null;
    }
}

// Fetch market data from Solana AMM account
async function fetchMarketData() {
    try {
        // Derive AMM PDA
        const [ammPda] = await PublicKey.findProgramAddressSync(
            [Buffer.from(AMM_SEED)],
            new PublicKey(PROGRAM_ID)
        );
        console.log('[SERVER fetchMarketData] Using AMM_SEED:', AMM_SEED, 'PDA:', ammPda.toString());

        const accountInfo = await connection.getAccountInfo(ammPda);
        if (!accountInfo) {
            console.error('Market account not found at:', ammPda.toString());
            return null;
        }

        const d = accountInfo.data;
        if (d.length < 8 + 62) {
            console.error('Market data invalid');
            return null;
        }

        const p = d.subarray(8);
        let o = 0;

        // Read AMM struct fields
        const readU8 = (offset) => p.readUInt8(offset);
        const readU16LE = (offset) => p.readUInt16LE(offset);
        const readI64LE = (offset) => p.readBigInt64LE(offset);

        const bump = readU8(o); o += 1;
        const decimals = readU8(o); o += 1;
        const bScaled = readI64LE(o); o += 8;
        const feeBps = readU16LE(o); o += 2;
        const qY = readI64LE(o); o += 8;
        const qN = readI64LE(o); o += 8;
        const fees = readI64LE(o); o += 8;
        const vault = readI64LE(o); o += 8;
        const status = readU8(o); o += 1;
        const winner = readU8(o); o += 1;
        const wTotal = readI64LE(o); o += 8;
        const pps = readI64LE(o); o += 8;
        o += 32; // Skip fee_dest pubkey
        const vaultSolBump = readU8(o); o += 1;
        const startPriceE6 = readI64LE(o); o += 8;

        // Convert to JavaScript numbers (e6 scale)
        // NOTE: vault uses LAMPORTS_PER_E6 = 100, so 1 XNT = 10_000_000 e6 units
        const marketData = {
            bScaled: Number(bScaled) / 1_000_000,
            feeBps: feeBps,
            qYes: Number(qY) / 1_000_000,
            qNo: Number(qN) / 1_000_000,
            fees: Number(fees) / 1_000_000,
            vault: Number(vault) / 10_000_000,  // ✅ Fixed: vault uses different scale (LAMPORTS_PER_E6 = 100)
            status: status, // 0=Open, 1=Stopped, 2=Settled
            winner: winner, // 0=None, 1=Yes, 2=No
            winningTotal: Number(wTotal) / 1_000_000,
            pricePerShare: Number(pps) / 1_000_000,
            startPrice: Number(startPriceE6) / 1_000_000,
            timestamp: Date.now()
        };

        console.log(`📈 Market: status=${status} vault=${marketData.vault.toFixed(2)} qY=${marketData.qYes.toFixed(2)} qN=${marketData.qNo.toFixed(2)}`);

        return marketData;
    } catch (err) {
        console.error('Failed to fetch market data:', err.message);
        return null;
    }
}

// Load cumulative volume from SQLite (current cycle)
function loadCumulativeVolume() {
    try {
        // Try to load the most recent cycle
        const stmt = db.prepare('SELECT * FROM volume_history ORDER BY cycle_start_time DESC LIMIT 1');
        const row = stmt.get();

        if (row) {
            cumulativeVolume = {
                cycleId: row.cycle_id,
                upVolume: row.up_volume,
                downVolume: row.down_volume,
                totalVolume: row.total_volume,
                upShares: row.up_shares,
                downShares: row.down_shares,
                totalShares: row.total_shares,
                lastUpdate: row.last_update,
                cycleStartTime: row.cycle_start_time
            };
            console.log(`Loaded volume for cycle ${row.cycle_id}: ${row.total_volume.toFixed(2)} XNT total`);
        } else {
            // No existing cycle, start fresh
            const cycleId = `cycle_${Date.now()}`;
            cumulativeVolume = {
                cycleId: cycleId,
                upVolume: 0,
                downVolume: 0,
                totalVolume: 0,
                upShares: 0,
                downShares: 0,
                totalShares: 0,
                lastUpdate: Date.now(),
                cycleStartTime: Date.now()
            };
            saveCumulativeVolume();
            console.log(`New volume cycle started: ${cycleId}`);
        }
    } catch (err) {
        console.error('Failed to load volume from database:', err.message);
        // Fallback to fresh state
        const cycleId = `cycle_${Date.now()}`;
        cumulativeVolume = {
            cycleId: cycleId,
            upVolume: 0,
            downVolume: 0,
            totalVolume: 0,
            upShares: 0,
            downShares: 0,
            totalShares: 0,
            lastUpdate: Date.now(),
            cycleStartTime: Date.now()
        };
    }
}

// Save cumulative volume to SQLite
function saveCumulativeVolume() {
    try {
        const stmt = db.prepare(`
            INSERT INTO volume_history (
                cycle_id, cycle_start_time, up_volume, down_volume, total_volume,
                up_shares, down_shares, total_shares, last_update, market_state
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(cycle_id) DO UPDATE SET
                up_volume = excluded.up_volume,
                down_volume = excluded.down_volume,
                total_volume = excluded.total_volume,
                up_shares = excluded.up_shares,
                down_shares = excluded.down_shares,
                total_shares = excluded.total_shares,
                last_update = excluded.last_update,
                market_state = excluded.market_state
        `);

        stmt.run(
            cumulativeVolume.cycleId,
            cumulativeVolume.cycleStartTime,
            cumulativeVolume.upVolume,
            cumulativeVolume.downVolume,
            cumulativeVolume.totalVolume,
            cumulativeVolume.upShares,
            cumulativeVolume.downShares,
            cumulativeVolume.totalShares,
            cumulativeVolume.lastUpdate,
            null // market_state (can be populated later if needed)
        );
    } catch (err) {
        console.error('Failed to save volume to database:', err.message);
    }
}

// Settlement history functions
function addSettlementHistory(userPrefix, result, amount, side, snapshotPrice = null, settlePrice = null) {
    try {
        const timestamp = Date.now();

        // Get timestamp of last settlement for this user to determine cycle boundary
        let cycleStartTime = 0;
        const lastSettlementStmt = db.prepare('SELECT timestamp FROM settlement_history WHERE user_prefix = ? ORDER BY timestamp DESC LIMIT 1');
        const lastSettlement = lastSettlementStmt.get(userPrefix);
        if (lastSettlement) {
            cycleStartTime = lastSettlement.timestamp;
        }

        // Calculate total buys, sells, and net spent from trading history SINCE LAST SETTLEMENT
        let totalBuys = 0;
        let totalSells = 0;

        const tradingStmt = db.prepare('SELECT action, cost_usd FROM trading_history WHERE user_prefix = ? AND timestamp > ? AND timestamp <= ? ORDER BY timestamp ASC');
        const trades = tradingStmt.all(userPrefix, cycleStartTime, timestamp);

        for (const trade of trades) {
            if (trade.action === 'BUY') {
                totalBuys += trade.cost_usd;
            } else if (trade.action === 'SELL') {
                totalSells += trade.cost_usd;
            }
        }

        const netSpent = totalBuys - totalSells;

        const stmt = db.prepare('INSERT INTO settlement_history (user_prefix, result, amount, side, timestamp, snapshot_price, settle_price, total_buys, total_sells, net_spent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        stmt.run(userPrefix, result, amount, side, timestamp, snapshotPrice, settlePrice, totalBuys, totalSells, netSpent);
        return true;
    } catch (err) {
        console.error('Failed to add settlement:', err.message);
        return false;
    }
}

function getSettlementHistory(limit = 100) {
    try {
        const stmt = db.prepare('SELECT * FROM settlement_history ORDER BY timestamp DESC LIMIT ?');
        return stmt.all(limit);
    } catch (err) {
        console.error('Failed to get settlement history:', err.message);
        return [];
    }
}

function cleanupOldSettlements() {
    try {
        const cutoffTime = Date.now() - (MAX_SETTLEMENT_HISTORY_HOURS * 60 * 60 * 1000);
        const stmt = db.prepare('DELETE FROM settlement_history WHERE timestamp < ?');
        const result = stmt.run(cutoffTime);
        if (result.changes > 0) {
            console.log(`Cleaned up ${result.changes} old settlement records`);
        }
        return result.changes;
    } catch (err) {
        console.error('Failed to cleanup old settlements:', err.message);
        return 0;
    }
}

// Trading history functions
function addTradingHistory(userPrefix, action, side, shares, costUsd, avgPrice, pnl = null) {
    try {
        const stmt = db.prepare('INSERT INTO trading_history (user_prefix, action, side, shares, cost_usd, avg_price, pnl, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
        stmt.run(userPrefix, action, side, shares, costUsd, avgPrice, pnl, Date.now());
        return true;
    } catch (err) {
        console.error('Failed to add trading history:', err.message);
        return false;
    }
}

function getTradingHistory(userPrefix, limit = 100) {
    try {
        const stmt = db.prepare('SELECT * FROM trading_history WHERE user_prefix = ? ORDER BY timestamp DESC LIMIT ?');
        return stmt.all(userPrefix, limit);
    } catch (err) {
        console.error('Failed to get trading history:', err.message);
        return [];
    }
}

function cleanupOldTradingHistory() {
    try {
        const cutoffTime = Date.now() - (MAX_TRADING_HISTORY_HOURS * 60 * 60 * 1000);
        const stmt = db.prepare('DELETE FROM trading_history WHERE timestamp < ?');
        const result = stmt.run(cutoffTime);
        if (result.changes > 0) {
            console.log(`Cleaned up ${result.changes} old trading records`);
        }
        return result.changes;
    } catch (err) {
        console.error('Failed to cleanup old trading history:', err.message);
        return 0;
    }
}

// Initialize volume and show DB stats
loadCumulativeVolume();

// Log database statistics
const priceCount = getPriceHistoryCount();
const settlementCount = db.prepare('SELECT COUNT(*) as count FROM settlement_history').get().count;
const tradingCount = db.prepare('SELECT COUNT(*) as count FROM trading_history').get().count;
console.log(`SQLite database loaded with ${priceCount} price records, ${settlementCount} settlement records, and ${tradingCount} trading records`);

// Run cleanup on startup
cleanupOldPrices();
cleanupOldSettlements();
cleanupOldTradingHistory();

// Schedule periodic cleanup (every hour)
setInterval(() => {
    cleanupOldPrices();
    cleanupOldSettlements();
    cleanupOldTradingHistory();
}, 60 * 60 * 1000);

// Security headers
const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com; style-src 'self' 'unsafe-inline'; connect-src 'self' https://rpc.testnet.x1.xyz wss://rpc.testnet.x1.xyz ws://localhost:3435 wss://localhost:3435 http://127.0.0.1:8899 http://localhost:8899; img-src 'self' data:; font-src 'self'"
};

const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
    // API: Get cumulative volume
    if (req.url === '/api/volume' && req.method === 'GET') {
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            ...SECURITY_HEADERS
        });
        res.end(JSON.stringify(cumulativeVolume));
        return;
    }

    // API: Add to cumulative volume (only increases, never decreases)
    if (req.url === '/api/volume' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
            if (body.length > 1000) {
                req.connection.destroy();
            }
        });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const side = data.side; // 'YES' or 'NO'
                const amount = parseFloat(data.amount); // XNT amount
                const shares = parseFloat(data.shares); // Number of shares

                if ((side === 'YES' || side === 'NO') && amount > 0 && shares > 0) {
                    // Add to current market volume
                    if (side === 'YES') {
                        cumulativeVolume.upVolume += amount;
                        cumulativeVolume.upShares += shares;
                    } else {
                        cumulativeVolume.downVolume += amount;
                        cumulativeVolume.downShares += shares;
                    }
                    cumulativeVolume.totalVolume = cumulativeVolume.upVolume + cumulativeVolume.downVolume;
                    cumulativeVolume.totalShares = cumulativeVolume.upShares + cumulativeVolume.downShares;
                    cumulativeVolume.lastUpdate = Date.now();

                    // Save to disk
                    saveCumulativeVolume();

                    // Broadcast to SSE clients
                    broadcastVolume(cumulativeVolume);

                    console.log(`Volume updated: ${side} +${amount.toFixed(2)} XNT / +${shares.toFixed(2)} shares (Total: ${cumulativeVolume.totalVolume.toFixed(2)} XNT / ${cumulativeVolume.totalShares.toFixed(2)} shares)`);

                    res.writeHead(200, {
                        'Content-Type': 'application/json',
                        ...SECURITY_HEADERS
                    });
                    res.end(JSON.stringify({ success: true, volume: cumulativeVolume }));
                } else {
                    res.writeHead(400, {
                        'Content-Type': 'application/json',
                        ...SECURITY_HEADERS
                    });
                    res.end(JSON.stringify({ error: 'Invalid side, amount, or shares' }));
                }
            } catch (err) {
                res.writeHead(400, {
                    'Content-Type': 'application/json',
                    ...SECURITY_HEADERS
                });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    // API: Reset volume for new market cycle
    if (req.url === '/api/volume/reset' && req.method === 'POST') {
        // Create new cycle with unique ID
        const cycleId = `cycle_${Date.now()}`;
        cumulativeVolume = {
            cycleId: cycleId,
            upVolume: 0,
            downVolume: 0,
            totalVolume: 0,
            upShares: 0,
            downShares: 0,
            totalShares: 0,
            lastUpdate: Date.now(),
            cycleStartTime: Date.now()
        };
        saveCumulativeVolume();
        console.log(`📊 Volume reset - new cycle started: ${cycleId}`);

        res.writeHead(200, {
            'Content-Type': 'application/json',
            ...SECURITY_HEADERS
        });
        res.end(JSON.stringify({ success: true, volume: cumulativeVolume }));
        return;
    }

    // API: Get price history
    if (req.url.startsWith('/api/price-history') && req.method === 'GET') {
        // Parse query parameters for time range
        const urlObj = new URL(req.url, `http://${req.headers.host}`);
        const seconds = parseInt(urlObj.searchParams.get('seconds')) || null;

        // Query from SQLite
        const prices = getPriceHistory(seconds);
        const totalCount = getPriceHistoryCount();

        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            ...SECURITY_HEADERS
        });
        res.end(JSON.stringify({
            prices: prices,
            totalPoints: totalCount,
            lastUpdate: Date.now()
        }));
        return;
    }

    // API: Add price to history
    if (req.url === '/api/price-history' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
            // Prevent huge payloads
            if (body.length > 1000) {
                req.connection.destroy();
            }
        });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                if (typeof data.price === 'number' && data.price > 0) {
                    // Add to SQLite database
                    const success = addPriceToHistory(data.price);

                    if (success) {
                        const count = getPriceHistoryCount();
                        res.writeHead(200, {
                            'Content-Type': 'application/json',
                            ...SECURITY_HEADERS
                        });
                        res.end(JSON.stringify({ success: true, count: count }));
                    } else {
                        res.writeHead(500, {
                            'Content-Type': 'application/json',
                            ...SECURITY_HEADERS
                        });
                        res.end(JSON.stringify({ error: 'Failed to save price' }));
                    }
                } else {
                    res.writeHead(400, {
                        'Content-Type': 'application/json',
                        ...SECURITY_HEADERS
                    });
                    res.end(JSON.stringify({ error: 'Invalid price' }));
                }
            } catch (err) {
                res.writeHead(400, {
                    'Content-Type': 'application/json',
                    ...SECURITY_HEADERS
                });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    // API: Get current BTC price from oracle cache
    if (req.url === '/api/current-price' && req.method === 'GET') {
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            ...SECURITY_HEADERS
        });
        res.end(JSON.stringify({
            price: currentBTCPrice,
            lastUpdate: lastOracleUpdate
        }));
        return;
    }

    // SSE: Stream price updates
    if (req.url === '/api/price-stream' && req.method === 'GET') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            ...SECURITY_HEADERS
        });

        // Send initial price immediately
        if (currentBTCPrice !== null) {
            res.write(`data: ${JSON.stringify({ price: currentBTCPrice, timestamp: lastOracleUpdate })}\n\n`);
        }

        // Add client to set
        sseClients.add(res);
        console.log(`SSE client connected (${sseClients.size} total)`);

        // Remove client on disconnect
        req.on('close', () => {
            sseClients.delete(res);
            console.log(`SSE client disconnected (${sseClients.size} remaining)`);
        });

        return;
    }

    // SSE: Stream market data updates
    if (req.url === '/api/market-stream' && req.method === 'GET') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            ...SECURITY_HEADERS
        });

        // Send initial market data immediately
        if (currentMarketData !== null) {
            res.write(`data: ${JSON.stringify(currentMarketData)}\n\n`);
        }

        // Add client to set
        marketStreamClients.add(res);
        console.log(`Market SSE client connected (${marketStreamClients.size} total)`);

        // Remove client on disconnect
        req.on('close', () => {
            marketStreamClients.delete(res);
            console.log(`Market SSE client disconnected (${marketStreamClients.size} remaining)`);
        });

        return;
    }

    // SSE: Stream volume updates
    if (req.url === '/api/volume-stream' && req.method === 'GET') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            ...SECURITY_HEADERS
        });

        // Send initial volume data immediately
        res.write(`data: ${JSON.stringify(cumulativeVolume)}\n\n`);

        // Add client to set
        volumeStreamClients.add(res);
        console.log(`Volume SSE client connected (${volumeStreamClients.size} total)`);

        // Remove client on disconnect
        req.on('close', () => {
            volumeStreamClients.delete(res);
            console.log(`Volume SSE client disconnected (${volumeStreamClients.size} remaining)`);
        });

        return;
    }

    // SSE: Stream cycle status updates
    if (req.url === '/api/cycle-stream' && req.method === 'GET') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            ...SECURITY_HEADERS
        });

        // Send initial cycle status (read from file if exists)
        try {
            const cycleStatusPath = path.join(__dirname, '..', 'market_status.json');
            console.log(`[Cycle SSE] Reading initial status from: ${cycleStatusPath}`);
            const cycleStatusRaw = fs.readFileSync(cycleStatusPath, 'utf8');
            // Parse and re-stringify to ensure compact JSON (no newlines)
            const cycleStatusObj = JSON.parse(cycleStatusRaw);
            const cycleStatus = JSON.stringify(cycleStatusObj);
            console.log(`[Cycle SSE] Initial status data: ${cycleStatus}`);
            res.write(`data: ${cycleStatus}\n\n`);
        } catch (err) {
            // File doesn't exist, send offline status
            console.error(`[Cycle SSE] Failed to read status file, sending OFFLINE:`, err.message);
            const offlineStatus = JSON.stringify({ state: 'OFFLINE' });
            console.log(`[Cycle SSE] Sending offline status: ${offlineStatus}`);
            res.write(`data: ${offlineStatus}\n\n`);
        }

        // Add client to set
        cycleStreamClients.add(res);
        console.log(`[Cycle SSE] Client connected (${cycleStreamClients.size} total)`);

        // Remove client on disconnect
        req.on('close', () => {
            cycleStreamClients.delete(res);
            console.log(`[Cycle SSE] Client disconnected (${cycleStreamClients.size} remaining)`);
        });

        return;
    }

    // API: Get settlement history
    if (req.url === '/api/settlement-history' && req.method === 'GET') {
        const history = getSettlementHistory(100);
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            ...SECURITY_HEADERS
        });
        res.end(JSON.stringify({ history: history }));
        return;
    }

    // API: Add settlement to history
    if (req.url === '/api/settlement-history' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
            if (body.length > 1000) {
                req.connection.destroy();
            }
        });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                if (data.userPrefix && data.result && typeof data.amount === 'number' && data.side) {
                    const success = addSettlementHistory(
                        data.userPrefix,
                        data.result,
                        data.amount,
                        data.side,
                        data.snapshotPrice || null,
                        data.settlePrice || null
                    );
                    if (success) {
                        res.writeHead(200, {
                            'Content-Type': 'application/json',
                            ...SECURITY_HEADERS
                        });
                        res.end(JSON.stringify({ success: true }));
                    } else {
                        res.writeHead(500, {
                            'Content-Type': 'application/json',
                            ...SECURITY_HEADERS
                        });
                        res.end(JSON.stringify({ error: 'Failed to save settlement' }));
                    }
                } else {
                    res.writeHead(400, {
                        'Content-Type': 'application/json',
                        ...SECURITY_HEADERS
                    });
                    res.end(JSON.stringify({ error: 'Invalid settlement data' }));
                }
            } catch (err) {
                res.writeHead(400, {
                    'Content-Type': 'application/json',
                    ...SECURITY_HEADERS
                });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    // API: Get trading history for a user
    if (req.url.startsWith('/api/trading-history/') && req.method === 'GET') {
        const userPrefix = req.url.split('/api/trading-history/')[1];
        if (userPrefix && userPrefix.length >= 6) {
            const history = getTradingHistory(userPrefix, 100);
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                ...SECURITY_HEADERS
            });
            res.end(JSON.stringify({ history: history }));
        } else {
            res.writeHead(400, {
                'Content-Type': 'application/json',
                ...SECURITY_HEADERS
            });
            res.end(JSON.stringify({ error: 'Invalid user prefix' }));
        }
        return;
    }

    // API: Add trade to trading history
    if (req.url === '/api/trading-history' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
            if (body.length > 2000) {
                req.connection.destroy();
            }
        });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                if (data.userPrefix && data.action && data.side &&
                    typeof data.shares === 'number' && typeof data.costUsd === 'number' &&
                    typeof data.avgPrice === 'number') {
                    const success = addTradingHistory(
                        data.userPrefix,
                        data.action,
                        data.side,
                        data.shares,
                        data.costUsd,
                        data.avgPrice,
                        data.pnl || null
                    );
                    if (success) {
                        res.writeHead(200, {
                            'Content-Type': 'application/json',
                            ...SECURITY_HEADERS
                        });
                        res.end(JSON.stringify({ success: true }));
                    } else {
                        res.writeHead(500, {
                            'Content-Type': 'application/json',
                            ...SECURITY_HEADERS
                        });
                        res.end(JSON.stringify({ error: 'Failed to save trade' }));
                    }
                } else {
                    res.writeHead(400, {
                        'Content-Type': 'application/json',
                        ...SECURITY_HEADERS
                    });
                    res.end(JSON.stringify({ error: 'Invalid trade data' }));
                }
            } catch (err) {
                res.writeHead(400, {
                    'Content-Type': 'application/json',
                    ...SECURITY_HEADERS
                });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    // Handle market_status.json specially (serve from project root)
    if (req.url.startsWith('/market_status.json')) {
        fs.readFile(STATUS_FILE, (err, content) => {
            if (err) {
                res.writeHead(404, {
                    'Content-Type': 'application/json',
                    ...SECURITY_HEADERS
                });
                res.end(JSON.stringify({ state: 'OFFLINE' }));
            } else {
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Pragma': 'no-cache',
                    'Expires': '0',
                    ...SECURITY_HEADERS
                });
                res.end(content);
            }
        });
        return;
    }

    // Route handling
    let filePath;
    if (req.url === '/') {
        filePath = '/index.html';
    } else if (req.url === '/hl' || req.url === '/hyperliquid') {
        filePath = '/index.html';
    } else if (req.url === '/proto1') {
        filePath = '/index.html';
    } else if (req.url === '/index') {
        filePath = '/index.html';
    } else if (req.url === '/proto1-original') {
        filePath = '/proto1_original.html';
    } else {
        filePath = req.url;
    }
    filePath = path.join(PUBLIC_DIR, filePath);

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'text/plain';

    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404, SECURITY_HEADERS);
                res.end('404 Not Found');
            } else {
                res.writeHead(500, SECURITY_HEADERS);
                res.end('500 Internal Server Error');
            }
        } else {
            // Add no-cache headers for JavaScript and HTML files to prevent stale code
            const headers = {
                'Content-Type': contentType,
                ...SECURITY_HEADERS
            };

            if (ext === '.js' || ext === '.html') {
                headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
                headers['Pragma'] = 'no-cache';
                headers['Expires'] = '0';
            }

            res.writeHead(200, headers);
            res.end(content);
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${PORT}/`);
    console.log(`Local: http://localhost:${PORT}/`);
    console.log(`WebSocket server running on ws://0.0.0.0:${PORT}/ws`);
});

// WebSocket server for real-time price updates
const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (ws) => {
    console.log('WebSocket client connected');

    // Send current price immediately on connection
    if (currentBTCPrice !== null) {
        ws.send(JSON.stringify({
            type: 'price',
            price: currentBTCPrice,
            timestamp: lastOracleUpdate
        }));
    }

    ws.on('close', () => {
        console.log('WebSocket client disconnected');
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error.message);
    });
});

// Broadcast price to all connected clients (WebSocket + SSE)
function broadcastPrice(priceData) {
    // WebSocket broadcast
    const message = JSON.stringify({
        type: 'price',
        price: priceData.price,
        age: priceData.age,
        timestamp: priceData.timestamp
    });

    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });

    // SSE broadcast
    const sseData = JSON.stringify({
        price: priceData.price,
        timestamp: priceData.timestamp
    });

    sseClients.forEach((client) => {
        try {
            client.write(`data: ${sseData}\n\n`);
        } catch (err) {
            // Client disconnected, remove it
            sseClients.delete(client);
        }
    });
}

// Broadcast market data to all connected SSE clients
function broadcastMarket(marketData) {
    const sseData = JSON.stringify(marketData);

    marketStreamClients.forEach((client) => {
        try {
            client.write(`data: ${sseData}\n\n`);
        } catch (err) {
            // Client disconnected, remove it
            marketStreamClients.delete(client);
        }
    });
}

// Broadcast volume data to all connected SSE clients
function broadcastVolume(volumeData) {
    const sseData = JSON.stringify(volumeData);

    volumeStreamClients.forEach((client) => {
        try {
            client.write(`data: ${sseData}\n\n`);
        } catch (err) {
            // Client disconnected, remove it
            volumeStreamClients.delete(client);
        }
    });
}

// Broadcast cycle status to all connected SSE clients
function broadcastCycle(cycleData) {
    const sseData = JSON.stringify(cycleData);
    console.log(`[broadcastCycle] 📡 Broadcasting to ${cycleStreamClients.size} clients:`, sseData);

    let successCount = 0;
    let failCount = 0;

    cycleStreamClients.forEach((client) => {
        try {
            client.write(`data: ${sseData}\n\n`);
            successCount++;
        } catch (err) {
            // Client disconnected, remove it
            console.error(`[broadcastCycle] Failed to send to client:`, err.message);
            cycleStreamClients.delete(client);
            failCount++;
        }
    });

    console.log(`[broadcastCycle] ✅ Sent to ${successCount} clients, ${failCount} failures`);
}

// Oracle polling loop - fetch price every ORACLE_POLL_INTERVAL
async function startOraclePolling() {
    console.log(`🔄 Starting oracle polling (every ${ORACLE_POLL_INTERVAL/1000}s)...`);

    const poll = async () => {
        const priceData = await fetchOraclePrice();

        if (priceData) {
            currentBTCPrice = priceData.price;
            lastOracleUpdate = priceData.timestamp;

            // Save to SQLite
            addPriceToHistory(priceData.price, priceData.timestamp);

            // Broadcast to WebSocket clients
            broadcastPrice(priceData);
        }
    };

    // Initial fetch
    await poll();

    // Then poll at interval
    setInterval(poll, ORACLE_POLL_INTERVAL);
}

// Start oracle polling
startOraclePolling().catch(err => {
    console.error('Failed to start oracle polling:', err);
});

// Market polling loop - fetch market data every MARKET_POLL_INTERVAL
async function startMarketPolling() {
    console.log(`🔄 Starting market polling (every ${MARKET_POLL_INTERVAL/1000}s)...`);

    const poll = async () => {
        const marketData = await fetchMarketData();

        if (marketData) {
            currentMarketData = marketData;
            lastMarketUpdate = marketData.timestamp;

            // Broadcast to SSE clients
            broadcastMarket(marketData);
        }
    };

    // Initial fetch
    await poll();

    // Then poll at interval
    setInterval(poll, MARKET_POLL_INTERVAL);
}

// Start market polling
startMarketPolling().catch(err => {
    console.error('Failed to start market polling:', err);
});

// Watch market_status.json for changes and broadcast to cycle stream clients
// Watch the actual file in the project root, not the symlink in public/
const MARKET_STATUS_FILE = path.join(__dirname, '..', 'market_status.json');
fs.watch(MARKET_STATUS_FILE, (eventType, filename) => {
    if (eventType === 'change') {
        try {
            const cycleStatus = fs.readFileSync(MARKET_STATUS_FILE, 'utf8');
            const cycleData = JSON.parse(cycleStatus);
            console.log(`📅 Cycle status updated: ${cycleData.state}`);
            broadcastCycle(cycleData);
        } catch (err) {
            console.error('Failed to read or broadcast cycle status:', err.message);
        }
    }
});
console.log(`👀 Watching ${MARKET_STATUS_FILE} for cycle status changes...`);
