const http = require('http');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const PORT = 3434;
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATUS_FILE = path.join(__dirname, '..', 'market_status.json');
const DB_FILE = path.join(__dirname, 'price_history.db');
const VOLUME_FILE = path.join(__dirname, 'cumulative_volume.json');

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
`);

const MAX_PRICE_HISTORY_HOURS = 24; // Keep up to 24 hours of price data

// Cumulative volume storage (never decreases)
let cumulativeVolume = {
    upVolume: 0,     // Total XNT spent on UP/YES trades
    downVolume: 0,   // Total XNT spent on DOWN/NO trades
    totalVolume: 0,  // Sum of both
    lastUpdate: 0    // Timestamp of last update
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

// Load cumulative volume from disk on startup
function loadCumulativeVolume() {
    try {
        if (fs.existsSync(VOLUME_FILE)) {
            const data = fs.readFileSync(VOLUME_FILE, 'utf8');
            const parsed = JSON.parse(data);
            if (parsed && typeof parsed.upVolume === 'number') {
                cumulativeVolume = parsed;
                console.log(`Loaded cumulative volume: UP=${cumulativeVolume.upVolume.toFixed(2)}, DOWN=${cumulativeVolume.downVolume.toFixed(2)}, TOTAL=${cumulativeVolume.totalVolume.toFixed(2)}`);
            }
        }
    } catch (err) {
        console.warn('Failed to load cumulative volume:', err.message);
        cumulativeVolume = {
            upVolume: 0,
            downVolume: 0,
            totalVolume: 0,
            lastUpdate: 0
        };
    }
}

// Save cumulative volume to disk (throttled)
let volumeSavePending = false;
function saveCumulativeVolume() {
    if (volumeSavePending) return;
    volumeSavePending = true;

    setTimeout(() => {
        try {
            fs.writeFileSync(VOLUME_FILE, JSON.stringify(cumulativeVolume, null, 2));
        } catch (err) {
            console.warn('Failed to save cumulative volume:', err.message);
        }
        volumeSavePending = false;
    }, 1000); // Batch writes every 1 second
}

// Initialize volume and show DB stats
loadCumulativeVolume();

// Log database statistics
const priceCount = getPriceHistoryCount();
console.log(`SQLite database loaded with ${priceCount} price records`);

// Run cleanup on startup
cleanupOldPrices();

// Schedule periodic cleanup (every hour)
setInterval(() => {
    cleanupOldPrices();
}, 60 * 60 * 1000);

// Security headers
const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com; style-src 'self' 'unsafe-inline'; connect-src 'self' https://rpc.testnet.x1.xyz wss://rpc.testnet.x1.xyz ws://localhost:3435 wss://localhost:3435; img-src 'self' data:; font-src 'self'"
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

                if ((side === 'YES' || side === 'NO') && amount > 0) {
                    // Add to cumulative volume (never subtract)
                    if (side === 'YES') {
                        cumulativeVolume.upVolume += amount;
                    } else {
                        cumulativeVolume.downVolume += amount;
                    }
                    cumulativeVolume.totalVolume = cumulativeVolume.upVolume + cumulativeVolume.downVolume;
                    cumulativeVolume.lastUpdate = Date.now();

                    // Save to disk
                    saveCumulativeVolume();

                    console.log(`Volume updated: ${side} +${amount.toFixed(2)} XNT (Total: ${cumulativeVolume.totalVolume.toFixed(2)})`);

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
                    res.end(JSON.stringify({ error: 'Invalid side or amount' }));
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
        filePath = '/hyperliquid.html';
    } else if (req.url === '/hl' || req.url === '/hyperliquid') {
        filePath = '/hyperliquid.html';
    } else if (req.url === '/proto1') {
        filePath = '/hyperliquid.html';
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
            // Add no-cache headers for JavaScript files to prevent stale code
            const headers = {
                'Content-Type': contentType,
                ...SECURITY_HEADERS
            };

            if (ext === '.js') {
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
});
