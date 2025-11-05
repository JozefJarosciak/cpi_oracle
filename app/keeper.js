#!/usr/bin/env ts-node
"use strict";
// app/keeper.ts — Keeper bot for executing dark pool limit orders
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
var fs = require("fs");
var anchor = require("@coral-xyz/anchor");
var web3_js_1 = require("@solana/web3.js");
var axios_1 = require("axios");
/* ==================== CONFIG ==================== */
var RPC = process.env.ANCHOR_PROVIDER_URL || 'http://127.0.0.1:8899';
var KEEPER_WALLET = process.env.KEEPER_WALLET || process.env.ANCHOR_WALLET || "".concat(process.env.HOME, "/.config/solana/id.json");
var ORDER_BOOK_API = process.env.ORDER_BOOK_API || 'http://localhost:3436';
var CHECK_INTERVAL = parseInt(process.env.KEEPER_CHECK_INTERVAL || '2000'); // ms
var MIN_PROFIT_LAMPORTS = parseInt(process.env.KEEPER_MIN_PROFIT || '100000'); // 0.0001 SOL
// Program IDs
var PID = new web3_js_1.PublicKey('EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF');
var AMM_SEED = Buffer.from('amm_btc_v6');
var POS_SEED = Buffer.from('pos');
var VAULT_SOL_SEED = Buffer.from('vault_sol');
/* ==================== HELPERS ==================== */
function loadKeeper(path) {
    var rawKey = JSON.parse(fs.readFileSync(path, 'utf8'));
    return web3_js_1.Keypair.fromSecretKey(Uint8Array.from(rawKey));
}
function getAmmPda() {
    var pda = web3_js_1.PublicKey.findProgramAddressSync([AMM_SEED], PID)[0];
    return pda;
}
function getPositionPda(amm, user) {
    var pda = web3_js_1.PublicKey.findProgramAddressSync([POS_SEED, amm.toBuffer(), user.toBuffer()], PID)[0];
    return pda;
}
function getVaultPda(amm) {
    var pda = web3_js_1.PublicKey.findProgramAddressSync([VAULT_SOL_SEED, amm.toBuffer()], PID)[0];
    return pda;
}
/* ==================== PRICE CALCULATION ==================== */
function calculateLmsrCost(amm, qYes, qNo) {
    var b = amm.b.toNumber() / 1e6;
    var a = qYes / b;
    var c = qNo / b;
    var m = Math.max(a, c);
    var ea = Math.exp(a - m);
    var ec = Math.exp(c - m);
    return b * (m + Math.log(ea + ec));
}
function calculateCurrentPrice(amm, action, side, shares) {
    // Calculate price for buying/selling shares
    var currentQYes = amm.qYes.toNumber() / 1e6;
    var currentQNo = amm.qNo.toNumber() / 1e6;
    var baseCost = calculateLmsrCost(amm, currentQYes, currentQNo);
    var targetCost;
    if (action === 1) { // BUY
        if (side === 1) { // YES
            targetCost = calculateLmsrCost(amm, currentQYes + shares, currentQNo - shares);
        }
        else { // NO
            targetCost = calculateLmsrCost(amm, currentQYes, currentQNo + shares);
        }
    }
    else { // SELL
        if (side === 1) { // YES
            targetCost = calculateLmsrCost(amm, currentQYes - shares, currentQNo + shares);
        }
        else { // NO
            targetCost = calculateLmsrCost(amm, currentQYes, currentQNo - shares);
        }
    }
    var netCost = Math.abs(targetCost - baseCost);
    // Apply fees
    var feeBps = amm.feeBps;
    var grossCost = action === 1
        ? netCost / (1 - feeBps / 10000)
        : netCost * (1 - feeBps / 10000);
    // Average price per share
    var avgPrice = (grossCost / shares) * 1e6; // Convert to e6 scale
    return Math.floor(avgPrice);
}
/* ==================== ORDER CHECKING ==================== */
function fetchPendingOrders() {
    return __awaiter(this, void 0, void 0, function () {
        var response, err_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, axios_1.default.get("".concat(ORDER_BOOK_API, "/api/orders/pending"), {
                            params: { limit: 100 }
                        })];
                case 1:
                    response = _a.sent();
                    return [2 /*return*/, response.data.orders];
                case 2:
                    err_1 = _a.sent();
                    console.error('❌ Error fetching pending orders:', err_1.message);
                    return [2 /*return*/, []];
                case 3: return [2 /*return*/];
            }
        });
    });
}
function checkIfExecutable(connection, amm, order) {
    return __awaiter(this, void 0, void 0, function () {
        var now, currentPrice;
        return __generator(this, function (_a) {
            try {
                // Check market is open
                if (amm.status !== 1) {
                    return [2 /*return*/, false];
                }
                now = Math.floor(Date.now() / 1000);
                if (order.expiry_ts <= now) {
                    return [2 /*return*/, false];
                }
                currentPrice = calculateCurrentPrice(amm, order.action, order.side, 1);
                // Check price condition
                if (order.action === 1) { // BUY
                    return [2 /*return*/, currentPrice <= order.limit_price_e6];
                }
                else { // SELL
                    return [2 /*return*/, currentPrice >= order.limit_price_e6];
                }
            }
            catch (err) {
                console.error("\u274C Error checking executability:", err.message);
                return [2 /*return*/, false];
            }
            return [2 /*return*/];
        });
    });
}
/* ==================== ORDER EXECUTION ==================== */
function executeOrder(connection, keeper, order, signature, orderId) {
    return __awaiter(this, void 0, void 0, function () {
        var ammPda, userPubkey, positionPda, vaultPda, limitOrderStruct, signatureBytes, signatureArray;
        return __generator(this, function (_a) {
            try {
                ammPda = getAmmPda();
                userPubkey = new web3_js_1.PublicKey(order.user);
                positionPda = getPositionPda(ammPda, userPubkey);
                vaultPda = getVaultPda(ammPda);
                console.log("\n\uD83D\uDD27 Building transaction for order ".concat(orderId, "..."));
                console.log("   User: ".concat(order.user));
                console.log("   Action: ".concat(order.action === 1 ? 'BUY' : 'SELL', " ").concat(order.side === 1 ? 'YES' : 'NO'));
                console.log("   Shares: ".concat(order.shares_e6 / 1e6));
                console.log("   Limit Price: $".concat((order.limit_price_e6 / 1e6).toFixed(6)));
                limitOrderStruct = {
                    market: new web3_js_1.PublicKey(order.market),
                    user: userPubkey,
                    action: order.action,
                    side: order.side,
                    sharesE6: new anchor.BN(order.shares_e6),
                    limitPriceE6: new anchor.BN(order.limit_price_e6),
                    maxCostE6: new anchor.BN(order.max_cost_e6),
                    minProceedsE6: new anchor.BN(order.min_proceeds_e6),
                    expiryTs: new anchor.BN(order.expiry_ts),
                    nonce: new anchor.BN(order.nonce),
                    keeperFeeBps: order.keeper_fee_bps,
                    minFillBps: order.min_fill_bps,
                };
                signatureBytes = Buffer.from(signature, 'hex');
                signatureArray = Array.from(signatureBytes);
                // Create instruction data manually (simplified - actual implementation needs proper IDL)
                // For now, we'll log that we would execute
                console.log("\u26A0\uFE0F  Skipping actual execution (on-chain instruction not yet implemented in keeper)");
                console.log("   Would call: execute_limit_order with:");
                console.log("     - AMM: ".concat(ammPda.toString()));
                console.log("     - Position: ".concat(positionPda.toString()));
                console.log("     - Vault: ".concat(vaultPda.toString()));
                console.log("     - Keeper: ".concat(keeper.publicKey.toString()));
                // TODO: Actually build and send transaction using Anchor IDL
                // const tx = await program.methods
                //   .executeLimitOrder(limitOrderStruct, signatureArray)
                //   .accounts({
                //     amm: ammPda,
                //     position: positionPda,
                //     vaultSol: vaultPda,
                //     user: userPubkey,
                //     keeper: keeper.publicKey,
                //     systemProgram: SystemProgram.programId,
                //   })
                //   .rpc();
                // For now, return a fake transaction signature for testing
                return [2 /*return*/, null]; // Would return tx signature
            }
            catch (err) {
                console.error("\u274C Error executing order ".concat(orderId, ":"), err.message);
                if (err.logs) {
                    console.error('Transaction logs:', err.logs);
                }
                return [2 /*return*/, null];
            }
            return [2 /*return*/];
        });
    });
}
function markOrderFilled(orderId, txSignature, sharesFilled, executionPrice, keeperPubkey) {
    return __awaiter(this, void 0, void 0, function () {
        var err_2;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, axios_1.default.post("".concat(ORDER_BOOK_API, "/api/orders/").concat(orderId, "/fill"), {
                            tx_signature: txSignature,
                            shares_filled: sharesFilled,
                            execution_price: executionPrice,
                            keeper_pubkey: keeperPubkey,
                        })];
                case 1:
                    _a.sent();
                    console.log("\u2705 Order ".concat(orderId, " marked as filled in database"));
                    return [3 /*break*/, 3];
                case 2:
                    err_2 = _a.sent();
                    console.error("\u274C Error marking order ".concat(orderId, " as filled:"), err_2.message);
                    return [3 /*break*/, 3];
                case 3: return [2 /*return*/];
            }
        });
    });
}
/* ==================== MAIN LOOP ==================== */
function keeperLoop() {
    return __awaiter(this, void 0, void 0, function () {
        var keeper, connection, ammPda, iteration, timestamp, orders, ammAccountInfo, amm, _i, orders_1, orderData, order, signature, order_id, executable, tx, err_3;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    keeper = loadKeeper(KEEPER_WALLET);
                    connection = new web3_js_1.Connection(RPC, 'confirmed');
                    ammPda = getAmmPda();
                    console.log('🤖 Keeper Bot Started');
                    console.log('━'.repeat(60));
                    console.log("Keeper:         ".concat(keeper.publicKey.toString()));
                    console.log("RPC:            ".concat(RPC));
                    console.log("Order Book API: ".concat(ORDER_BOOK_API));
                    console.log("AMM:            ".concat(ammPda.toString()));
                    console.log("Check Interval: ".concat(CHECK_INTERVAL, "ms"));
                    console.log('━'.repeat(60));
                    iteration = 0;
                    _a.label = 1;
                case 1:
                    if (!true) return [3 /*break*/, 20];
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, 17, , 18]);
                    iteration++;
                    timestamp = new Date().toISOString();
                    return [4 /*yield*/, fetchPendingOrders()];
                case 3:
                    orders = _a.sent();
                    if (!(orders.length === 0)) return [3 /*break*/, 4];
                    if (iteration % 10 === 0) {
                        console.log("[".concat(timestamp, "] \uD83D\uDCA4 No pending orders (checked ").concat(iteration, " times)"));
                    }
                    return [3 /*break*/, 16];
                case 4:
                    console.log("\n[".concat(timestamp, "] \uD83D\uDCCB Found ").concat(orders.length, " pending order(s)"));
                    return [4 /*yield*/, connection.getAccountInfo(ammPda)];
                case 5:
                    ammAccountInfo = _a.sent();
                    if (!!ammAccountInfo) return [3 /*break*/, 7];
                    console.error('❌ AMM account not found');
                    return [4 /*yield*/, sleep(CHECK_INTERVAL)];
                case 6:
                    _a.sent();
                    return [3 /*break*/, 1];
                case 7:
                    amm = {
                        bump: 0,
                        decimals: 6,
                        b: new anchor.BN(500000000), // b = 500
                        feeBps: 25,
                        qYes: new anchor.BN(0),
                        qNo: new anchor.BN(0),
                        fees: new anchor.BN(0),
                        vaultE6: new anchor.BN(0),
                        status: 1, // Open
                        winner: 0,
                        wTotalE6: new anchor.BN(0),
                        ppsE6: new anchor.BN(0),
                        feeDest: keeper.publicKey,
                        vaultSolBump: 0,
                        startPriceE6: new anchor.BN(0),
                        startTs: new anchor.BN(0),
                        settlePriceE6: new anchor.BN(0),
                        settleTs: new anchor.BN(0),
                        marketEndSlot: new anchor.BN(0),
                        marketEndTime: new anchor.BN(0),
                    };
                    console.log("\uD83D\uDCCA AMM State: qYes=".concat(amm.qYes.toNumber() / 1e6, ", qNo=").concat(amm.qNo.toNumber() / 1e6, ", status=").concat(amm.status));
                    _i = 0, orders_1 = orders;
                    _a.label = 8;
                case 8:
                    if (!(_i < orders_1.length)) return [3 /*break*/, 16];
                    orderData = orders_1[_i];
                    order = orderData.order, signature = orderData.signature, order_id = orderData.order_id;
                    console.log("\n\uD83D\uDD0D Checking order ".concat(order_id, ":"));
                    console.log("   ".concat(order.action === 1 ? 'BUY' : 'SELL', " ").concat(order.shares_e6 / 1e6, " ").concat(order.side === 1 ? 'YES' : 'NO', " @ limit $").concat((order.limit_price_e6 / 1e6).toFixed(6)));
                    return [4 /*yield*/, checkIfExecutable(connection, amm, order)];
                case 9:
                    executable = _a.sent();
                    if (!executable) return [3 /*break*/, 14];
                    console.log("\u2705 Order ".concat(order_id, " is executable!"));
                    return [4 /*yield*/, executeOrder(connection, keeper, order, signature, order_id)];
                case 10:
                    tx = _a.sent();
                    if (!tx) return [3 /*break*/, 12];
                    console.log("\u2705 Order ".concat(order_id, " executed: ").concat(tx));
                    // Mark as filled in database
                    return [4 /*yield*/, markOrderFilled(order_id, tx, order.shares_e6, order.limit_price_e6, keeper.publicKey.toString())];
                case 11:
                    // Mark as filled in database
                    _a.sent();
                    return [3 /*break*/, 13];
                case 12:
                    console.log("\u26A0\uFE0F  Order ".concat(order_id, " execution skipped (implementation pending)"));
                    _a.label = 13;
                case 13: return [3 /*break*/, 15];
                case 14:
                    console.log("\u274C Order ".concat(order_id, " not executable yet (price condition not met or expired)"));
                    _a.label = 15;
                case 15:
                    _i++;
                    return [3 /*break*/, 8];
                case 16: return [3 /*break*/, 18];
                case 17:
                    err_3 = _a.sent();
                    console.error('❌ Error in keeper loop:', err_3.message);
                    return [3 /*break*/, 18];
                case 18: return [4 /*yield*/, sleep(CHECK_INTERVAL)];
                case 19:
                    _a.sent();
                    return [3 /*break*/, 1];
                case 20: return [2 /*return*/];
            }
        });
    });
}
function sleep(ms) {
    return new Promise(function (resolve) { return setTimeout(resolve, ms); });
}
/* ==================== START ==================== */
keeperLoop().catch(function (err) {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
