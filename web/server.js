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

// Log buffer for real-time log viewer
const logBuffer = [];
const MAX_LOG_ENTRIES = 1000;

// Helper function to log to both console and buffer
function logToBuffer(message) {
    console.log(message);
    logBuffer.push({
        timestamp: new Date().toISOString(),
        message: message
    });

    // Limit buffer size
    if (logBuffer.length > MAX_LOG_ENTRIES) {
        logBuffer.shift();
    }
}

// Solana Oracle Configuration
const RPC_URL = 'https://rpc.mainnet.x1.xyz';
const ORACLE_STATE = 'ErU8byy8jYDZg5NjsF7eacK2khJ7jfUjsoQZ2E28baJA';
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

// SSE clients for live trades stream
const tradesStreamClients = new Set();

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
        timestamp INTEGER NOT NULL,
        cycle_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_trading_user_timestamp ON trading_history(user_prefix, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_trading_cycle ON trading_history(cycle_id, user_prefix);

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

    CREATE TABLE IF NOT EXISTS quote_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cycle_id TEXT NOT NULL,
        up_price REAL NOT NULL,
        down_price REAL NOT NULL,
        timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_quote_cycle_time ON quote_history(cycle_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_quote_timestamp ON quote_history(timestamp DESC);

    -- position_cost_basis table removed - cost basis calculated on-demand from trading_history
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

// ========== TypeScript Integration ==========
// Import compiled TypeScript controllers
const { ApiController, StreamService } = require('./dist/api');
const { VolumeRepository } = require('./dist/database');

// Initialize TypeScript API Controller for proto2
const tsApiController = new ApiController({
    rpcUrl: RPC_URL,
    oracleStateKey: ORACLE_STATE,
    programId: PROGRAM_ID,
    ammSeed: AMM_SEED,
    dbPath: DB_FILE,
    enableLogging: false
});

// Initialize TypeScript StreamService for proto2
const volumeRepo = new VolumeRepository(db);
const tsStreamService = new StreamService({
    connection: connection,
    oracleStateKey: ORACLE_STATE,
    programId: PROGRAM_ID,
    ammSeed: AMM_SEED,
    volumeRepo: volumeRepo,
    enableLogging: false
});

console.log('✅ TypeScript controllers initialized for /api/ts/* endpoints');
// ============================================

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
            // Debug log removed
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

        // Decimals byte is at end of oracle data (works for both testnet 186 bytes and mainnet 362 bytes)
        const decimals = d.readUInt8(d.length - 2);

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

        // Debug log removed

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
        // Debug log removed

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

        // Debug log removed

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
            // Debug log removed
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
            // Debug log removed
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

        // Use the MARKET cycle start time from market_status.json, not the user's last settlement
        // This ensures we only count trades from the CURRENT market cycle
        let cycleStartTime = 0;
        try {
            const marketStatus = JSON.parse(fs.readFileSync('./market_status.json', 'utf8'));
            if (marketStatus && marketStatus.cycleStartTime) {
                cycleStartTime = marketStatus.cycleStartTime;
                console.log(`Using market cycle start time: ${cycleStartTime} (${new Date(cycleStartTime).toISOString()})`);
            }
        } catch (err) {
            console.warn('Could not load market_status.json, using last settlement as fallback:', err.message);
            // Fallback: use last settlement timestamp if market_status.json is unavailable
            const lastSettlementStmt = db.prepare('SELECT timestamp FROM settlement_history WHERE user_prefix = ? ORDER BY timestamp DESC LIMIT 1');
            const lastSettlement = lastSettlementStmt.get(userPrefix);
            if (lastSettlement) {
                cycleStartTime = lastSettlement.timestamp;
            }
        }

        // Calculate total buys, sells, and net spent from trading history WITHIN THIS CYCLE
        let totalBuys = 0;
        let totalSells = 0;

        const tradingStmt = db.prepare('SELECT action, cost_usd FROM trading_history WHERE user_prefix = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC');
        const trades = tradingStmt.all(userPrefix, cycleStartTime, timestamp);

        for (const trade of trades) {
            if (trade.action === 'BUY') {
                totalBuys += trade.cost_usd;
            } else if (trade.action === 'SELL') {
                totalSells += trade.cost_usd;
            }
        }

        const netSpent = totalBuys - totalSells;

        const stmt = db.prepare('INSERT INTO settlement_history (user_prefix, result, amount, side, timestamp, snapshot_price, settle_price, net_spent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
        stmt.run(userPrefix, result, amount, side, timestamp, snapshotPrice, settlePrice, netSpent);
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

function getUserStats(userPrefix) {
    try {
        // Get settlement stats (wins/losses)
        const settlementStmt = db.prepare(`
            SELECT
                COUNT(*) as total_rounds,
                SUM(CASE WHEN result = 'WIN' THEN 1 ELSE 0 END) as wins,
                SUM(CASE WHEN result = 'LOSS' THEN 1 ELSE 0 END) as losses,
                SUM(CASE WHEN result = 'WIN' THEN amount ELSE 0 END) as total_won,
                SUM(CASE WHEN result = 'LOSS' THEN amount ELSE 0 END) as total_lost,
                SUM(CASE WHEN result = 'WIN' THEN amount ELSE -amount END) as net_pnl
            FROM settlement_history
            WHERE user_prefix = ?
        `);
        const settlementStats = settlementStmt.get(userPrefix) || {
            total_rounds: 0, wins: 0, losses: 0, total_won: 0, total_lost: 0, net_pnl: 0
        };

        // Get trading stats
        const tradingStmt = db.prepare(`
            SELECT
                COUNT(*) as total_trades,
                SUM(CASE WHEN action = 'BUY' THEN 1 ELSE 0 END) as buys,
                SUM(CASE WHEN action = 'SELL' THEN 1 ELSE 0 END) as sells,
                SUM(CASE WHEN action = 'BUY' THEN cost_usd ELSE 0 END) as total_bought,
                SUM(CASE WHEN action = 'SELL' THEN cost_usd ELSE 0 END) as total_sold,
                SUM(shares) as total_shares
            FROM trading_history
            WHERE user_prefix = ?
        `);
        const tradingStats = tradingStmt.get(userPrefix) || {
            total_trades: 0, buys: 0, sells: 0, total_bought: 0, total_sold: 0, total_shares: 0
        };

        // Get recent settlements (last 10)
        const recentSettlementsStmt = db.prepare(`
            SELECT * FROM settlement_history
            WHERE user_prefix = ?
            ORDER BY timestamp DESC
            LIMIT 10
        `);
        const recentSettlements = recentSettlementsStmt.all(userPrefix);

        return {
            userPrefix,
            settlement: {
                totalRounds: settlementStats.total_rounds || 0,
                wins: settlementStats.wins || 0,
                losses: settlementStats.losses || 0,
                winRate: settlementStats.total_rounds > 0
                    ? ((settlementStats.wins / settlementStats.total_rounds) * 100).toFixed(1)
                    : '0.0',
                totalWon: settlementStats.total_won || 0,
                totalLost: settlementStats.total_lost || 0,
                netPnl: settlementStats.net_pnl || 0
            },
            trading: {
                totalTrades: tradingStats.total_trades || 0,
                buys: tradingStats.buys || 0,
                sells: tradingStats.sells || 0,
                totalBought: tradingStats.total_bought || 0,
                totalSold: tradingStats.total_sold || 0,
                totalShares: tradingStats.total_shares || 0
            },
            recentSettlements
        };
    } catch (err) {
        console.error('Failed to get user stats:', err.message);
        return null;
    }
}

function getSettlementLeaderboard(limit = 100) {
    try {
        // Get settlement stats
        const stmt = db.prepare(`
            SELECT
                user_prefix,
                COUNT(*) as total_rounds,
                SUM(CASE WHEN result = 'WIN' THEN 1 ELSE 0 END) as wins,
                SUM(CASE WHEN result = 'LOSS' OR result = 'LOSE' THEN 1 ELSE 0 END) as losses,
                SUM(CASE WHEN result = 'WIN' THEN amount ELSE 0 END) as total_won,
                SUM(CASE WHEN result = 'LOSS' OR result = 'LOSE' THEN amount ELSE 0 END) as total_lost,
                SUM(CASE WHEN result = 'WIN' THEN amount ELSE -amount END) as net_pnl
            FROM settlement_history
            GROUP BY user_prefix
        `);
        const settlements = stmt.all();

        // Create a map of all users keyed by prefix
        const usersMap = {};

        // Add settlement users
        for (const s of settlements) {
            usersMap[s.user_prefix] = {
                user_prefix: s.user_prefix,
                total_rounds: s.total_rounds || 0,
                wins: s.wins || 0,
                losses: s.losses || 0,
                total_won: s.total_won || 0,
                total_lost: s.total_lost || 0,
                net_pnl: s.net_pnl || 0,
                total_points: 0,
                full_pubkey: null
            };
        }

        // Try to get points data and merge
        try {
            const { PointsDB } = require('../points/points.js');
            const pointsDb = new PointsDB(path.join(__dirname, '../points/points.db'));
            const pointsLeaderboard = pointsDb.getLeaderboard(500);
            pointsDb.close();

            // Merge points into existing users by matching prefix
            for (const p of pointsLeaderboard) {
                if (p.master_pubkey.startsWith('TestUser')) continue; // Skip test users

                const pubkey = p.master_pubkey;
                const prefix = pubkey.slice(0, 6);

                // Try to find matching user by prefix (partial match)
                let matched = false;
                for (const userPrefix of Object.keys(usersMap)) {
                    if (pubkey.startsWith(userPrefix) || userPrefix.startsWith(prefix)) {
                        // User exists from settlements, add points
                        usersMap[userPrefix].total_points = (usersMap[userPrefix].total_points || 0) + (p.total_points || 0);
                        usersMap[userPrefix].full_pubkey = pubkey;
                        matched = true;
                        break;
                    }
                }

                if (!matched) {
                    // New user with only points, no settlements
                    usersMap[prefix] = {
                        user_prefix: prefix,
                        total_rounds: 0,
                        wins: 0,
                        losses: 0,
                        total_won: 0,
                        total_lost: 0,
                        net_pnl: 0,
                        total_points: p.total_points || 0,
                        full_pubkey: pubkey
                    };
                }
            }
        } catch (pointsErr) {
            console.warn('Points DB not available:', pointsErr.message);
        }

        // Convert to array and sort by net_pnl DESC, then by points DESC
        const result = Object.values(usersMap)
            .sort((a, b) => {
                if (b.net_pnl !== a.net_pnl) return b.net_pnl - a.net_pnl;
                return b.total_points - a.total_points;
            })
            .slice(0, limit);

        return result;
    } catch (err) {
        console.error('Failed to get settlement leaderboard:', err.message);
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
function addTradingHistory(userPrefix, action, side, shares, costUsd, avgPrice, pnl = null, cycleId = null) {
    try {
        // Use current cycle_id if not provided
        const marketCycleId = cycleId || cumulativeVolume.cycleId;
        const stmt = db.prepare('INSERT INTO trading_history (user_prefix, action, side, shares, cost_usd, avg_price, pnl, timestamp, cycle_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
        stmt.run(userPrefix, action, side, shares, costUsd, avgPrice, pnl, Date.now(), marketCycleId);
        return true;
    } catch (err) {
        console.error('Failed to add trading history:', err.message);
        return false;
    }
}

function getMarketStatus() {
    try {
        const data = fs.readFileSync(STATUS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error('Failed to read market status:', err.message);
        return null;
    }
}

async function getOnChainPosition(walletPubkeyStr) {
    try {
        const programId = new PublicKey('EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF');
        const walletPubkey = new PublicKey(walletPubkeyStr);

        // Derive AMM PDA
        const ammSeed = Buffer.from('amm_btc_v6', 'utf8');
        const [ammPda] = PublicKey.findProgramAddressSync([ammSeed], programId);

        // Derive position PDA
        const posSeed = Buffer.from('pos', 'utf8');
        const [positionPda] = PublicKey.findProgramAddressSync(
            [posSeed, ammPda.toBuffer(), walletPubkey.toBuffer()],
            programId
        );

        // Fetch position account
        const positionAccount = await connection.getAccountInfo(positionPda);

        // Get cost basis from SQLite
        const costBasis = getPositionCostBasis(walletPubkeyStr);

        if (!positionAccount) {
            return {
                exists: false,
                yesShares: 0,
                noShares: 0,
                accountBalance: 0,
                positionPda: positionPda.toString(),
                // Cost basis data
                yesCostBasis: costBasis.yesCostE6 / 1_000_000,
                noCostBasis: costBasis.noCostE6 / 1_000_000,
                yesAvgEntry: 0,
                noAvgEntry: 0
            };
        }

        // Parse position data
        // Position layout: discriminator(8) + owner(32) + yes_shares(8) + no_shares(8) + master_wallet(32) + vault_balance(8)
        const data = positionAccount.data;
        const yesSharesE6 = Number(data.readBigInt64LE(40));
        const noSharesE6 = Number(data.readBigInt64LE(48));
        const accountBalanceE6 = Number(data.readBigInt64LE(88));

        // Calculate average entry prices
        const yesShares = yesSharesE6 / 10_000_000;
        const noShares = noSharesE6 / 10_000_000;
        const yesCostBasis = costBasis.yesCostE6 / 1_000_000;
        const noCostBasis = costBasis.noCostE6 / 1_000_000;
        const yesAvgEntry = yesShares > 0 ? yesCostBasis / yesShares : 0;
        const noAvgEntry = noShares > 0 ? noCostBasis / noShares : 0;

        return {
            exists: true,
            yesShares: yesShares,
            noShares: noShares,
            accountBalance: accountBalanceE6 / 10_000_000,  // User's trading account balance (collateral)
            yesSharesE6: yesSharesE6,
            noSharesE6: noSharesE6,
            accountBalanceE6: accountBalanceE6,
            positionPda: positionPda.toString(),
            // Cost basis data
            yesCostBasis: yesCostBasis,
            noCostBasis: noCostBasis,
            yesAvgEntry: yesAvgEntry,
            noAvgEntry: noAvgEntry
        };
    } catch (err) {
        console.error('Error fetching on-chain position:', err);
        throw err;
    }
}

function getTradingHistory(userPrefix, limit = 100, currentMarketOnly = false) {
    try {
        // Use LIKE to support partial prefix matching (e.g., "D5nZJ" will match "D5nZJG")
        if (currentMarketOnly) {
            // Filter by current market cycle_id
            const currentCycleId = cumulativeVolume.cycleId;
            if (currentCycleId) {
                const stmt = db.prepare('SELECT * FROM trading_history WHERE user_prefix LIKE ? AND cycle_id = ? ORDER BY timestamp DESC LIMIT ?');
                return stmt.all(userPrefix + '%', currentCycleId, limit);
            } else {
                // Fallback to timestamp-based filtering if no cycle_id
                const marketStatus = getMarketStatus();
                const cycleStartTime = marketStatus?.cycleStartTime || 0;
                const stmt = db.prepare('SELECT * FROM trading_history WHERE user_prefix LIKE ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT ?');
                return stmt.all(userPrefix + '%', cycleStartTime, limit);
            }
        } else {
            const stmt = db.prepare('SELECT * FROM trading_history WHERE user_prefix LIKE ? ORDER BY timestamp DESC LIMIT ?');
            return stmt.all(userPrefix + '%', limit);
        }
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

// Calculate cost basis from trading history (FIFO accounting)
// This replaces the old position_cost_basis table
function calculateCostBasisFromHistory(walletPubkey, cycleId = null) {
    try {
        // Use current cycle if not specified
        const targetCycleId = cycleId || cumulativeVolume.cycleId;

        // Get all trades for this wallet in this cycle, ordered chronologically
        const stmt = db.prepare(`
            SELECT action, side, shares, cost_usd, avg_price
            FROM trading_history
            WHERE user_prefix = ? AND cycle_id = ?
            ORDER BY timestamp ASC
        `);
        const userPrefix = walletPubkey.slice(0, 6);
        const trades = stmt.all(userPrefix, targetCycleId);

        let yesCostBasis = 0;  // Total cost paid for YES shares (in USD)
        let noCostBasis = 0;   // Total cost paid for NO shares (in USD)
        let yesShares = 0;     // Current YES shares owned
        let noShares = 0;      // Current NO shares owned

        // Process trades chronologically using FIFO
        for (const trade of trades) {
            const side = trade.side;
            const isYes = (side === 'YES' || side === 'UP');

            if (trade.action === 'BUY') {
                // Add shares and cost
                if (isYes) {
                    yesCostBasis += trade.cost_usd;
                    yesShares += trade.shares;
                } else {
                    noCostBasis += trade.cost_usd;
                    noShares += trade.shares;
                }
            } else if (trade.action === 'SELL') {
                // Reduce shares and cost proportionally (FIFO)
                if (isYes) {
                    if (yesShares > 0) {
                        const proportionSold = Math.min(1, trade.shares / yesShares);
                        yesCostBasis -= yesCostBasis * proportionSold;
                        yesShares -= trade.shares;
                    }
                } else {
                    if (noShares > 0) {
                        const proportionSold = Math.min(1, trade.shares / noShares);
                        noCostBasis -= noCostBasis * proportionSold;
                        noShares -= trade.shares;
                    }
                }
            }
        }

        return {
            yesCostE6: Math.round(yesCostBasis * 1_000_000),
            noCostE6: Math.round(noCostBasis * 1_000_000),
            yesShares: yesShares,
            noShares: noShares
        };
    } catch (err) {
        console.error('Failed to calculate cost basis from history:', err.message);
        return {
            yesCostE6: 0,
            noCostE6: 0,
            yesShares: 0,
            noShares: 0
        };
    }
}

// Legacy function - now just wraps calculateCostBasisFromHistory
function getPositionCostBasis(walletPubkey) {
    return calculateCostBasisFromHistory(walletPubkey);
}

// Quote history functions
function addQuoteSnapshot(cycleId, upPrice, downPrice) {
    try {
        const stmt = db.prepare('INSERT INTO quote_history (cycle_id, up_price, down_price, timestamp) VALUES (?, ?, ?, ?)');
        stmt.run(cycleId, upPrice, downPrice, Date.now());
        return true;
    } catch (err) {
        console.error('Failed to add quote snapshot:', err.message);
        return false;
    }
}

function getQuoteHistory(cycleId) {
    try {
        const stmt = db.prepare('SELECT up_price, down_price, timestamp FROM quote_history WHERE cycle_id = ? ORDER BY timestamp ASC');
        return stmt.all(cycleId);
    } catch (err) {
        console.error('Failed to get quote history:', err.message);
        return [];
    }
}

function getRecentCycles(limit = 10) {
    try {
        const stmt = db.prepare('SELECT DISTINCT cycle_id, cycle_start_time FROM volume_history ORDER BY cycle_start_time DESC LIMIT ?');
        return stmt.all(limit);
    } catch (err) {
        console.error('Failed to get recent cycles:', err.message);
        return [];
    }
}

function cleanupOldQuoteHistory() {
    try {
        const cutoffTime = Date.now() - (MAX_TRADING_HISTORY_HOURS * 60 * 60 * 1000);
        const stmt = db.prepare('DELETE FROM quote_history WHERE timestamp < ?');
        const result = stmt.run(cutoffTime);
        if (result.changes > 0) {
            console.log(`Cleaned up ${result.changes} old quote history records`);
        }
        return result.changes;
    } catch (err) {
        console.error('Failed to cleanup old quote history:', err.message);
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
cleanupOldQuoteHistory();

// Schedule periodic cleanup (every hour)
setInterval(() => {
    cleanupOldPrices();
    cleanupOldSettlements();
    cleanupOldTradingHistory();
    cleanupOldQuoteHistory();
}, 60 * 60 * 1000);

// Security headers
const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com; style-src 'self' 'unsafe-inline'; connect-src 'self' https://rpc.mainnet.x1.xyz wss://rpc.mainnet.x1.xyz https://rpc.testnet.x1.xyz wss://rpc.testnet.x1.xyz ws://localhost:3536 wss://localhost:3536 http://127.0.0.1:8899 http://localhost:8899; img-src 'self' data:; font-src 'self'"
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
    // ============================================================================
    // ORDERBOOK API PROXY - Forward /orderbook-api/* to localhost:3436
    // ============================================================================
    if (req.url.startsWith('/orderbook-api/')) {
        const targetPath = req.url.replace('/orderbook-api', '');
        const options = {
            hostname: 'localhost',
            port: 3537,
            path: targetPath,
            method: req.method,
            headers: req.headers
        };

        const proxy = http.request(options, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, {
                ...proxyRes.headers,
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type'
            });
            proxyRes.pipe(res);
        });

        proxy.on('error', (err) => {
            console.error('Orderbook API proxy error:', err);
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Orderbook API unavailable' }));
        });

        req.pipe(proxy);
        return;
    }

    // ============================================================================
    // REQUEST LOGGING - Track which APIs are accessed and service type used
    // ============================================================================
    const timestamp = new Date().toISOString();
    const logPrefix = `[${timestamp}]`;

    // SSE: Stream live trades
    if (req.url === '/api/trades-stream' && req.method === 'GET') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });

        // Send initial batch of recent trades (filtered)
        try {
            // Filter out keeper/deployer wallets and malformed entries
            const DEPLOYER_PREFIX = 'AivknD';
            const KEEPER_PREFIX = 'jqj117';

            const stmt = db.prepare(`
                SELECT
                    user_prefix,
                    action,
                    side,
                    shares,
                    cost_usd,
                    avg_price,
                    timestamp
                FROM trading_history
                WHERE user_prefix NOT LIKE ? AND user_prefix NOT LIKE ?
                  AND ABS(shares) <= 1000000 AND ABS(cost_usd) <= 1000000
                  AND (avg_price >= 0 AND avg_price <= 100)
                ORDER BY timestamp DESC
                LIMIT 100
            `);

            const trades = stmt.all(`${DEPLOYER_PREFIX}%`, `${KEEPER_PREFIX}%`).map(row => ({
                side: row.side === 'UP' ? 'YES' : 'NO',
                action: row.action,
                amount: row.cost_usd.toFixed(4),
                shares: row.shares.toFixed(2),
                avgPrice: row.avg_price ? row.avg_price.toFixed(4) : '0.0000',
                timestamp: row.timestamp,
                user: row.user_prefix
            }));

            // Send initial history as a batch
            res.write(`event: history\n`);
            res.write(`data: ${JSON.stringify(trades)}\n\n`);
        } catch (err) {
            console.error('Error sending initial trades:', err);
        }

        // Add client to set
        tradesStreamClients.add(res);
        console.log(`Trades SSE client connected (${tradesStreamClients.size} total)`);

        // Remove client on disconnect
        req.on('close', () => {
            tradesStreamClients.delete(res);
            console.log(`Trades SSE client disconnected (${tradesStreamClients.size} remaining)`);
        });

        return;
    }

    // API: Get recent trades from database (replaces recent_trades.json)
    if (req.url.startsWith('/api/recent-trades') || req.url === '/recent_trades.json') {
        try {
            const url = new URL(req.url, `http://${req.headers.host}`);
            const limit = parseInt(url.searchParams.get('limit')) || 100;

            // Filter out keeper/deployer wallets and malformed entries
            const DEPLOYER_PREFIX = 'AivknD';
            const KEEPER_PREFIX = 'jqj117';

            const stmt = db.prepare(`
                SELECT
                    user_prefix,
                    action,
                    side,
                    shares,
                    cost_usd,
                    avg_price,
                    timestamp
                FROM trading_history
                WHERE user_prefix NOT LIKE ? AND user_prefix NOT LIKE ?
                  AND ABS(shares) <= 1000000 AND ABS(cost_usd) <= 1000000
                  AND (avg_price >= 0 AND avg_price <= 100)
                ORDER BY timestamp DESC
                LIMIT ?
            `);

            const trades = stmt.all(`${DEPLOYER_PREFIX}%`, `${KEEPER_PREFIX}%`, limit).map(row => ({
                side: row.side === 'UP' ? 'YES' : 'NO',
                action: row.action,
                amount: row.cost_usd.toFixed(4),
                shares: row.shares.toFixed(2),
                avgPrice: row.avg_price ? row.avg_price.toFixed(4) : '0.0000',
                timestamp: row.timestamp,
                user: row.user_prefix
            }));

            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify(trades));
        } catch (err) {
            console.error('Error fetching recent trades:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to fetch trades' }));
        }
        return;
    }

    // API: Get logs for real-time viewer
    if (req.url.startsWith('/api/logs')) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const from = parseInt(url.searchParams.get('from')) || 0;
        const limit = parseInt(url.searchParams.get('limit')) || 100;

        const logs = logBuffer.slice(from).slice(-limit).map(entry => entry.message);

        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache',
            ...SECURITY_HEADERS
        });
        res.end(JSON.stringify({
            logs: logs,
            position: logBuffer.length,
            total: logBuffer.length
        }));
        return;
    }

    // Log requests selectively (skip high-frequency chart endpoints to reduce overhead)
    const shouldLog = (req.url.startsWith('/api/') || req.url === '/' || req.url === '/proto2' || req.url === '/logs')
        && !req.url.includes('/api/quote-history/')
        && !req.url.includes('/api/volume-stream')
        && !req.url.includes('/api/price-stream')
        && !req.url.includes('/api/market-stream')
        && !req.url.includes('/api/cycle-stream')
        && req.url !== '/api/volume'
        && req.url !== '/api/logs';

    if (shouldLog) {
        logToBuffer(`\n${logPrefix} 📥 REQUEST: ${req.method} ${req.url}`);
    }

    // API: TypeScript Integration Demo (for /proto2)
    if (req.url === '/api/typescript-demo' && req.method === 'GET') {
        logToBuffer(`${logPrefix} 🔷 TypeScript: Calling OracleService + MarketService (compiled from /dist/solana)`);
        (async () => {
            try {
                // Import TypeScript services
                const { OracleService, MarketService } = require('./dist/solana');

                // Initialize services
                const oracleService = new OracleService(connection, ORACLE_STATE, {
                    enableLogging: false
                });
                const marketService = new MarketService(connection, PROGRAM_ID, {
                    ammSeed: AMM_SEED,
                    lamportsPerE6: 100,
                    enableLogging: false
                });

                // Fetch data
                const oraclePrice = await oracleService.fetchPrice();
                const marketState = await marketService.fetchMarketState();

                if (!oraclePrice || !marketState) {
                    res.writeHead(500, {
                        'Content-Type': 'application/json',
                        ...SECURITY_HEADERS
                    });
                    res.end(JSON.stringify({
                        error: 'Failed to fetch data from TypeScript services'
                    }));
                    return;
                }

                // Calculate LMSR prices
                const lmsrPrices = marketService.calculatePrices(marketState);

                logToBuffer(`${logPrefix} ✅ TypeScript Response: BTC $${oraclePrice.price.toFixed(2)} (${oraclePrice.age}s old) | Market: ${['Open','Stopped','Settled'][marketState.status]} | YES: ${(lmsrPrices.probYes*100).toFixed(1)}% NO: ${(lmsrPrices.probNo*100).toFixed(1)}%`);

                // Send response
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    ...SECURITY_HEADERS
                });
                res.end(JSON.stringify({
                    oracle: oraclePrice,
                    market: marketState,
                    lmsr: lmsrPrices,
                    timestamp: Date.now()
                }));
            } catch (err) {
                console.error('TypeScript demo API error:', err);
                res.writeHead(500, {
                    'Content-Type': 'application/json',
                    ...SECURITY_HEADERS
                });
                res.end(JSON.stringify({
                    error: err.message || 'Internal server error'
                }));
            }
        })();
        return;
    }

    // ========== TypeScript API Endpoints for proto2 ==========

    // TypeScript: Current price endpoint
    if (req.url.startsWith('/api/ts/current-price') && req.method === 'GET') {
        (async () => {
            try {
                const price = await tsApiController.getCurrentPrice();
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    ...SECURITY_HEADERS
                });
                res.end(JSON.stringify(price || { error: 'Price not available' }));
            } catch (err) {
                console.error('TypeScript API /ts/current-price error:', err);
                res.writeHead(500, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
                res.end(JSON.stringify({ error: err.message }));
            }
        })();
        return;
    }

    // TypeScript: Volume endpoint
    if (req.url === '/api/ts/volume' && req.method === 'GET') {
        try {
            const volume = tsApiController.getVolume();
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                ...SECURITY_HEADERS
            });
            res.end(JSON.stringify(volume || { error: 'Volume not available' }));
        } catch (err) {
            console.error('TypeScript API /ts/volume error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // TypeScript: Recent cycles endpoint
    if (req.url === '/api/ts/recent-cycles' && req.method === 'GET') {
        try {
            const cycles = tsApiController.getRecentCycles(10);
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                ...SECURITY_HEADERS
            });
            res.end(JSON.stringify(cycles));
        } catch (err) {
            console.error('TypeScript API /ts/recent-cycles error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // TypeScript: Settlement history endpoint
    if (req.url === '/api/ts/settlement-history' && req.method === 'GET') {
        try {
            const settlements = tsApiController.getSettlementHistory(100);
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                ...SECURITY_HEADERS
            });
            res.end(JSON.stringify(settlements));
        } catch (err) {
            console.error('TypeScript API /ts/settlement-history error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // TypeScript: Market data endpoint
    if (req.url === '/api/ts/market-data' && req.method === 'GET') {
        (async () => {
            try {
                const data = await tsApiController.getMarketData();
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    ...SECURITY_HEADERS
                });
                res.end(JSON.stringify(data || { error: 'Market data not available' }));
            } catch (err) {
                console.error('TypeScript API /ts/market-data error:', err);
                res.writeHead(500, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
                res.end(JSON.stringify({ error: err.message }));
            }
        })();
        return;
    }

    // TypeScript SSE: Price stream
    if (req.url === '/api/ts/price-stream' && req.method === 'GET') {
        logToBuffer(`${logPrefix} 📡 TypeScript SSE: Price stream client connected`);
        tsStreamService.addPriceClient(res);
        return;
    }

    // TypeScript SSE: Market stream
    if (req.url === '/api/ts/market-stream' && req.method === 'GET') {
        logToBuffer(`${logPrefix} 📡 TypeScript SSE: Market stream client connected`);
        tsStreamService.addMarketClient(res);
        return;
    }

    // TypeScript SSE: Volume stream
    if (req.url === '/api/ts/volume-stream' && req.method === 'GET') {
        logToBuffer(`${logPrefix} 📡 TypeScript SSE: Volume stream client connected`);
        tsStreamService.addVolumeClient(res);
        return;
    }

    // TypeScript SSE: Cycle stream (market status from market_status.json)
    if (req.url === '/api/ts/cycle-stream' && req.method === 'GET') {
        logToBuffer(`${logPrefix} 📡 TypeScript SSE: Market status stream client connected`);
        tsStreamService.addStatusClient(res);
        return;
    }

    // TypeScript SSE: Market status stream
    if (req.url === '/api/ts/status-stream' && req.method === 'GET') {
        logToBuffer(`${logPrefix} 📡 TypeScript SSE: Status stream client connected`);
        tsStreamService.addStatusClient(res);
        return;
    }

    // TypeScript: Trading history endpoint
    if (req.url.startsWith('/api/ts/trading-history/') && req.method === 'GET') {
        const userPrefix = req.url.split('/api/ts/trading-history/')[1];
        if (userPrefix && userPrefix.length >= 6) {
            const result = tsApiController.getTradingHistory(userPrefix, 100);
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                ...SECURITY_HEADERS
            });
            res.end(JSON.stringify(result));
        } else {
            res.writeHead(400, {
                'Content-Type': 'application/json',
                ...SECURITY_HEADERS
            });
            res.end(JSON.stringify({ error: 'Invalid user prefix' }));
        }
        return;
    }

    // TypeScript: Simulate guarded trade endpoint
    if (req.url === '/api/simulate-guarded-trade' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const { side, action, amountE6, guards } = JSON.parse(body);
                const result = await tsApiController.simulateGuardedTrade(side, action, amountE6, guards);
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    ...SECURITY_HEADERS
                });
                res.end(JSON.stringify(result));
            } catch (err) {
                console.error('Simulate guarded trade error:', err);
                res.writeHead(500, {
                    'Content-Type': 'application/json',
                    ...SECURITY_HEADERS
                });
                res.end(JSON.stringify({
                    success: false,
                    sharesToExecute: 0,
                    executionPrice: 0,
                    totalCost: 0,
                    isPartialFill: false,
                    guardsStatus: {},
                    error: err.message || 'Simulation failed'
                }));
            }
        });
        return;
    }

    // ========== End TypeScript API Endpoints ==========

    // ========== Points API Endpoints ==========

    // API: Get points leaderboard
    if (req.url.startsWith('/api/points/leaderboard') && req.method === 'GET') {
        try {
            const { PointsDB } = require('../points/points.js');
            const pointsDb = new PointsDB(path.join(__dirname, '../points/points.db'));
            const urlParams = new URL(req.url, `http://${req.headers.host}`);
            const limit = parseInt(urlParams.searchParams.get('limit')) || 100;
            const leaderboard = pointsDb.getLeaderboard(limit);
            pointsDb.close();

            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                ...SECURITY_HEADERS
            });
            res.end(JSON.stringify(leaderboard));
        } catch (err) {
            console.error('Points leaderboard error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // API: Get user points
    if (req.url.startsWith('/api/points/user/') && req.method === 'GET') {
        try {
            const { PointsDB } = require('../points/points.js');
            const pointsDb = new PointsDB(path.join(__dirname, '../points/points.db'));
            const masterPubkey = req.url.split('/api/points/user/')[1];

            if (!masterPubkey || masterPubkey.length < 32) {
                res.writeHead(400, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
                res.end(JSON.stringify({ error: 'Invalid pubkey' }));
                pointsDb.close();
                return;
            }

            const user = pointsDb.getUser(masterPubkey);
            const rank = pointsDb.getUserRank(masterPubkey);
            pointsDb.close();

            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                ...SECURITY_HEADERS
            });
            res.end(JSON.stringify(user ? { ...user, rank } : { total_points: 0, rank: null }));
        } catch (err) {
            console.error('Points user error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // API: Get points stats
    if (req.url === '/api/points/stats' && req.method === 'GET') {
        try {
            const { PointsDB } = require('../points/points.js');
            const pointsDb = new PointsDB(path.join(__dirname, '../points/points.db'));
            const stats = pointsDb.getStats();
            pointsDb.close();

            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                ...SECURITY_HEADERS
            });
            res.end(JSON.stringify(stats));
        } catch (err) {
            console.error('Points stats error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // ========== End Points API Endpoints ==========

    // API: Get cumulative volume
    if (req.url === '/api/volume' && req.method === 'GET') {
        // Logging disabled for high-frequency endpoint
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

    // API: Reset cost basis for new market cycle
    if (req.url === '/api/cost-basis/reset' && req.method === 'POST') {
        try {
            const stmt = db.prepare('DELETE FROM position_cost_basis');
            const result = stmt.run();
            console.log(`💰 Cost basis reset - cleared ${result.changes} position records for new market cycle`);

            res.writeHead(200, {
                'Content-Type': 'application/json',
                ...SECURITY_HEADERS
            });
            res.end(JSON.stringify({ success: true, cleared: result.changes }));
        } catch (err) {
            console.error('Failed to reset cost basis:', err.message);
            res.writeHead(500, {
                'Content-Type': 'application/json',
                ...SECURITY_HEADERS
            });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // API: Get price history
    if (req.url.startsWith('/api/price-history') && req.method === 'GET') {
        logToBuffer(`${logPrefix} 📦 SERVICE: Original JavaScript (SQLite database query)`);
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
    if (req.url.startsWith('/api/current-price') && req.method === 'GET') {
        logToBuffer(`${logPrefix} 📦 SERVICE: Original JavaScript (cached oracle price)`);
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

    // API: Get settlement leaderboard (from trading history)
    if (req.url.startsWith('/api/settlement-leaderboard') && req.method === 'GET') {
        const urlParams = new URL(req.url, `http://${req.headers.host}`);
        const limit = parseInt(urlParams.searchParams.get('limit')) || 100;
        const leaderboard = getSettlementLeaderboard(limit);
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            ...SECURITY_HEADERS
        });
        res.end(JSON.stringify(leaderboard));
        return;
    }

    // API: Get user stats (combined wins/losses)
    if (req.url.startsWith('/api/user-stats/') && req.method === 'GET') {
        const userPrefix = req.url.split('/api/user-stats/')[1];
        if (userPrefix && userPrefix.length >= 5) {
            const stats = getUserStats(userPrefix);
            if (stats) {
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    ...SECURITY_HEADERS
                });
                res.end(JSON.stringify(stats));
            } else {
                res.writeHead(500, {
                    'Content-Type': 'application/json',
                    ...SECURITY_HEADERS
                });
                res.end(JSON.stringify({ error: 'Failed to fetch user stats' }));
            }
        } else {
            res.writeHead(400, {
                'Content-Type': 'application/json',
                ...SECURITY_HEADERS
            });
            res.end(JSON.stringify({ error: 'Invalid user prefix (minimum 5 characters)' }));
        }
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
        const urlParts = req.url.split('/api/trading-history/')[1].split('?');
        const userPrefix = urlParts[0];
        const queryString = urlParts[1] || '';
        const params = new URLSearchParams(queryString);
        const currentMarketOnly = params.get('currentMarket') === 'true';

        if (userPrefix && userPrefix.length >= 5) {
            const history = getTradingHistory(userPrefix, 100, currentMarketOnly);
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
            res.end(JSON.stringify({ error: 'Invalid user prefix (minimum 5 characters)' }));
        }
        return;
    }

    // API: Get on-chain position for a wallet
    if (req.url.startsWith('/api/position/') && req.method === 'GET') {
        const walletPubkey = req.url.split('/api/position/')[1];

        if (!walletPubkey || walletPubkey.length < 32) {
            res.writeHead(400, {
                'Content-Type': 'application/json',
                ...SECURITY_HEADERS
            });
            res.end(JSON.stringify({ error: 'Invalid wallet public key' }));
            return;
        }

        (async () => {
            try {
                const position = await getOnChainPosition(walletPubkey);
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    ...SECURITY_HEADERS
                });
                res.end(JSON.stringify(position));
            } catch (err) {
                console.error('Failed to fetch position:', err);
                res.writeHead(500, {
                    'Content-Type': 'application/json',
                    ...SECURITY_HEADERS
                });
                res.end(JSON.stringify({ error: err.message }));
            }
        })();
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

                    // Cost basis is now calculated on-demand from trading_history
                    // No need to maintain separate position_cost_basis table

                    if (success) {
                        // Broadcast to SSE clients
                        const trade = {
                            side: data.side === 'UP' ? 'YES' : 'NO',
                            action: data.action,
                            amount: data.costUsd.toFixed(4),
                            shares: data.shares.toFixed(2),
                            avgPrice: data.avgPrice.toFixed(4),
                            timestamp: Date.now(),
                            user: data.userPrefix
                        };

                        tradesStreamClients.forEach(client => {
                            try {
                                client.write(`event: trade\n`);
                                client.write(`data: ${JSON.stringify(trade)}\n\n`);
                            } catch (err) {
                                console.error('Error broadcasting trade to SSE client:', err);
                                tradesStreamClients.delete(client);
                            }
                        });

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

    // API: Get quote history for a cycle
    if (req.url.startsWith('/api/quote-history/') && req.method === 'GET') {
        const cycleId = req.url.split('/api/quote-history/')[1];
        if (cycleId) {
            const history = getQuoteHistory(cycleId);
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                ...SECURITY_HEADERS
            });
            res.end(JSON.stringify({ cycleId, history }));
        } else {
            res.writeHead(400, {
                'Content-Type': 'application/json',
                ...SECURITY_HEADERS
            });
            res.end(JSON.stringify({ error: 'Invalid cycle ID' }));
        }
        return;
    }

    // API: Get recent cycles list
    if (req.url === '/api/recent-cycles' && req.method === 'GET') {
        const cycles = getRecentCycles(20);
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            ...SECURITY_HEADERS
        });
        res.end(JSON.stringify({ cycles }));
        return;
    }

    // API: Add quote snapshot (called by market poller)
    if (req.url === '/api/quote-snapshot' && req.method === 'POST') {
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
                if (data.cycleId && typeof data.upPrice === 'number' && typeof data.downPrice === 'number') {
                    const success = addQuoteSnapshot(data.cycleId, data.upPrice, data.downPrice);
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
                        res.end(JSON.stringify({ error: 'Failed to save quote snapshot' }));
                    }
                } else {
                    res.writeHead(400, {
                        'Content-Type': 'application/json',
                        ...SECURITY_HEADERS
                    });
                    res.end(JSON.stringify({ error: 'Invalid quote data' }));
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
    } else if (req.url === '/proto2') {
        filePath = '/proto2.html';
    } else if (req.url === '/logs') {
        filePath = '/logs.html';
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
    // Include current cycle ID in market data
    const dataWithCycle = {
        ...marketData,
        cycleId: cumulativeVolume ? cumulativeVolume.cycleId : null
    };
    const sseData = JSON.stringify(dataWithCycle);

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

// Calculate LMSR prices for UP/DOWN
function calculateLMSRPrices(qYes, qNo, b) {
    try {
        const expQY = Math.exp(qYes / b);
        const expQN = Math.exp(qNo / b);
        const sum = expQY + expQN;

        const yesPrice = expQY / sum;
        const noPrice = expQN / sum;

        return { yesPrice, noPrice };
    } catch (err) {
        console.error('Failed to calculate LMSR prices:', err);
        return { yesPrice: 0.5, noPrice: 0.5 };
    }
}

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

            // Track quote history for current cycle (only if market is open or stopped)
            if (cumulativeVolume && cumulativeVolume.cycleId && marketData.status <= 1) {
                const prices = calculateLMSRPrices(marketData.qYes, marketData.qNo, marketData.bScaled);
                addQuoteSnapshot(cumulativeVolume.cycleId, prices.yesPrice, prices.noPrice);
            }
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
