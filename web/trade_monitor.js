#!/usr/bin/env node
// Trade Monitor - Listens to all on-chain trades and broadcasts via WebSocket
// Also tracks points for deposits, trades, and wins

const { Connection, PublicKey } = require('@solana/web3.js');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// Points system
const { PointsDB } = require('../points/points.js');
const pointsDb = new PointsDB(path.join(__dirname, '../points/points.db'));

// Access main server's database for cost basis lookup
const Database = require('better-sqlite3');
const priceHistoryDb = new Database(path.join(__dirname, 'price_history.db'), { readonly: true });

const RPC_URL = process.env.RPC_URL || 'https://rpc.testnet.x1.xyz';
const PROGRAM_ID = new PublicKey('EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF');
const AMM_SEED = Buffer.from('amm_btc_v6');
const POS_SEED = Buffer.from('pos');
const WS_PORT = 3435;

// Cache for session wallet -> master wallet mapping
const masterWalletCache = new Map();

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
            walletPubkey: userPubkey,  // Include full wallet pubkey for cost basis tracking
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

// ============= POINTS SYSTEM HELPERS =============

// Conversion constants (must match program)
const LAMPORTS_PER_E6 = 100;
const E6_PER_XNT = 10_000_000;
const LAMPORTS_PER_XNT = E6_PER_XNT * LAMPORTS_PER_E6;

// Get master wallet from position account (with caching)
async function getMasterWallet(connection, sessionWallet) {
    if (masterWalletCache.has(sessionWallet)) {
        return masterWalletCache.get(sessionWallet);
    }

    try {
        const sessionPubkey = new PublicKey(sessionWallet);
        const [ammPda] = PublicKey.findProgramAddressSync([AMM_SEED], PROGRAM_ID);
        const [posPda] = PublicKey.findProgramAddressSync(
            [POS_SEED, ammPda.toBuffer(), sessionPubkey.toBuffer()],
            PROGRAM_ID
        );

        const posAccount = await connection.getAccountInfo(posPda);
        if (!posAccount || posAccount.data.length < 8 + 32 + 8 + 8 + 32) {
            return null;
        }

        // Position layout: disc(8) + owner(32) + yes_shares(8) + no_shares(8) + master_wallet(32)
        const masterWallet = new PublicKey(posAccount.data.slice(8 + 32 + 8 + 8, 8 + 32 + 8 + 8 + 32));
        const masterWalletStr = masterWallet.toString();

        masterWalletCache.set(sessionWallet, masterWalletStr);
        return masterWalletStr;
    } catch (err) {
        console.error(`Failed to get master wallet for ${sessionWallet}:`, err.message);
        return null;
    }
}

// Award points for a trade
async function awardTradePoints(connection, sessionWallet, sharesE6, side, direction, txSignature) {
    try {
        // Check if already processed
        if (pointsDb.txExists(txSignature)) {
            return;
        }

        const masterWallet = await getMasterWallet(connection, sessionWallet);
        if (!masterWallet) {
            console.log(`[POINTS] Skipping trade - no master wallet for ${sessionWallet.slice(0,8)}`);
            return;
        }

        const result = pointsDb.recordTrade(masterWallet, sharesE6, side, direction, txSignature);
        if (result.points > 0) {
            console.log(`[POINTS] +${result.points} trade points to ${masterWallet.slice(0,8)} (${direction} ${side})`);
        }
    } catch (err) {
        console.error('[POINTS] Failed to award trade points:', err.message);
    }
}

// Parse deposit events from logs
function parseDepositFromLogs(logs) {
    for (const log of logs) {
        // Look for: "✅ Deposited X lamports"
        const match = log.match(/Deposited (\d+) lamports/);
        if (match) {
            return { amountLamports: parseInt(match[1]) };
        }
    }
    return null;
}

// Parse redeem/win events from logs
function parseRedeemFromLogs(logs) {
    for (const log of logs) {
        // Look for: "💸 REDEEM pay=X lamports" or "💸 ADMIN_REDEEM user=X pay=Y lamports"
        const redeemMatch = log.match(/REDEEM pay=(\d+) lamports/);
        if (redeemMatch) {
            return { payoutLamports: parseInt(redeemMatch[1]), userFromLog: null };
        }
        // For AdminRedeem, extract the user from the log since fee payer is the operator
        const adminMatch = log.match(/ADMIN_REDEEM user=(\S+) pay=(\d+) lamports/);
        if (adminMatch) {
            return { payoutLamports: parseInt(adminMatch[2]), userFromLog: adminMatch[1] };
        }
    }
    return null;
}

