#!/usr/bin/env node
// Trade Monitor - Listens to all on-chain trades and broadcasts via WebSocket

const { Connection, PublicKey } = require('@solana/web3.js');
const WebSocket = require('ws');
const fs = require('fs');

const RPC_URL = process.env.RPC_URL || 'https://rpc.testnet.x1.xyz';
const PROGRAM_ID = new PublicKey('EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF');
const WS_PORT = 3435;

// Trade storage (in-memory only - database is source of truth)
const MAX_TRADES = 100;
const trades = [];

// Server URL for cumulative volume updates
const SERVER_URL = 'http://localhost:3434';

// User position tracking for P&L calculation
// Structure: { userPubkey: { UP: { shares, totalCost }, DOWN: { shares, totalCost } } }
const userPositions = new Map();

// Chat storage
const MAX_CHAT_MESSAGES = 100;
const chatMessages = [];
const CHAT_FILE = './public/chat_messages.json';

// Rate limiting for chat
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 60; // Max 60 messages per minute
const userMessageTimestamps = new Map(); // user -> [timestamps]

function isRateLimited(user) {
    const now = Date.now();
    const userTimestamps = userMessageTimestamps.get(user) || [];

    // Remove timestamps older than the window
    const recentTimestamps = userTimestamps.filter(ts => now - ts < RATE_LIMIT_WINDOW);

    if (recentTimestamps.length >= RATE_LIMIT_MAX) {
        return true; // Rate limited
    }

    // Add current timestamp
    recentTimestamps.push(now);
    userMessageTimestamps.set(user, recentTimestamps);
    return false;
}

// WebSocket server
const wss = new WebSocket.Server({ port: WS_PORT });
const clients = new Set();

wss.on('connection', (ws) => {
    console.log('Client connected to trade feed');
    clients.add(ws);

    // Send recent trades on connect
    ws.send(JSON.stringify({
        type: 'history',
        trades: trades.slice(-50) // Last 50 trades
    }));

    // Send recent chat messages on connect
    ws.send(JSON.stringify({
        type: 'chat_history',
        messages: chatMessages.slice(-50) // Last 50 messages
    }));

    // Handle incoming messages
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            if (msg.type === 'chat') {
                handleChatMessage(msg, ws);
            }
        } catch (err) {
            console.error('Failed to parse message:', err.message);
        }
    });

    ws.on('close', () => {
        clients.delete(ws);
        console.log('Client disconnected from trade feed');
    });
});

function broadcastTrade(trade) {
    const message = JSON.stringify({
        type: 'trade',
        trade
    });

    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

function handleChatMessage(msg, ws) {
    // Basic spam/length protection
    if (!msg.text || typeof msg.text !== 'string') return;
    if (msg.text.length > 300) return; // Max 300 chars
    if (!msg.user || typeof msg.user !== 'string') return;

    const user = msg.user.slice(0, 5); // Max 5 chars for username (wallet prefix)

    // Check rate limit
    if (isRateLimited(user)) {
        // Send error back to sender only
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Rate limit exceeded. Max 60 messages per minute.'
            }));
        }
        console.log(`[RATE LIMIT] ${user} exceeded chat rate limit`);
        return;
    }

    const chatMsg = {
        user,
        text: msg.text.slice(0, 300),
        timestamp: Date.now()
    };

    // Add to storage
    chatMessages.push(chatMsg);
    if (chatMessages.length > MAX_CHAT_MESSAGES) {
        chatMessages.shift();
    }

    // Broadcast to all clients
    broadcastChatMessage(chatMsg);

    // Save to disk
    saveChatMessages();

    console.log(`[CHAT] ${chatMsg.user}: ${chatMsg.text}`);
}

function broadcastChatMessage(chatMsg) {
    const message = JSON.stringify({
        type: 'chat',
        message: chatMsg
    });

    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// NOTE: We no longer save trades to JSON file - database is the source of truth
// All trades are saved to database via addToTradingHistory() API call
// This in-memory cache is only for WebSocket broadcasting to connected clients

// Update cumulative volume on server
async function updateCumulativeVolume(side, amount, shares) {
    try {
        const http = require('http');
        const data = JSON.stringify({ side, amount, shares });

        const options = {
            hostname: 'localhost',
            port: 3434,
            path: '/api/volume',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': data.length
            }
        };

        const req = http.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    console.log(`Cumulative volume updated: ${side} +${amount} XNT`);
                } else {
                    console.error('Failed to update volume:', body);
                }
            });
        });

        req.on('error', (err) => {
            console.error('Error updating cumulative volume:', err.message);
        });

        req.write(data);
        req.end();
    } catch (err) {
        console.error('Failed to update cumulative volume:', err.message);
    }
}

