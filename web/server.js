const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3434;
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATUS_FILE = path.join(__dirname, '..', 'market_status.json');

// Security headers
const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com; style-src 'self' 'unsafe-inline'; connect-src 'self' https://rpc.testnet.x1.xyz ws://localhost:3435 wss://localhost:3435; img-src 'self' data:; font-src 'self'"
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
        filePath = '/hyperliquid.html';
    } else if (req.url === '/proto1') {
        filePath = '/proto1.html';
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
            res.writeHead(200, {
                'Content-Type': contentType,
                ...SECURITY_HEADERS
            });
            res.end(content);
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${PORT}/`);
    console.log(`Local: http://localhost:${PORT}/`);
});