// Award points for deposit
async function awardDepositPoints(connection, sessionWallet, amountLamports, txSignature) {
    try {
        if (pointsDb.txExists(txSignature)) return;

        const masterWallet = await getMasterWallet(connection, sessionWallet);
        if (!masterWallet) return;

        const result = pointsDb.recordDeposit(masterWallet, amountLamports, txSignature);
        if (result.points > 0) {
            const xnt = amountLamports / LAMPORTS_PER_XNT;
            console.log(`[POINTS] +${result.points} deposit points to ${masterWallet.slice(0,8)} (${xnt.toFixed(2)} XNT)`);
        }
    } catch (err) {
        console.error('[POINTS] Failed to award deposit points:', err.message);
    }
}

// Get cost basis from trading history for the CURRENT CYCLE only
// Returns the winning side's cost basis (the side with positive shares)
function getCostBasisForWallet(sessionWallet) {
    try {
        const userPrefix = sessionWallet.slice(0, 6);

        // Get latest cycle_id from this user's most recent trade
        const cycleRow = priceHistoryDb.prepare(`
            SELECT cycle_id FROM trading_history
            WHERE user_prefix = ?
            ORDER BY timestamp DESC LIMIT 1
        `).get(userPrefix);

        if (!cycleRow) {
            console.log(`[POINTS] No trading history found for ${userPrefix}`);
            return { yesCostUsd: 0, noCostUsd: 0, yesShares: 0, noShares: 0 };
        }
        const cycleId = cycleRow.cycle_id;

        // Get all trades for this wallet in this cycle only
        const trades = priceHistoryDb.prepare(`
            SELECT action, side, shares, cost_usd
            FROM trading_history
            WHERE user_prefix = ? AND cycle_id = ?
            ORDER BY timestamp ASC
        `).all(userPrefix, cycleId);

        let yesCostBasis = 0;
        let noCostBasis = 0;
        let yesShares = 0;
        let noShares = 0;

        for (const trade of trades) {
            const isYes = (trade.side === 'YES' || trade.side === 'UP');

            if (trade.action === 'BUY') {
                if (isYes) {
                    yesCostBasis += trade.cost_usd;
                    yesShares += trade.shares;
                } else {
                    noCostBasis += trade.cost_usd;
                    noShares += trade.shares;
                }
            } else if (trade.action === 'SELL') {
                if (isYes && yesShares > 0) {
                    const proportionSold = Math.min(1, trade.shares / yesShares);
                    yesCostBasis -= yesCostBasis * proportionSold;
                    yesShares -= trade.shares;
                } else if (!isYes && noShares > 0) {
                    const proportionSold = Math.min(1, trade.shares / noShares);
                    noCostBasis -= noCostBasis * proportionSold;
                    noShares -= trade.shares;
                }
            }
        }

        return {
            yesCostUsd: yesCostBasis,
            noCostUsd: noCostBasis,
            yesShares: yesShares,
            noShares: noShares,
            cycleId: cycleId
        };
    } catch (err) {
        console.error('[POINTS] Failed to get cost basis:', err.message);
        return { yesCostUsd: 0, noCostUsd: 0, yesShares: 0, noShares: 0 };
    }
}

// Award points for win/redeem - based on PROFIT only (payout - winning side cost basis)
async function awardWinPoints(connection, sessionWallet, payoutLamports, txSignature) {
    try {
        if (pointsDb.txExists(txSignature)) return;

        const masterWallet = await getMasterWallet(connection, sessionWallet);
        if (!masterWallet) return;

        // Get cost basis for current cycle
        const costBasis = getCostBasisForWallet(sessionWallet);
        const payoutXnt = payoutLamports / LAMPORTS_PER_XNT;

        // Use winning side's cost basis (the side with more shares in current cycle)
        // If user bought YES and YES won, use YES cost. Same for NO.
        let costXnt;
        let winningSide;
        if (costBasis.yesShares >= costBasis.noShares) {
            costXnt = costBasis.yesCostUsd;
            winningSide = 'YES';
        } else {
            costXnt = costBasis.noCostUsd;
            winningSide = 'NO';
        }

        const profitXnt = payoutXnt - costXnt;

        // Only award points on positive profit
        if (profitXnt <= 0) {
            console.log(`[POINTS] No win points - ${winningSide} payout ${payoutXnt.toFixed(2)} XNT, cost ${costXnt.toFixed(2)} XNT, profit ${profitXnt.toFixed(2)} XNT`);
            return;
        }

        // Convert profit to lamports for recordWin
        const profitLamports = Math.floor(profitXnt * LAMPORTS_PER_XNT);
        const result = pointsDb.recordWin(masterWallet, profitLamports, txSignature);
        if (result.points > 0) {
            console.log(`[POINTS] +${result.points} win points to ${masterWallet.slice(0,8)} (${winningSide} profit: ${profitXnt.toFixed(2)} XNT, payout: ${payoutXnt.toFixed(2)} XNT, cost: ${costXnt.toFixed(2)} XNT)`);
        }
    } catch (err) {
        console.error('[POINTS] Failed to award win points:', err.message);
    }
}

