#!/usr/bin/env ts-node
"use strict";
// app/keeper.ts — Keeper bot for executing dark pool limit orders
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const anchor = __importStar(require("@coral-xyz/anchor"));
const bn_js_1 = __importDefault(require("bn.js"));
const web3_js_1 = require("@solana/web3.js");
const axios_1 = __importDefault(require("axios"));
function loadConfig() {
    const configPath = path.resolve(process.cwd(), 'keeper.config.json');
    try {
        if (fs.existsSync(configPath)) {
            const configData = fs.readFileSync(configPath, 'utf8');
            return JSON.parse(configData);
        }
    }
    catch (err) {
        console.warn('⚠️  Failed to load keeper.config.json, using defaults');
    }
    return {};
}
const config = loadConfig();
const RPC = process.env.ANCHOR_PROVIDER_URL || config.rpc || 'http://127.0.0.1:8899';
const KEEPER_WALLET = process.env.KEEPER_WALLET || process.env.ANCHOR_WALLET || config.keeperWallet || `${process.env.HOME}/.config/solana/id.json`;
const ORDER_BOOK_API = process.env.ORDER_BOOK_API || config.orderbookApi || 'http://localhost:3436';
const CHECK_INTERVAL = parseInt(process.env.KEEPER_CHECK_INTERVAL || String(config.pollIntervalMs || 2000)); // ms
const MIN_PROFIT_LAMPORTS = parseInt(process.env.KEEPER_MIN_PROFIT || '100000'); // 0.0001 SOL
// Program IDs
const PID = new web3_js_1.PublicKey('EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF');
const AMM_SEED = Buffer.from('amm_btc_v6');
const POS_SEED = Buffer.from('pos');
const VAULT_SOL_SEED = Buffer.from('vault_sol');
const USER_VAULT_SEED = Buffer.from('user_vault');
/* ==================== HELPERS ==================== */
function loadKeeper(path) {
    const rawKey = JSON.parse(fs.readFileSync(path, 'utf8'));
    return web3_js_1.Keypair.fromSecretKey(Uint8Array.from(rawKey));
}
function getAmmPda() {
    const [pda] = web3_js_1.PublicKey.findProgramAddressSync([AMM_SEED], PID);
    return pda;
}
function getPositionPda(amm, user) {
    const [pda] = web3_js_1.PublicKey.findProgramAddressSync([POS_SEED, amm.toBuffer(), user.toBuffer()], PID);
    return pda;
}
function getVaultPda(amm) {
    const [pda] = web3_js_1.PublicKey.findProgramAddressSync([VAULT_SOL_SEED, amm.toBuffer()], PID);
    return pda;
}
function getUserVaultPda(position) {
    const [pda] = web3_js_1.PublicKey.findProgramAddressSync([USER_VAULT_SEED, position.toBuffer()], PID);
    return pda;
}
function serializeOrder(order) {
    // Serialize LimitOrder struct to match Rust Borsh encoding
    // Order must match Rust struct field order exactly
    const buffers = [];
    // market: Pubkey (32 bytes)
    buffers.push(order.market.toBuffer());
    // user: Pubkey (32 bytes)
    buffers.push(order.user.toBuffer());
    // action: u8 (1 byte)
    const actionBuf = Buffer.alloc(1);
    actionBuf.writeUInt8(order.action);
    buffers.push(actionBuf);
    // side: u8 (1 byte)
    const sideBuf = Buffer.alloc(1);
    sideBuf.writeUInt8(order.side);
    buffers.push(sideBuf);
    // shares_e6: i64 (8 bytes, little-endian)
    const sharesBuf = Buffer.alloc(8);
    sharesBuf.writeBigInt64LE(BigInt(order.sharesE6.toString()));
    buffers.push(sharesBuf);
    // limit_price_e6: i64 (8 bytes, little-endian)
    const limitPriceBuf = Buffer.alloc(8);
    limitPriceBuf.writeBigInt64LE(BigInt(order.limitPriceE6.toString()));
    buffers.push(limitPriceBuf);
    // max_cost_e6: i64 (8 bytes, little-endian)
    const maxCostBuf = Buffer.alloc(8);
    maxCostBuf.writeBigInt64LE(BigInt(order.maxCostE6.toString()));
    buffers.push(maxCostBuf);
    // min_proceeds_e6: i64 (8 bytes, little-endian)
    const minProceedsBuf = Buffer.alloc(8);
    minProceedsBuf.writeBigInt64LE(BigInt(order.minProceedsE6.toString()));
    buffers.push(minProceedsBuf);
    // expiry_ts: i64 (8 bytes, little-endian)
    const expiryBuf = Buffer.alloc(8);
    expiryBuf.writeBigInt64LE(BigInt(order.expiryTs.toString()));
    buffers.push(expiryBuf);
    // nonce: u64 (8 bytes, little-endian)
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(BigInt(order.nonce.toString()));
    buffers.push(nonceBuf);
    // keeper_fee_bps: u16 (2 bytes, little-endian)
    const keeperFeeBuf = Buffer.alloc(2);
    keeperFeeBuf.writeUInt16LE(order.keeperFeeBps);
    buffers.push(keeperFeeBuf);
    // min_fill_bps: u16 (2 bytes, little-endian)
    const minFillBuf = Buffer.alloc(2);
    minFillBuf.writeUInt16LE(order.minFillBps);
    buffers.push(minFillBuf);
    return Buffer.concat(buffers);
}
/* ==================== PRICE CALCULATION ==================== */
function calculateLmsrCost(amm, qYes, qNo) {
    // b uses same 10M scaling as Q values (matches app.js)
    const b = amm.b.toNumber() / 10000000;
    const a = qYes / b;
    const c = qNo / b;
    const m = Math.max(a, c);
    const ea = Math.exp(a - m);
    const ec = Math.exp(c - m);
    return b * (m + Math.log(ea + ec));
}
function calculateCurrentPrice(amm, action, side, shares) {
    // Calculate price for buying/selling shares (shares in regular units, not e6)
    // Q values use 10M scaling on-chain (10_000_000 = 1 share) - matches app.js
    const currentQYesShares = amm.qYes.toNumber() / 10000000;
    const currentQNoShares = amm.qNo.toNumber() / 10000000;
    const baseCost = calculateLmsrCost(amm, currentQYesShares, currentQNoShares);
    let targetCost;
    if (action === 1) { // BUY
        if (side === 1) { // YES
            targetCost = calculateLmsrCost(amm, currentQYesShares + shares, currentQNoShares);
        }
        else { // NO
            targetCost = calculateLmsrCost(amm, currentQYesShares, currentQNoShares + shares);
        }
    }
    else { // SELL
        if (side === 1) { // YES
            targetCost = calculateLmsrCost(amm, currentQYesShares - shares, currentQNoShares);
        }
        else { // NO
            targetCost = calculateLmsrCost(amm, currentQYesShares, currentQNoShares - shares);
        }
    }
    const netCost = Math.abs(targetCost - baseCost);
    // Apply fees
    const feeBps = amm.feeBps;
    const grossCost = action === 1
        ? netCost / (1 - feeBps / 10000)
        : netCost * (1 - feeBps / 10000);
    // Average price per share in e6 scale
    const avgPrice = (grossCost / shares) * 1e6; // Price in USD with e6 scaling
    return Math.floor(avgPrice);
}
/* ==================== ORDER CHECKING ==================== */
async function fetchPendingOrders() {
    try {
        const response = await axios_1.default.get(`${ORDER_BOOK_API}/api/orders/pending`, {
            params: { limit: 100 }
        });
        return response.data.orders;
    }
    catch (err) {
        console.error('❌ Error fetching pending orders:', err.message);
        return [];
    }
}
async function checkIfExecutable(connection, amm, order) {
    try {
        // Check market is open
        if (amm.status !== 1) {
            return false;
        }
        // Check not expired
        const now = Math.floor(Date.now() / 1000);
        if (order.expiry_ts <= now) {
            return false;
        }
        // For SELL orders, check if user has enough shares outstanding
        if (order.action === 2) { // SELL
            const qShares = order.side === 1 ? amm.qYes.toNumber() : amm.qNo.toNumber();
            if (qShares < order.shares_e6) {
                console.log(`   ⚠️  Insufficient shares outstanding (need ${order.shares_e6}, have ${qShares})`);
                return false;
            }
        }
        // Calculate current price for ONE share to check executability
        // Order shares are in e6 (1_000_000 = 1 share) but LMSR calc needs "share units" (10M = 1 share)
        const currentPrice = calculateCurrentPrice(amm, order.action, order.side, 1);
        // Account for slippage tolerance - use conservative 0.5% to match UI default
        // This ensures keeper only executes orders that have good chance of filling
        const SLIPPAGE_BPS = 50; // 0.5% conservative buffer
        const slippageFactor = SLIPPAGE_BPS / 10000;
        console.log(`   Current price: $${(currentPrice / 1e6).toFixed(6)} | Limit: $${(order.limit_price_e6 / 1e6).toFixed(6)}`);
        // For large orders, also check if execution price will pass on-chain tolerance check
        // On-chain uses 0.2% tolerance, so exec price must be within that of limit
        const orderShares = order.shares_e6 / 10000000; // Convert from 10M scale to regular share units
        const execPrice = calculateCurrentPrice(amm, order.action, order.side, orderShares);
        const onChainTolerance = 0.002; // 0.2% on-chain PRICE_SLIPPAGE_TOLERANCE_BPS
        console.log(`   Order size: ${orderShares.toFixed(2)} shares | Exec price: $${(execPrice / 1e6).toFixed(6)}`);
        // Check user's position vault balance for BUY orders (user needs to pay)
        if (order.action === 1) { // BUY
            try {
                // Read user's position account to check vault balance
                const ammPda = getAmmPda();
                const userPubkey = new web3_js_1.PublicKey(order.user);
                // Derive position PDA
                const [positionPda] = web3_js_1.PublicKey.findProgramAddressSync([POS_SEED, ammPda.toBuffer(), userPubkey.toBuffer()], PID);
                // Fetch position account data directly
                const positionAccountInfo = await connection.getAccountInfo(positionPda);
                if (!positionAccountInfo) {
                    console.error(`   ⚠️  Position account not found for user ${order.user.slice(0, 5)}...`);
                    return true; // Let on-chain handle it
                }
                // Parse vault_balance_e6 from account data
                // Position account layout:
                // discriminator(8) + owner(32) + yes_shares(8) + no_shares(8) + master_wallet(32) + vault_balance_e6(8) + ...
                // vault_balance_e6 is at offset 8+32+8+8+32 = 88
                const vaultBalanceE6 = new bn_js_1.default(positionAccountInfo.data.slice(88, 96), 'le');
                // Estimate cost: shares * price, with some buffer for fees
                // shares_e6 is in 1e6 units (1M = 1 share), execPrice is in 1e6
                // Cost formula: (shares_e6 / 1e6) * (execPrice / 1e6) = cost in XNT
                // Then multiply by 1e6 to get cost_e6
                // Simplified: shares_e6 * execPrice / 1e6
                const estimatedCost_e6 = Math.ceil(order.shares_e6 * execPrice / 1e6);
                // Add protocol fee buffer (use AMM fee_bps)
                const feeBps = amm.feeBps;
                const protocolFee_e6 = Math.ceil(estimatedCost_e6 * feeBps / 10000);
                const totalRequired_e6 = estimatedCost_e6 + protocolFee_e6;
                const totalRequiredBN = new bn_js_1.default(totalRequired_e6);
                if (vaultBalanceE6.lt(totalRequiredBN)) {
                    console.log(`   ❌ Insufficient user vault balance: need ${totalRequired_e6} e6 (${(totalRequired_e6 / 1e6).toFixed(2)} XNT), have ${vaultBalanceE6.toString()} e6`);
                    return false;
                }
                console.log(`   ✅ User vault balance check: ${totalRequired_e6} e6 needed (${(totalRequired_e6 / 1e6).toFixed(2)} XNT), ${vaultBalanceE6.toString()} e6 available`);
            }
            catch (err) {
                console.error(`   ⚠️  Could not check user vault balance: ${err.message}`);
                // Continue anyway - let on-chain check handle it
            }
        }
        // Check price condition with slippage buffer
        if (order.action === 1) { // BUY
            // For BUY: price must be below limit, accounting for slippage making it worse
            const maxAcceptable = order.limit_price_e6 * (1 - slippageFactor);
            const executable = currentPrice <= maxAcceptable;
            console.log(`   BUY condition: ${currentPrice} <= ${Math.floor(maxAcceptable)} (limit=${order.limit_price_e6} - ${slippageFactor * 100}%) = ${executable}`);
            // Also check if execution price passes on-chain check
            const maxAllowedOnChain = order.limit_price_e6 * (1 + onChainTolerance);
            if (executable && execPrice > maxAllowedOnChain) {
                console.log(`   ⚠️  Would fail on-chain: exec ${execPrice} > ${Math.floor(maxAllowedOnChain)} (limit + 0.2%)`);
                // For partial fill orders (min_fill_bps = 0), still try - on-chain will find max executable
                if (order.min_fill_bps === 0) {
                    console.log(`   🔄 Partial fill enabled - will attempt execution (on-chain will find max amount)`);
                    return true;
                }
                return false;
            }
            // Even if conservative check failed, try partial fill orders - let on-chain decide
            if (!executable && order.min_fill_bps === 0 && currentPrice <= order.limit_price_e6) {
                console.log(`   🔄 Partial fill enabled - attempting despite conservative buffer (current ${currentPrice} <= limit ${order.limit_price_e6})`);
                return true;
            }
            return executable;
        }
        else { // SELL
            // For SELL: price must be above limit, accounting for slippage making it worse
            const minAcceptable = order.limit_price_e6 * (1 + slippageFactor);
            const executable = currentPrice >= minAcceptable;
            console.log(`   SELL condition: ${currentPrice} >= ${Math.floor(minAcceptable)} (limit=${order.limit_price_e6} + ${slippageFactor * 100}%) = ${executable}`);
            // Also check if execution price passes on-chain check
            const minAllowedOnChain = order.limit_price_e6 * (1 - onChainTolerance);
            if (executable && execPrice < minAllowedOnChain) {
                console.log(`   ⚠️  Would fail on-chain: exec ${execPrice} < ${Math.floor(minAllowedOnChain)} (limit - 0.2%)`);
                // For partial fill orders (min_fill_bps = 0), still try - on-chain will find max executable
                if (order.min_fill_bps === 0) {
                    console.log(`   🔄 Partial fill enabled - will attempt execution (on-chain will find max amount)`);
                    return true;
                }
                return false;
            }
            // Even if conservative check failed, try partial fill orders - let on-chain decide
            if (!executable && order.min_fill_bps === 0 && currentPrice >= order.limit_price_e6) {
                console.log(`   🔄 Partial fill enabled - attempting despite conservative buffer (current ${currentPrice} >= limit ${order.limit_price_e6})`);
                return true;
            }
            return executable;
        }
    }
    catch (err) {
        console.error(`❌ Error checking executability:`, err.message);
        return false;
    }
}
/* ==================== ORDER EXECUTION ==================== */
async function executeOrder(connection, keeper, order, signature, orderId) {
    try {
        const ammPda = getAmmPda();
        const userPubkey = new web3_js_1.PublicKey(order.user);
        const positionPda = getPositionPda(ammPda, userPubkey);
        const vaultSolPda = getVaultPda(ammPda);
        const userVaultPda = getUserVaultPda(positionPda);
        console.log(`\n🔧 Building transaction for order ${orderId}...`);
        console.log(`   User: ${order.user.slice(0, 5)}...`);
        console.log(`   Action: ${order.action === 1 ? 'BUY' : 'SELL'} ${order.side === 1 ? 'YES' : 'NO'}`);
        console.log(`   Shares: ${order.shares_e6 / 10000000}`);
        console.log(`   Limit Price: $${(order.limit_price_e6 / 1e6).toFixed(6)}`);
        // Load IDL and create program
        const idl = JSON.parse(fs.readFileSync('target/idl/cpi_oracle.json', 'utf8'));
        const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(keeper), { commitment: 'confirmed' });
        const program = new anchor.Program(idl, provider);
        // Fetch AMM account to get fee_dest
        const ammAccountInfo = await connection.getAccountInfo(ammPda);
        if (!ammAccountInfo) {
            throw new Error('AMM account not found');
        }
        // Decode AMM account - feeDest is at offset 70 (empirically determined)
        const feeDest = new web3_js_1.PublicKey(ammAccountInfo.data.slice(70, 102));
        // Build limit order struct for instruction
        const limitOrderStruct = {
            market: new web3_js_1.PublicKey(order.market),
            user: userPubkey,
            action: order.action,
            side: order.side,
            sharesE6: new bn_js_1.default(order.shares_e6),
            limitPriceE6: new bn_js_1.default(order.limit_price_e6),
            maxCostE6: new bn_js_1.default(order.max_cost_e6),
            minProceedsE6: new bn_js_1.default(order.min_proceeds_e6),
            expiryTs: new bn_js_1.default(order.expiry_ts),
            nonce: new bn_js_1.default(order.nonce),
            keeperFeeBps: order.keeper_fee_bps,
            minFillBps: order.min_fill_bps,
        };
        // Convert signature from hex to Uint8Array (64 bytes)
        const signatureBytes = Buffer.from(signature, 'hex');
        if (signatureBytes.length !== 64) {
            throw new Error(`Invalid signature length: ${signatureBytes.length} (expected 64)`);
        }
        const signatureArray = Array.from(signatureBytes);
        // Serialize the order using Borsh (must match Rust serialization)
        const messageBytes = serializeOrder(limitOrderStruct);
        // Manually create Ed25519 verification instruction without account metadata
        // This avoids the "writable privilege escalation" error
        const ED25519_PROGRAM_ID = new web3_js_1.PublicKey('Ed25519SigVerify111111111111111111111111111');
        // Build instruction data according to Ed25519 program format:
        // [num_signatures: u8][padding: u8][signature_offset: u16][signature_instruction_index: u16]
        // [public_key_offset: u16][public_key_instruction_index: u16][message_data_offset: u16]
        // [message_data_size: u16][message_instruction_index: u16][public_key: 32 bytes][signature: 64 bytes][message: variable]
        const publicKeyBytes = userPubkey.toBytes();
        const numSignatures = 1;
        const publicKeyOffset = 16; // Offset to public key data
        const signatureOffset = 48; // Offset to signature data (16 + 32)
        const messageDataOffset = 112; // Offset to message data (16 + 32 + 64)
        const messageDataSize = messageBytes.length;
        const signatureInstructionIndex = 0xffff; // Special value meaning "this instruction"
        const publicKeyInstructionIndex = 0xffff;
        const messageInstructionIndex = 0xffff;
        // Create header buffer with proper byte order
        const headerBuffer = Buffer.alloc(16);
        headerBuffer.writeUInt8(numSignatures, 0); // offset 0: num_signatures
        headerBuffer.writeUInt8(0, 1); // offset 1: padding
        headerBuffer.writeUInt16LE(signatureOffset, 2); // offset 2-3: signature_offset
        headerBuffer.writeUInt16LE(signatureInstructionIndex, 4); // offset 4-5: signature_instruction_index
        headerBuffer.writeUInt16LE(publicKeyOffset, 6); // offset 6-7: public_key_offset
        headerBuffer.writeUInt16LE(publicKeyInstructionIndex, 8); // offset 8-9: public_key_instruction_index
        headerBuffer.writeUInt16LE(messageDataOffset, 10); // offset 10-11: message_data_offset
        headerBuffer.writeUInt16LE(messageDataSize, 12); // offset 12-13: message_data_size
        headerBuffer.writeUInt16LE(messageInstructionIndex, 14); // offset 14-15: message_instruction_index
        const ed25519InstructionData = Buffer.concat([
            headerBuffer, // 16 bytes: header
            Buffer.from(publicKeyBytes), // 32 bytes: public key
            signatureBytes, // 64 bytes: signature
            messageBytes, // variable: message
        ]);
        // Create the instruction WITHOUT any accounts (no account metadata)
        const ed25519Ix = new web3_js_1.TransactionInstruction({
            keys: [], // Empty array - no accounts referenced
            programId: ED25519_PROGRAM_ID,
            data: ed25519InstructionData,
        });
        // Create compute budget instruction to increase CU limit
        const computeBudgetIx = web3_js_1.ComputeBudgetProgram.setComputeUnitLimit({
            units: 1400000, // Increased for binary search in partial fills
        });
        console.log(`   Executing on-chain with Anchor...`);
        console.log(`     - AMM: ${ammPda.toString()}`);
        console.log(`     - Position: ${positionPda.toString()}`);
        console.log(`     - User Vault: ${userVaultPda.toString()}`);
        console.log(`     - Fee Dest: ${feeDest.toString()}`);
        console.log(`     - Vault Sol: ${vaultSolPda.toString()}`);
        console.log(`     - User: ${userPubkey.toString()}`);
        console.log(`     - Keeper: ${keeper.publicKey.toString()}`);
        console.log(`     - Instructions Sysvar: ${web3_js_1.SYSVAR_INSTRUCTIONS_PUBKEY.toString()}`);
        // Execute the limit order instruction with Ed25519 verification
        const tx = await program.methods
            .executeLimitOrder(limitOrderStruct, signatureArray)
            .accountsStrict({
            amm: ammPda,
            position: positionPda,
            userVault: userVaultPda,
            feeDest: feeDest,
            vaultSol: vaultSolPda,
            user: userPubkey,
            keeper: keeper.publicKey,
            instructions: web3_js_1.SYSVAR_INSTRUCTIONS_PUBKEY,
            systemProgram: web3_js_1.SystemProgram.programId,
        })
            .preInstructions([
            computeBudgetIx, // Increase compute budget first
            ed25519Ix, // Ed25519 verification must come before the main instruction
        ])
            .rpc();
        console.log(`✅ Transaction sent: ${tx}`);
        console.log(`   View: https://explorer.solana.com/tx/${tx}?cluster=custom`);
        // Wait for transaction confirmation and fetch logs to parse actual filled amount
        await connection.confirmTransaction(tx, 'confirmed');
        const txDetails = await connection.getTransaction(tx, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0
        });
        if (!txDetails || !txDetails.meta || !txDetails.meta.logMessages) {
            console.error('❌ Could not fetch transaction details');
            return null;
        }
        // Parse logs to extract actual filled shares from TradeSnapshot event
        // Look for log line: "📊 Trade completed: net=X dq=Y avg_price=Z"
        let filledShares = order.shares_e6; // Fallback to requested shares
        let executionPrice = order.limit_price_e6; // Fallback to limit price
        for (const log of txDetails.meta.logMessages) {
            // Parse the dq (delta quantity = filled shares) from logs
            const dqMatch = log.match(/dq=(\d+)/);
            if (dqMatch) {
                filledShares = parseInt(dqMatch[1]);
                console.log(`📊 Parsed filled shares from logs: ${filledShares} (${filledShares / 10000000} shares)`);
            }
            // Parse execution price if available in logs
            const priceMatch = log.match(/exec_price=(\d+)/);
            if (priceMatch) {
                executionPrice = parseInt(priceMatch[1]);
                console.log(`💰 Parsed execution price from logs: ${executionPrice} ($${(executionPrice / 1e6).toFixed(6)})`);
            }
        }
        return {
            txSignature: tx,
            filledShares,
            executionPrice
        };
    }
    catch (err) {
        console.error(`❌ Error executing order ${orderId}:`, err.message);
        if (err.logs) {
            console.error('Transaction logs:', err.logs);
        }
        return null;
    }
}
async function markOrderFilled(orderId, txSignature, sharesFilled, executionPrice, keeperPubkey) {
    try {
        await axios_1.default.post(`${ORDER_BOOK_API}/api/orders/${orderId}/fill`, {
            tx_signature: txSignature,
            shares_filled: sharesFilled,
            execution_price: executionPrice,
            keeper_pubkey: keeperPubkey,
        });
        console.log(`✅ Order ${orderId} marked as filled in database`);
    }
    catch (err) {
        console.error(`❌ Error marking order ${orderId} as filled:`, err.message);
    }
}
async function updateCostBasis(userPubkey, action, side, shares, costUsd, avgPrice) {
    try {
        const userPrefix = userPubkey.slice(0, 6);
        await axios_1.default.post('http://localhost:3434/api/trading-history', {
            userPrefix,
            walletPubkey: userPubkey,
            action,
            side,
            shares,
            costUsd,
            avgPrice,
            pnl: null
        });
        console.log(`✅ Cost basis updated for ${userPrefix} ${action} ${side}: ${shares.toFixed(2)} shares @ $${avgPrice.toFixed(4)}`);
    }
    catch (err) {
        console.error(`❌ Error updating cost basis:`, err.message);
    }
}
/* ==================== MAIN LOOP ==================== */
async function keeperLoop() {
    const keeper = loadKeeper(KEEPER_WALLET);
    const connection = new web3_js_1.Connection(RPC, 'confirmed');
    const ammPda = getAmmPda();
    console.log('🤖 Keeper Bot Started');
    console.log('━'.repeat(60));
    console.log(`Keeper:         ${keeper.publicKey.toString()}`);
    console.log(`RPC:            ${RPC}`);
    console.log(`Order Book API: ${ORDER_BOOK_API}`);
    console.log(`AMM:            ${ammPda.toString()}`);
    console.log(`Check Interval: ${CHECK_INTERVAL}ms`);
    console.log('━'.repeat(60));
    let iteration = 0;
    while (true) {
        try {
            iteration++;
            const timestamp = new Date().toISOString();
            // Fetch pending orders
            const orders = await fetchPendingOrders();
            if (orders.length === 0) {
                if (iteration % 10 === 0) {
                    console.log(`[${timestamp}] 💤 No pending orders (checked ${iteration} times)`);
                }
            }
            else {
                console.log(`\n[${timestamp}] 📋 Found ${orders.length} pending order(s)`);
                // Fetch AMM state
                const ammAccountInfo = await connection.getAccountInfo(ammPda);
                if (!ammAccountInfo) {
                    console.error('❌ AMM account not found');
                    await sleep(CHECK_INTERVAL);
                    continue;
                }
                // Deserialize AMM account from on-chain data
                const d = ammAccountInfo.data;
                let o = 8; // Skip discriminator
                const bump = d.readUInt8(o);
                o += 1;
                const decimals = d.readUInt8(o);
                o += 1;
                const bRaw = d.readBigInt64LE(o);
                o += 8;
                const feeBps = d.readUInt16LE(o);
                o += 2;
                const qYesRaw = d.readBigInt64LE(o);
                o += 8;
                const qNoRaw = d.readBigInt64LE(o);
                o += 8;
                const feesRaw = d.readBigInt64LE(o);
                o += 8;
                const vaultE6Raw = d.readBigInt64LE(o);
                o += 8;
                const status = d.readUInt8(o);
                o += 1;
                const amm = {
                    bump,
                    decimals,
                    b: new bn_js_1.default(bRaw.toString()),
                    feeBps,
                    qYes: new bn_js_1.default(qYesRaw.toString()),
                    qNo: new bn_js_1.default(qNoRaw.toString()),
                    fees: new bn_js_1.default(feesRaw.toString()),
                    vaultE6: new bn_js_1.default(vaultE6Raw.toString()),
                    status,
                    winner: 0,
                    wTotalE6: new bn_js_1.default(0),
                    ppsE6: new bn_js_1.default(0),
                    feeDest: keeper.publicKey,
                    vaultSolBump: 0,
                    startPriceE6: new bn_js_1.default(0),
                    startTs: new bn_js_1.default(0),
                    settlePriceE6: new bn_js_1.default(0),
                    settleTs: new bn_js_1.default(0),
                    marketEndSlot: new bn_js_1.default(0),
                    marketEndTime: new bn_js_1.default(0),
                };
                console.log(`📊 AMM State: qYes=${amm.qYes.toNumber() / 1e6}, qNo=${amm.qNo.toNumber() / 1e6}, status=${amm.status}`);
                // Check each order
                for (const orderData of orders) {
                    const { order, signature, order_id } = orderData;
                    console.log(`\n🔍 Checking order ${order_id}:`);
                    console.log(`   User: ${order.user.slice(0, 5)}...`);
                    console.log(`   ${order.action === 1 ? 'BUY' : 'SELL'} ${order.shares_e6 / 10000000} ${order.side === 1 ? 'YES' : 'NO'} @ limit $${(order.limit_price_e6 / 1e6).toFixed(6)}`);
                    const executable = await checkIfExecutable(connection, amm, order);
                    if (executable) {
                        console.log(`✅ Order ${order_id} is executable!`);
                        const result = await executeOrder(connection, keeper, order, signature, order_id);
                        if (result) {
                            console.log(`✅ Order ${order_id} executed: ${result.txSignature}`);
                            console.log(`   Filled: ${result.filledShares / 10000000} shares (requested: ${order.shares_e6 / 10000000})`);
                            console.log(`   Execution Price: $${(result.executionPrice / 1e6).toFixed(6)}`);
                            // Mark as filled in database with ACTUAL filled shares
                            await markOrderFilled(order_id, result.txSignature, result.filledShares, // Use actual filled shares from transaction logs
                            result.executionPrice, // Use actual execution price from logs
                            keeper.publicKey.toString());
                            // Update cost basis for the user
                            const sharesDecimal = result.filledShares / 10000000;
                            const priceDecimal = result.executionPrice / 1e6;
                            const costUsd = sharesDecimal * priceDecimal;
                            const action = order.action === 1 ? 'BUY' : 'SELL';
                            const side = order.side === 1 ? 'UP' : 'DOWN';
                            await updateCostBasis(order.user, action, side, sharesDecimal, costUsd, priceDecimal);
                        }
                        else {
                            console.log(`⚠️  Order ${order_id} execution skipped (implementation pending)`);
                        }
                    }
                    else {
                        console.log(`❌ Order ${order_id} not executable yet (price condition not met or expired)`);
                    }
                }
            }
        }
        catch (err) {
            console.error('❌ Error in keeper loop:', err.message);
        }
        await sleep(CHECK_INTERVAL);
    }
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
/* ==================== START ==================== */
keeperLoop().catch((err) => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