// Add trade to user's trading history
async function addToTradingHistory(userPubkey, action, side, shares, costUsd, avgPrice, pnl = null) {
    try {
        const http = require('http');
        const userPrefix = userPubkey.slice(0, 6);
        const data = JSON.stringify({
            userPrefix,
            action,
            side,
            shares,
            costUsd,
            avgPrice,
            pnl
        });

        const options = {
            hostname: 'localhost',
            port: 3434,
            path: '/api/trading-history',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': data.length
            }
        };

        const req = http.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    console.log(`Trading history saved for ${userPrefix}`);
                } else {
                    console.error('Failed to save trading history:', body);
                }
            });
        });

        req.on('error', (err) => {
            console.error('Error saving trading history:', err.message);
        });

        req.write(data);
        req.end();
    } catch (err) {
        console.error('Failed to add trading history:', err.message);
    }
}

// Update user position and calculate P&L
function updateUserPosition(trade) {
    const user = trade.user;
    const side = trade.side === 'YES' ? 'UP' : 'DOWN';
    const action = trade.action;
    const shares = parseFloat(trade.shares);
    const costUsd = parseFloat(trade.amount);
    const avgPrice = parseFloat(trade.avgPrice);

    // Initialize user position if doesn't exist
    if (!userPositions.has(user)) {
        userPositions.set(user, { UP: { shares: 0, totalCost: 0 }, DOWN: { shares: 0, totalCost: 0 } });
    }

    const userPos = userPositions.get(user);
    const position = userPos[side];

    let pnl = null;

    if (action === 'BUY') {
        // Accumulate position
        position.shares += shares;
        position.totalCost += costUsd;

        console.log(`[POS] ${user.slice(0,6)} ${side}: +${shares.toFixed(2)} shares @ ${avgPrice.toFixed(4)} XNT (Total: ${position.shares.toFixed(2)} shares, Avg: ${(position.totalCost / position.shares).toFixed(4)} XNT)`);
    } else if (action === 'SELL') {
        // Calculate P&L based on average cost basis
        const avgCostBasis = position.shares > 0 ? position.totalCost / position.shares : 0;
        const costBasis = shares * avgCostBasis;
        pnl = costUsd - costBasis; // Proceeds - Cost Basis

        // Reduce position
        position.shares -= shares;
        if (position.shares < 0) position.shares = 0; // Safety check

        position.totalCost -= costBasis;
        if (position.totalCost < 0) position.totalCost = 0; // Safety check

        const pnlSign = pnl >= 0 ? '+' : '';
        console.log(`[POS] ${user.slice(0,6)} ${side}: -${shares.toFixed(2)} shares @ ${avgPrice.toFixed(4)} XNT (P&L: ${pnlSign}${pnl.toFixed(4)} XNT, Remaining: ${position.shares.toFixed(2)} shares)`);
    }

    // Save to trading history
    addToTradingHistory(user, action, side, shares, costUsd, avgPrice, pnl);
}

function saveChatMessages() {
    try {
        fs.writeFileSync(CHAT_FILE, JSON.stringify(chatMessages.slice(-MAX_CHAT_MESSAGES), null, 2));
    } catch (err) {
        console.error('Failed to save chat:', err.message);
    }
}

// Load existing trades from database API on startup
async function loadRecentTradesFromDB() {
    try {
        const http = require('http');
        const options = {
            hostname: 'localhost',
            port: 3434,
            path: '/api/recent-trades?limit=100',
            method: 'GET'
        };

        return new Promise((resolve, reject) => {
            const req = http.request(options, (res) => {
                let body = '';
                res.on('data', (chunk) => body += chunk);
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        try {
                            const dbTrades = JSON.parse(body);
                            trades.push(...dbTrades.reverse()); // Reverse to get chronological order
                            console.log(`Loaded ${trades.length} historical trades from database`);
                            resolve();
                        } catch (err) {
                            console.error('Failed to parse trades from database:', err.message);
                            reject(err);
                        }
                    } else {
                        console.error('Failed to load trades from database, status:', res.statusCode);
                        resolve(); // Continue anyway
                    }
                });
            });

            req.on('error', (err) => {
                console.error('Error loading trades from database:', err.message);
                resolve(); // Continue anyway
            });

            req.end();
        });
    } catch (err) {
        console.error('Failed to load trades from database:', err.message);
    }
}

// Load existing chat messages
try {
    if (fs.existsSync(CHAT_FILE)) {
        const data = JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8'));
        chatMessages.push(...data);
        console.log(`Loaded ${chatMessages.length} chat messages`);
    }
} catch (err) {
    console.error('Failed to load chat:', err.message);
}

