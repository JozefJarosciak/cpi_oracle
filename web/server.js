const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3434;
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATUS_FILE = path.join(__dirname, '..', 'market_status.json');

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
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ state: 'OFFLINE' }));
            } else {
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Pragma': 'no-cache',
                    'Expires': '0'
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
    } else {
        filePath = req.url;
    }
    filePath = path.join(PUBLIC_DIR, filePath);

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'text/plain';

    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404);
                res.end('404 Not Found');
            } else {
                res.writeHead(500);
                res.end('500 Internal Server Error');
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content);
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${PORT}/`);
    console.log(`Local: http://localhost:${PORT}/`);
});
