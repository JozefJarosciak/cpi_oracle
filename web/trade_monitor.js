#!/usr/bin/env node
// Trade Monitor - Listens to all on-chain trades and broadcasts via WebSocket

const { Connection, PublicKey } = require('@solana/web3.js');
const WebSocket = require('ws');
const fs = require('fs');

const RPC_URL = process.env.RPC_URL || 'https://rpc.testnet.x1.xyz';
const PROGRAM_ID = new PublicKey('EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF');
const WS_PORT = 3435;

// Trade storage
const MAX_TRADES = 100;
const trades = [];
const TRADES_FILE = './public/recent_trades.json';

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

function saveTrades() {
    try {
        fs.writeFileSync(TRADES_FILE, JSON.stringify(trades.slice(-MAX_TRADES), null, 2));
    } catch (err) {
        console.error('Failed to save trades:', err.message);
    }
}

// Load existing trades
try {
    if (fs.existsSync(TRADES_FILE)) {
        const data = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
        trades.push(...data);
        console.log(`Loaded ${trades.length} historical trades`);
    }
} catch (err) {
    console.error('Failed to load trades:', err.message);
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
                    amount: (net_e6 / 1_000_000).toFixed(2),
                    shares: (dq_e6 / 1_000_000).toFixed(2),
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

    // Subscribe to program logs
    const subscriptionId = connection.onLogs(
        PROGRAM_ID,
        (logs, context) => {
            if (logs.err) {
                console.log('Transaction failed:', logs.signature);
                return;
            }

            // Parse trade from logs
            const trade = parseTradeFromLogs(logs.logs, logs.signature);
            if (trade) {
                console.log(`${trade.action} ${trade.side}: ${trade.shares} shares @ ${trade.avgPrice} XNT (${trade.amount} XNT total)`);

                // Add to storage
                trades.push(trade);
                if (trades.length > MAX_TRADES) {
                    trades.shift(); // Remove oldest
                }

                // Broadcast to clients
                broadcastTrade(trade);

                // Save to disk
                saveTrades();
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
        saveTrades();
        process.exit(0);
    });
}

startMonitoring().catch(err => {
    console.error('Monitor error:', err);
    process.exit(1);
});