// Parse TradeSnapshot event from logs
function parseTradeFromLogs(logs, signature) {
    // Look for "Program data: " log which contains base64 encoded event
    for (const log of logs) {
        if (log.startsWith('Program data: ')) {
            try {
                const base64Data = log.substring('Program data: '.length);
                const buffer = Buffer.from(base64Data, 'base64');

                // TradeSnapshot event structure (after 8-byte discriminator):
                // side: u8, action: u8, net_e6: i64, dq_e6: i64, avg_price_e6: i64, ...
                if (buffer.length < 8 + 1 + 1 + 8 + 8 + 8) continue;

                let offset = 8; // Skip discriminator
                const side = buffer.readUInt8(offset); offset += 1;
                const action = buffer.readUInt8(offset); offset += 1;
                const net_e6 = Number(buffer.readBigInt64LE(offset)); offset += 8;
                const dq_e6 = Number(buffer.readBigInt64LE(offset)); offset += 8;
                const avg_price_e6 = Number(buffer.readBigInt64LE(offset)); offset += 8;

                return {
                    side: side === 1 ? 'YES' : 'NO',
                    action: action === 1 ? 'BUY' : 'SELL',
                    amount: (net_e6 / 10_000_000).toFixed(4),  // XNT scale: 10M per XNT, use 4 decimals
                    shares: (dq_e6 / 10_000_000).toFixed(2),   // Wrong scale in contract, divide by 10M
                    avgPrice: (avg_price_e6 / 1_000_000).toFixed(4),
                    signature,
                    timestamp: Date.now()
                };
            } catch (err) {
                console.error('Failed to parse trade data:', err.message);
            }
        }
    }
    return null;
}

// Listen for program logs
async function startMonitoring() {
    const connection = new Connection(RPC_URL, 'confirmed');
    console.log(`Monitoring trades on program: ${PROGRAM_ID.toString()}`);
    console.log(`WebSocket server running on port ${WS_PORT}`);

    // Load recent trades from database on startup
    await loadRecentTradesFromDB();

    // Subscribe to program logs
    const subscriptionId = connection.onLogs(
        PROGRAM_ID,
        async (logs, context) => {
            if (logs.err) {
                console.log('Transaction failed:', logs.signature);
                return;
            }

            // Parse trade from logs
            const trade = parseTradeFromLogs(logs.logs, logs.signature);
            if (trade) {
                // Fetch transaction to get the user's public key (fee payer)
                try {
                    const tx = await connection.getTransaction(logs.signature, {
                        maxSupportedTransactionVersion: 0
                    });
                    if (tx && tx.transaction && tx.transaction.message) {
                        const accountKeys = tx.transaction.message.getAccountKeys();
                        const feePayer = accountKeys.get(0); // First account is always the fee payer
                        trade.user = feePayer ? feePayer.toString() : 'Unknown';
                    }
                } catch (err) {
                    console.error('Failed to fetch transaction:', err.message);
                    trade.user = 'Unknown';
                }

                console.log(`${trade.user?.slice(0,5) || 'Unknown'} ${trade.action} ${trade.side}: ${trade.shares} shares @ ${trade.avgPrice} XNT`);

                // Add to storage
                trades.push(trade);
                if (trades.length > MAX_TRADES) {
                    trades.shift(); // Remove oldest
                }

                // Update cumulative volume (only for BUY actions)
                if (trade.action === 'BUY') {
                    const amount = parseFloat(trade.amount);
                    const shares = parseFloat(trade.shares);
                    if (!isNaN(amount) && amount > 0 && !isNaN(shares) && shares > 0) {
                        updateCumulativeVolume(trade.side, amount, shares);
                    }
                }

                // Update user position and track P&L
                // Skip recording for deployer/keeper wallet (they execute trades on behalf of others)
                const DEPLOYER_WALLET = 'AivknDqDUqnvyYVmDViiB2bEHKyUK5HcX91gWL2zgTZ4';
                if (trade.user && trade.user !== 'Unknown' && trade.user !== DEPLOYER_WALLET) {
                    updateUserPosition(trade);
                } else if (trade.user === DEPLOYER_WALLET) {
                    console.log(`⚠️  Skipping trade recording for deployer/keeper wallet`);
                }

                // Broadcast to clients
                broadcastTrade(trade);
            }
        },
        'confirmed'
    );

    console.log(`Subscription ID: ${subscriptionId}`);

    // Graceful shutdown
    process.on('SIGINT', async () => {
        console.log('\nShutting down...');
        await connection.removeOnLogsListener(subscriptionId);
        wss.close();
        process.exit(0);
    });
}

startMonitoring().catch(err => {
    console.error('Monitor error:', err);
    process.exit(1);
});