// ============= END POINTS SYSTEM =============

// Parse TradeSnapshot event from logs
function parseTradesFromLogs(logs, signature) {
    // Look for ALL "Program data: " logs which contain base64 encoded events
    // ClosePosition can emit multiple TradeSnapshot events (one for each side)
    const trades = [];

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

                trades.push({
                    side: side === 1 ? 'YES' : 'NO',
                    action: action === 1 ? 'BUY' : 'SELL',
                    amount: (net_e6 / 10_000_000).toFixed(4),  // XNT scale: 10M per XNT, use 4 decimals
                    shares: (dq_e6 / 10_000_000).toFixed(2),   // Wrong scale in contract, divide by 10M
                    avgPrice: (avg_price_e6 / 1_000_000).toFixed(4),
                    signature,
                    timestamp: Date.now()
                });
            } catch (err) {
                console.error('Failed to parse trade data:', err.message);
            }
        }
    }
    return trades.length > 0 ? trades : null;
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

            // Parse trades from logs (can be multiple for ClosePosition)
            const parsedTrades = parseTradesFromLogs(logs.logs, logs.signature);
            if (parsedTrades) {
                // Fetch transaction once to get the user's public key (fee payer)
                let userPubkey = 'Unknown';
                try {
                    const tx = await connection.getTransaction(logs.signature, {
                        maxSupportedTransactionVersion: 0
                    });
                    if (tx && tx.transaction && tx.transaction.message) {
                        const accountKeys = tx.transaction.message.getAccountKeys();
                        const feePayer = accountKeys.get(0);
                        userPubkey = feePayer ? feePayer.toString() : 'Unknown';
                    }
                } catch (err) {
                    console.error('Failed to fetch transaction:', err.message);
                }

                // Skip deployer/keeper wallet trades entirely
                const DEPLOYER_WALLET = 'AivknDqDUqnvyYVmDViiB2bEHKyUK5HcX91gWL2zgTZ4';
                if (userPubkey === DEPLOYER_WALLET) {
                    console.log(`⚠️  Skipping keeper trade: ${parsedTrades.length} events from ${logs.signature.slice(0, 8)}...`);
                    return;
                }

                // Process each trade event (ClosePosition can have multiple)
                for (const trade of parsedTrades) {
                    trade.user = userPubkey;

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
                    if (trade.user && trade.user !== 'Unknown') {
                        updateUserPosition(trade);
                    }

                    // Award points for trade
                    if (userPubkey && userPubkey !== 'Unknown') {
                        const sharesE6 = Math.floor(parseFloat(trade.shares) * 1_000_000);
                        const side = trade.side.toLowerCase();
                        const direction = trade.action.toLowerCase();
                        awardTradePoints(connection, userPubkey, sharesE6, side, direction, logs.signature);
                    }

                    // Broadcast to clients
                    broadcastTrade(trade);
                }

                // Log summary if multiple trades (ClosePosition)
                if (parsedTrades.length > 1) {
                    console.log(`📦 Processed ${parsedTrades.length} trade events from ClosePosition`);
                }
            }

            // Check for deposit events (even if no trade)
            const depositEvent = parseDepositFromLogs(logs.logs);
            if (depositEvent && depositEvent.amountLamports > 0) {
                // Get user from transaction
                let userPubkey = null;
                try {
                    const tx = await connection.getTransaction(logs.signature, { maxSupportedTransactionVersion: 0 });
                    if (tx?.transaction?.message) {
                        const accountKeys = tx.transaction.message.getAccountKeys();
                        userPubkey = accountKeys.get(0)?.toString();
                    }
                } catch (err) { /* ignore */ }

                if (userPubkey) {
                    awardDepositPoints(connection, userPubkey, depositEvent.amountLamports, logs.signature);
                }
            }

            // Check for redeem/win events
            const redeemEvent = parseRedeemFromLogs(logs.logs);
            if (redeemEvent && redeemEvent.payoutLamports > 0) {
                // For AdminRedeem, user is in the log; for regular Redeem, get from transaction
                let userPubkey = redeemEvent.userFromLog;
                if (!userPubkey) {
                    try {
                        const tx = await connection.getTransaction(logs.signature, { maxSupportedTransactionVersion: 0 });
                        if (tx?.transaction?.message) {
                            const accountKeys = tx.transaction.message.getAccountKeys();
                            userPubkey = accountKeys.get(0)?.toString();
                        }
                    } catch (err) { /* ignore */ }
                }

                if (userPubkey) {
                    awardWinPoints(connection, userPubkey, redeemEvent.payoutLamports, logs.signature);
                }
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
        pointsDb.close();
        console.log('Points database closed');
        process.exit(0);
    });
}

startMonitoring().catch(err => {
    console.error('Monitor error:', err);
    process.exit(1);
});
