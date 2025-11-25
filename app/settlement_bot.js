#!/usr/bin/env node
// app/settlement_bot.js — Automated settlement bot for 30-minute market cycles
// Cycles: 5 mins pre-market -> snapshot -> 25 mins active -> settle -> restart
// Markets start at :00 and :30 minutes past the hour (e.g., 01:00, 01:30, 02:00, etc.)

const fs = require("fs");
const crypto = require("crypto");
const http = require("http");
const {
  Connection, PublicKey, Keypair, SystemProgram,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
  ComputeBudgetProgram, SYSVAR_RENT_PUBKEY,
} = require("@solana/web3.js");

/* ---------------- CONFIG ---------------- */
const RPC = process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899";
const WALLET = process.env.ANCHOR_WALLET || "./operator.json"; // Default to operator.json (fee_dest)
const DEFAULT_ORACLE_STATE = "4KYeNyv1B9YjjQkfJk2C6Uqo71vKzFZriRe5NXg6GyCq"; // Default BTC oracle
const ORACLE_STATE = process.env.ORACLE_STATE
  ? new PublicKey(process.env.ORACLE_STATE)
  : new PublicKey(DEFAULT_ORACLE_STATE);

// === PROGRAM IDs / SEEDS ===
const PID = new PublicKey("EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF");
const AMM_SEED = Buffer.from("amm_btc_v6");  // v6: added market_end_time for time-based trading lockout
const VAULT_SOL_SEED = Buffer.from("vault_sol");
const USER_VAULT_SEED = Buffer.from("user_vault");
const POS_SEED = Buffer.from("pos");

// === TIMING CONSTANTS ===
const PREMARKET_DURATION_MS = 5 * 60 * 1000;  // 5 minutes pre-market (no snapshot yet)
const ACTIVE_DURATION_MS = 25 * 60 * 1000;    // 25 minutes active (after snapshot)
const CYCLE_DURATION_MS = 30 * 60 * 1000;     // 30 minutes total (aligns to :00 and :30)

// === LAMPORTS CONVERSION ===
const LAMPORTS_PER_E6 = 100;                   // Must match Rust program constant
const E6_PER_XNT = 10_000_000;                 // 1 XNT = 10M e6 units
const LAMPORTS_PER_XNT = E6_PER_XNT * LAMPORTS_PER_E6; // 1 XNT = 1 billion lamports

// === STATUS FILE ===
const STATUS_FILE = "./market_status.json";

// === LOG FILE ===
const LOG_FILE = "./settlement_bot.log";

/* ---------------- Color helpers ---------------- */
const WANT_COLOR = !process.env.NO_COLOR && process.stdout.isTTY;
const C = WANT_COLOR ? {
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  b: (s) => `\x1b[34m${s}\x1b[0m`,
  c: (s) => `\x1b[36m${s}\x1b[0m`,
  m: (s) => `\x1b[35m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
} : { r: s => s, g: s => s, y: s => s, b: s => s, c: s => s, m: s => s, bold: s => s };

/* ---------------- Log File Helper ---------------- */
function writeToLogFile(level, ...args) {
  try {
    // Strip ANSI color codes for clean log file
    const stripAnsi = (str) => str.toString().replace(/\x1b\[[0-9;]*m/g, '');
    const timestamp = new Date().toISOString();
    const message = args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg) : stripAnsi(String(arg))
    ).join(' ');
    const logLine = `[${timestamp}] [${level}] ${message}\n`;
    fs.appendFileSync(LOG_FILE, logLine);
  } catch (err) {
    // Silently fail if logging fails - don't break the bot
  }
}

/* ---------------- Helpers ---------------- */
function log(...args) {
  console.log(C.c(`[${new Date().toISOString()}]`), ...args);
  writeToLogFile('INFO', ...args);
}

function logError(...args) {
  console.error(C.r(`[ERROR]`), ...args);
  writeToLogFile('ERROR', ...args);
}

function logSuccess(...args) {
  console.log(C.g(`[SUCCESS]`), ...args);
  writeToLogFile('SUCCESS', ...args);
}

function logInfo(...args) {
  console.log(C.b(`[INFO]`), ...args);
  writeToLogFile('INFO', ...args);
}

/* ---------------- Broadcast Redemption to Trade Feed ---------------- */
function broadcastRedemption(userAddress, amountXnt, userSide, snapshotPrice = null, settlePrice = null) {
  try {
    const TRADES_FILE = "./web/public/recent_trades.json";

    // Create redemption event
    const redemption = {
      side: userSide, // The side the user held (YES/NO)
      action: 'REDEEM',
      amount: amountXnt.toFixed(4),
      shares: '0.00',
      avgPrice: '0.0000',
      signature: 'auto-redeem',
      timestamp: Date.now(),
      user: userAddress
    };

    // Read existing trades
    let trades = [];
    if (fs.existsSync(TRADES_FILE)) {
      const data = fs.readFileSync(TRADES_FILE, 'utf8');
      trades = JSON.parse(data);
    }

    // Add redemption event
    trades.push(redemption);

    // Keep only last 100
    if (trades.length > 100) {
      trades = trades.slice(-100);
    }

    // Write back
    fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));

    // Also post to settlement history API with prices
    postSettlementHistory(userAddress, amountXnt, userSide, snapshotPrice, settlePrice);

  } catch (err) {
    logError("Failed to broadcast redemption:", err.message);
  }
}

/* ---------------- Post Settlement to History API ---------------- */
function postSettlementHistory(userAddress, amountXnt, userSide, snapshotPrice = null, settlePrice = null) {
  try {
    const userPrefix = userAddress.substring(0, 6);
    const result = amountXnt > 0 ? 'WIN' : 'LOSE';

    const postData = JSON.stringify({
      userPrefix: userPrefix,
      result: result,
      amount: amountXnt,
      side: userSide, // The side the user held (YES/NO)
      snapshotPrice: snapshotPrice,
      settlePrice: settlePrice
    });

    const options = {
      hostname: 'localhost',
      port: 3434,
      path: '/api/settlement-history',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = http.request(options, (res) => {
      if (res.statusCode === 200) {
        logInfo(`  → Settlement history saved for ${userPrefix}... (Snapshot: $${snapshotPrice?.toFixed(2) || '?'}, Settle: $${settlePrice?.toFixed(2) || '?'})`);
      }
    });

    req.on('error', (err) => {
      // Silently fail if web server is not running
    });

    req.write(postData);
    req.end();

  } catch (err) {
    // Silently fail - settlement history is optional
  }
}

/* ---------------- Cancel All Open Orders ---------------- */
async function cancelAllOpenOrders() {
  return new Promise((resolve) => {
    try {
      const options = {
        hostname: 'localhost',
        port: 3436,
        path: '/api/orders/cancel-all',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': 0
        }
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (result.cancelled_count > 0) {
              logInfo(`  → Cancelled ${result.cancelled_count} open limit orders`);
            }
          } catch (e) {}
          resolve();
        });
      });

      req.on('error', (err) => {
        // Silently fail if orderbook API is not running
        resolve();
      });

      req.end();

      // Timeout after 3 seconds
      setTimeout(resolve, 3000);

    } catch (err) {
      resolve();
    }
  });
}

/* ---------------- Reset Volume for New Market Cycle ---------------- */
async function resetVolume() {
  try {
    const options = {
      hostname: 'localhost',
      port: 3434,
      path: '/api/volume/reset',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '0'
      }
    };

    return new Promise((resolve) => {
      const req = http.request(options, (res) => {
        if (res.statusCode === 200) {
          logInfo('📊 Session volume reset for new market cycle (in-memory only)');
          resolve(true);
        } else {
          resolve(false);
        }
      });

      req.on('error', () => {
        resolve(false); // Silently fail if web server is not running
      });

      req.end();
    });
  } catch (err) {
    return false;
  }
}

/* ---------------- Reset Cost Basis for New Market Cycle ---------------- */
// resetCostBasis removed - cost basis automatically scoped by cycle_id in trading_history

/* ---------------- Retry Helper for Blockhash Errors ---------------- */
async function sendTransactionWithRetry(conn, tx, signers, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Get fresh blockhash for each attempt
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;

      return await sendAndConfirmTransaction(conn, tx, signers, {
        skipPreflight: false,
        commitment: 'confirmed'
      });
    } catch (err) {
      const isBlockhashError = err.message && (
        err.message.includes('block height exceeded') ||
        err.message.includes('Blockhash not found') ||
        err.message.includes('has expired')
      );

      if (isBlockhashError && attempt < maxRetries) {
        logError(`Blockhash expired (attempt ${attempt}/${maxRetries}), retrying with fresh blockhash...`);
        await new Promise(r => setTimeout(r, 1000)); // Wait 1s before retry
        continue;
      }

      // Not a blockhash error or out of retries
      throw err;
    }
  }
}

/* ---------------- SHA256 discriminator ---------------- */
function sha256(data) {
  return crypto.createHash("sha256").update(data).digest();
}

function discriminator(ixName) {
  const preimage = `global:${ixName}`;
  return sha256(Buffer.from(preimage, "utf8")).slice(0, 8);
}

/* ---------------- Status Management ---------------- */
function writeStatus(status) {
  // Log detailed status update with next cycle time if available
  if (status.nextCycleStartTime) {
    const nextCycleDate = new Date(status.nextCycleStartTime);
    const timeUntilNext = status.nextCycleStartTime - Date.now();
    logInfo(C.m(`📝 Status Update: ${status.state} | Next cycle: ${formatTime(nextCycleDate)} (${formatCountdown(timeUntilNext)} away)`));
  }
  fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
}

function readStatus() {
  try {
    if (fs.existsSync(STATUS_FILE)) {
      return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
    }
  } catch (err) {
    logError("Failed to read status file:", err.message);
  }
  return null;
}

/* ---------------- Market Operations ---------------- */
async function closeMarket(conn, kp, ammPda) {
  log("Closing existing market...");
  const closeIx = new TransactionInstruction({
    programId: PID,
    keys: [
      { pubkey: ammPda, isSigner: false, isWritable: true },
      { pubkey: kp.publicKey, isSigner: true, isWritable: true },
    ],
    data: discriminator("close_amm"),
  });

  const tx = new Transaction().add(closeIx);
  const sig = await sendTransactionWithRetry(conn, tx, [kp]);
  logSuccess(`Market closed: ${sig}`);
}

async function initMarket(conn, kp, ammPda, vaultPda) {
  log(C.bold("Initializing new market..."));
  const b = 5_000_000_000; // 5,000.00 XNT liquidity (5B in e6 scale, where 1 XNT = 10M e6)
  const feeBps = 25;

  // Display market parameters
  const bDisplay = (b / E6_PER_XNT).toFixed(2);
  const feePercent = (feeBps / 100).toFixed(2);
  logInfo(`  📊 Market Parameters:`);
  logInfo(`     Liquidity (b): ${bDisplay} XNT (${b.toLocaleString()} e6)`);
  logInfo(`     Fee: ${feeBps} bps (${feePercent}%)`);
  logInfo(`     AMM PDA: ${ammPda.toString()}`);
  logInfo(`     Vault PDA: ${vaultPda.toString()}`);

  const initData = Buffer.alloc(8 + 8 + 2);
  discriminator("init_amm").copy(initData, 0);
  initData.writeBigInt64LE(BigInt(b), 8);
  initData.writeUInt16LE(feeBps, 16);

  const initIx = new TransactionInstruction({
    programId: PID,
    keys: [
      { pubkey: ammPda, isSigner: false, isWritable: true },
      { pubkey: kp.publicKey, isSigner: true, isWritable: true },
      { pubkey: kp.publicKey, isSigner: false, isWritable: true }, // fee_dest
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: initData,
  });

  const tx = new Transaction().add(initIx);
  const sig = await sendTransactionWithRetry(conn, tx, [kp]);

  // Read vault balance after initialization
  const vaultBalance = await conn.getBalance(vaultPda);
  const vaultXnt = (vaultBalance / LAMPORTS_PER_XNT).toFixed(4);

  logSuccess(`Market initialized: ${sig}`);
  logInfo(`  💰 Vault balance: ${vaultXnt} XNT (${vaultBalance.toLocaleString()} lamports)`);
  logInfo(`  🔗 Explorer: https://explorer.solana.com/tx/${sig}?cluster=custom`);
}

async function snapshotStart(conn, kp, ammPda) {
  if (!ORACLE_STATE) {
    logError("ORACLE_STATE not set - cannot take snapshot");
    return false;
  }

  log("Taking oracle snapshot...");
  const snapshotIx = new TransactionInstruction({
    programId: PID,
    keys: [
      { pubkey: ammPda, isSigner: false, isWritable: true },
      { pubkey: ORACLE_STATE, isSigner: false, isWritable: false },
    ],
    data: discriminator("snapshot_start"),
  });

  const budgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });
  const tx = new Transaction().add(budgetIx, snapshotIx);
  const sig = await sendTransactionWithRetry(conn, tx, [kp]);
  logSuccess(`Snapshot taken: ${sig}`);
  return true;
}

async function setMarketEndSlot(conn, kp, ammPda, marketEndSlot, marketEndTime) {
  log(`Setting market end slot to: ${marketEndSlot}, time to: ${marketEndTime}`);

  // Create u64 buffer for market_end_slot
  const slotBuf = Buffer.alloc(8);
  slotBuf.writeBigUInt64LE(BigInt(marketEndSlot), 0);

  // Create i64 buffer for market_end_time (unix timestamp in seconds)
  const timeBuf = Buffer.alloc(8);
  timeBuf.writeBigInt64LE(BigInt(Math.floor(marketEndTime / 1000)), 0);  // Convert ms to seconds

  const setEndSlotIx = new TransactionInstruction({
    programId: PID,
    keys: [
      { pubkey: ammPda, isSigner: false, isWritable: true },
      { pubkey: kp.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([discriminator("set_market_end_slot"), slotBuf, timeBuf]),
  });

  const budgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });
  const tx = new Transaction().add(budgetIx, setEndSlotIx);
  const sig = await sendTransactionWithRetry(conn, tx, [kp]);
  logSuccess(`Market end time set to ${new Date(marketEndTime).toISOString()}: ${sig}`);
  return true;
}

async function stopMarket(conn, kp, ammPda) {
  log("Stopping market...");
  const stopIx = new TransactionInstruction({
    programId: PID,
    keys: [
      { pubkey: ammPda, isSigner: false, isWritable: true },
      { pubkey: kp.publicKey, isSigner: true, isWritable: false },
    ],
    data: discriminator("stop_market"),
  });

  const tx = new Transaction().add(stopIx);
  const sig = await sendTransactionWithRetry(conn, tx, [kp]);
  logSuccess(`Market stopped: ${sig}`);
}

async function settleMarket(conn, kp, ammPda) {
  if (!ORACLE_STATE) {
    logError("ORACLE_STATE not set - cannot settle");
    return false;
  }

  log("Settling market by oracle...");
  const settleData = Buffer.alloc(8 + 1);
  discriminator("settle_by_oracle").copy(settleData, 0);
  settleData.writeUInt8(1, 8); // ge_wins_yes = true

  const settleIx = new TransactionInstruction({
    programId: PID,
    keys: [
      { pubkey: ammPda, isSigner: false, isWritable: true },
      { pubkey: ORACLE_STATE, isSigner: false, isWritable: false },
    ],
    data: settleData,
  });

  const budgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });
  const tx = new Transaction().add(budgetIx, settleIx);
  const sig = await sendTransactionWithRetry(conn, tx, [kp]);
  logSuccess(`Market settled: ${sig}`);
  return true;
}

async function findAllPositions(conn, ammPda) {
  log("Scanning for active positions...");

  const POS_SEED = Buffer.from("pos");

  // Get all program accounts for our program that match Position size
  // Position size: discriminator(8) + owner(32) + yes_shares(8) + no_shares(8) + master_wallet(32) + vault_balance_e6(8) + vault_bump(1) + vec_len(4) + nonces(8*100) = 901 bytes
  // Note: Vec<u64> makes this dynamic, but typically allocated for 100 nonces
  const accounts = await conn.getProgramAccounts(PID, {
    filters: [
      {
        dataSize: 8 + 893, // 901 bytes total (8-byte discriminator + 893-byte Position struct with Vec<u64> for 100 nonces)
      },
    ],
  });

  const positions = [];
  for (const { pubkey, account } of accounts) {
    try {
      const data = account.data;
      if (data.length < 8 + 32 + 8 + 8) continue; // Minimum size for reading shares

      // Skip discriminator (8 bytes)
      let offset = 8;

      // Read owner pubkey (32 bytes)
      const ownerBytes = data.slice(offset, offset + 32);
      const owner = new PublicKey(ownerBytes);
      offset += 32;

      // Read shares (i64 each)
      const yesShares = Number(data.readBigInt64LE(offset)); offset += 8;
      const noShares = Number(data.readBigInt64LE(offset));

      // Verify this position belongs to the current AMM by checking PDA derivation
      const [expectedPda] = PublicKey.findProgramAddressSync(
        [POS_SEED, ammPda.toBuffer(), owner.toBuffer()],
        PID
      );

      // Only include if:
      // 1. Has shares
      // 2. PDA matches current AMM (not from old markets)
      if ((yesShares > 0 || noShares > 0) && expectedPda.equals(pubkey)) {
        positions.push({
          pubkey,
          owner,
          yesShares,
          noShares,
        });
      }
    } catch (err) {
      // Skip invalid accounts
    }
  }

  logInfo(`Found ${positions.length} positions with shares`);
  return positions;
}

async function autoRedeemAllPositions(conn, kp, ammPda, vaultPda, snapshotPrice = null, settlePrice = null) {
  log(C.bold("\n=== AUTO-REDEEMING ALL POSITIONS ==="));

  const positions = await findAllPositions(conn, ammPda);

  if (positions.length === 0) {
    logInfo("No positions to redeem");
    return;
  }

  // Read market data to get payout info
  const marketData = await readMarketData(conn, ammPda);
  const payoutPerShare = marketData ? marketData.payoutPerShare : 0;
  const winningSide = marketData ? marketData.winningSide : null;

  // Use market data prices if not provided
  if (!snapshotPrice && marketData) {
    snapshotPrice = marketData.startPrice;
  }

  logInfo(`Settlement prices: Snapshot=$${snapshotPrice?.toFixed(2) || '?'}, Settle=$${settlePrice?.toFixed(2) || '?'}`);

  let successCount = 0;
  let failCount = 0;

  for (const pos of positions) {
    try {
      const yesSharesDisplay = (pos.yesShares / E6_PER_XNT).toFixed(2);
      const noSharesDisplay = (pos.noShares / E6_PER_XNT).toFixed(2);

      // Calculate payout amount
      // Shares are in e6 scale, pps is also in e6 scale
      // Rust does: (shares_e6 * pps_e6 / 1M) to get result in e6
      // Then converts e6 to lamports and pays out
      // So for display: shares_e6 * pps_e6 / 1M / E6_PER_XNT = shares_e6 / E6_PER_XNT * pps_e6 / 1M
      let payoutAmount = 0;
      if (winningSide === 'YES' && pos.yesShares > 0) {
        // Convert shares from e6 to actual shares, then multiply by pps
        payoutAmount = (pos.yesShares / E6_PER_XNT) * payoutPerShare;
      } else if (winningSide === 'NO' && pos.noShares > 0) {
        payoutAmount = (pos.noShares / E6_PER_XNT) * payoutPerShare;
      }

      log(`Redeeming for ${pos.owner.toString().slice(0, 8)}... (UP: ${yesSharesDisplay}, DOWN: ${noSharesDisplay})`);
      log(`  Expected payout: ${payoutAmount.toFixed(4)} XNT (winningSide: ${winningSide}, pps: ${payoutPerShare.toFixed(6)})`);

      // Derive user_vault PDA for this position
      const [userVaultPda] = PublicKey.findProgramAddressSync(
        [USER_VAULT_SEED, pos.pubkey.toBuffer()],
        PID
      );

      log(`  Position PDA: ${pos.pubkey.toString()}`);
      log(`  User (session wallet): ${pos.owner.toString()}`);
      log(`  User Vault PDA: ${userVaultPda.toString()}`);

      // Get balances before redeem
      const sessionBalanceBefore = await conn.getBalance(pos.owner);
      const vaultBalanceBefore = await conn.getBalance(userVaultPda);

      log(`  Balances BEFORE: session=${(sessionBalanceBefore/LAMPORTS_PER_XNT).toFixed(4)} XNT, vault=${(vaultBalanceBefore/LAMPORTS_PER_XNT).toFixed(4)} XNT`);

      // Use admin_redeem instruction (NOW WITH user_vault PDA)
      const redeemIx = new TransactionInstruction({
        programId: PID,
        keys: [
          { pubkey: ammPda, isSigner: false, isWritable: true },
          { pubkey: kp.publicKey, isSigner: true, isWritable: true }, // Admin (fee_dest)
          { pubkey: pos.owner, isSigner: false, isWritable: true }, // User (session wallet)
          { pubkey: pos.pubkey, isSigner: false, isWritable: true }, // Position account
          { pubkey: kp.publicKey, isSigner: false, isWritable: true }, // fee_dest (same as admin)
          { pubkey: vaultPda, isSigner: false, isWritable: true }, // vault_sol
          { pubkey: userVaultPda, isSigner: false, isWritable: true }, // user_vault (NEW!)
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: discriminator("admin_redeem"),
      });

      const budgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 });
      const tx = new Transaction().add(budgetIx, redeemIx);
      const sig = await sendTransactionWithRetry(conn, tx, [kp]);

      // Get balances after redeem
      const sessionBalanceAfter = await conn.getBalance(pos.owner);
      const vaultBalanceAfter = await conn.getBalance(userVaultPda);

      const sessionDelta = (sessionBalanceAfter - sessionBalanceBefore) / LAMPORTS_PER_XNT;
      const vaultDelta = (vaultBalanceAfter - vaultBalanceBefore) / LAMPORTS_PER_XNT;

      log(`  Balances AFTER: session=${(sessionBalanceAfter/LAMPORTS_PER_XNT).toFixed(4)} XNT, vault=${(vaultBalanceAfter/LAMPORTS_PER_XNT).toFixed(4)} XNT`);
      logSuccess(`  ✓ Redeemed: ${sig.slice(0, 16)}...`);
      logSuccess(`    → Session wallet change: ${sessionDelta >= 0 ? '+' : ''}${sessionDelta.toFixed(4)} XNT`);
      logSuccess(`    → User vault change: ${vaultDelta >= 0 ? '+' : ''}${vaultDelta.toFixed(4)} XNT (THIS SHOULD BE THE PAYOUT!)`);

      // Use vault delta as the actual payout (not session wallet delta)
      const actualPayout = vaultDelta;

      // Determine user's actual side based on their position
      let userSide;
      if (pos.yesShares > 0 && pos.noShares === 0) {
        userSide = 'YES';
      } else if (pos.noShares > 0 && pos.yesShares === 0) {
        userSide = 'NO';
      } else if (pos.yesShares > 0 && pos.noShares > 0) {
        // User has both sides - use whichever is larger
        userSide = pos.yesShares >= pos.noShares ? 'YES' : 'NO';
      } else {
        // No shares - shouldn't happen but default to YES
        userSide = 'YES';
      }

      // Broadcast redemption event with user's actual side and prices
      broadcastRedemption(pos.owner.toString(), actualPayout, userSide, snapshotPrice, settlePrice);

      successCount++;

      // Small delay to avoid rate limits
      await new Promise(r => setTimeout(r, 500));

    } catch (err) {
      logError(`  ✗ Failed for ${pos.owner.toString().slice(0, 8)}...: ${err.message}`);
      failCount++;
    }
  }

  log(C.bold(`\n=== AUTO-REDEEM COMPLETE ===`));
  logSuccess(`${successCount} positions redeemed`);
  if (failCount > 0) {
    logError(`${failCount} positions failed`);
  }
}

/* ---------------- Oracle & Market Data Functions ---------------- */
async function readOraclePrice(conn) {
  if (!ORACLE_STATE) return null;
  try {
    const accountInfo = await conn.getAccountInfo(ORACLE_STATE);
    if (!accountInfo) return null;

    const d = accountInfo.data;
    if (d.length < 8 + 32 + 48*3) return null;

    let o = 8; // Skip discriminator
    o += 32; // Skip update_authority

    // Read triplet (3 values with timestamps)
    const param1 = Number(d.readBigInt64LE(o)); o += 8;
    o += 8; // Skip timestamp1
    const param2 = Number(d.readBigInt64LE(o)); o += 8;
    o += 8; // Skip timestamp2
    const param3 = Number(d.readBigInt64LE(o)); o += 8;

    // Use median of the three
    const sorted = [param1, param2, param3].sort((a, b) => a - b);
    const medianE6 = sorted[1];
    const btcPrice = medianE6 / 1_000_000;

    return btcPrice;
  } catch (err) {
    logError("Failed to read oracle price:", err.message);
    return null;
  }
}

async function readMarketData(conn, ammPda) {
  try {
    const accountInfo = await conn.getAccountInfo(ammPda);
    if (!accountInfo) return null;

    const d = accountInfo.data;
    if (d.length < 8 + 62) return null;

    const p = d.subarray(8);
    let o = 0;

    o += 1; // bump
    o += 1; // decimals
    const bScaled = Number(d.readBigInt64LE(8 + o)); o += 8;
    o += 2; // fee_bps
    const qY = Number(d.readBigInt64LE(8 + o)); o += 8;
    const qN = Number(d.readBigInt64LE(8 + o)); o += 8;
    o += 8; // fees
    o += 8; // vault
    const status = d.readUInt8(8 + o); o += 1;
    const winner = d.readUInt8(8 + o); o += 1;
    o += 8; // wager_total
    const payoutPerShareE6 = Number(d.readBigInt64LE(8 + o)); o += 8;
    o += 32; // fee_dest
    o += 1; // vault_sol_bump
    const startPriceE6 = Number(d.readBigInt64LE(8 + o));

    // Calculate probabilities for display
    const b = bScaled;
    const a = Math.exp(qY / b);
    const c = Math.exp(qN / b);
    const yesProb = a / (a + c);

    // Determine winning side from the actual winner field (0=unknown, 1=YES, 2=NO)
    let winningSide = 'UNKNOWN';
    if (winner === 1) {
      winningSide = 'YES';
    } else if (winner === 2) {
      winningSide = 'NO';
    }

    const startPrice = startPriceE6 > 0 ? startPriceE6 / 1_000_000 : null;
    const payoutPerShare = payoutPerShareE6 / 1_000_000;

    return {
      status,
      winner,
      winningSide,
      startPrice,
      yesProb,
      noProb: 1 - yesProb,
      payoutPerShare
    };
  } catch (err) {
    logError("Failed to read market data:", err.message);
    return null;
  }
}

/* ---------------- Timing Functions ---------------- */
function getNextStartTime() {
  const now = new Date();

  logInfo(C.bold("📅 Calculating next market cycle start time:"));
  logInfo(`  Current time: ${formatTime(now)}`);

  // Round to next 30-minute boundary (:00 or :30)
  const nextStart = new Date(now);
  const currentMinute = nextStart.getMinutes();

  if (currentMinute < 30) {
    // Next start is at :30 of current hour
    nextStart.setMinutes(30, 0, 0);
  } else {
    // Next start is at :00 of next hour
    nextStart.setHours(nextStart.getHours() + 1, 0, 0, 0);
  }

  // If we're already past the calculated time (race condition), use it anyway
  // This can happen if currentMinute is exactly 30 or 0
  if (nextStart.getTime() <= now.getTime()) {
    // Add 30 minutes to get the next boundary
    nextStart.setTime(nextStart.getTime() + 30 * 60 * 1000);
  }

  const waitTime = nextStart.getTime() - now.getTime();
  logInfo(C.g(`  ✓ Next market cycle starts at: ${formatTime(nextStart)} (in ${formatCountdown(waitTime)})`));

  return nextStart;
}

function formatTime(date) {
  return date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatCountdown(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

/* ---------------- Main Cycle Loop ---------------- */
async function runCycle(conn, kp, ammPda, vaultPda) {
  // Get current 30-minute window (either :00-:30 or :30-:00)
  // This ensures markets stay aligned to clock boundaries
  const now = new Date();
  const currentMinute = now.getMinutes();

  // Calculate the start of the current 30-minute window
  const cycleStart = new Date(now);
  if (currentMinute < 30) {
    cycleStart.setMinutes(0, 0, 0);
  } else {
    cycleStart.setMinutes(30, 0, 0);
  }

  const cycleStartTime = cycleStart.getTime();
  const snapshotTime = cycleStartTime + PREMARKET_DURATION_MS;
  const marketEndTime = snapshotTime + ACTIVE_DURATION_MS;
  const nextCycleStartTime = cycleStartTime + CYCLE_DURATION_MS;

  log(C.bold("\n=== STARTING NEW MARKET CYCLE ==="));
  logInfo(C.bold("⏱️  Cycle Timing Breakdown:"));
  logInfo(`  Cycle start time: ${formatTime(new Date(cycleStartTime))} (${cycleStartTime}ms)`);
  logInfo(`  + ${PREMARKET_DURATION_MS / 1000}s pre-market = Snapshot at: ${formatTime(new Date(snapshotTime))}`);
  logInfo(`  + ${ACTIVE_DURATION_MS / 1000}s active trading = Market close at: ${formatTime(new Date(marketEndTime))}`);
  logInfo(C.y(`  = ${CYCLE_DURATION_MS / 1000}s total cycle = Next cycle at: ${formatTime(new Date(nextCycleStartTime))}`));
  log(C.bold(`\n📊 Current Cycle: ${formatTime(new Date(cycleStartTime))} → ${formatTime(new Date(marketEndTime))}`));
  log(C.bold(C.y(`🔄 Next Cycle Scheduled: ${formatTime(new Date(nextCycleStartTime))} (in ${formatCountdown(nextCycleStartTime - Date.now())})`)));

  try {
    // Step 1: Wipe positions from previous cycle, close market, then IMMEDIATELY open new one
    const ammInfo = await conn.getAccountInfo(ammPda);
    if (ammInfo) {
      log("Wiping positions from previous cycle...");
      await wipeAllPositions(conn, kp, ammPda);
      await new Promise(r => setTimeout(r, 1000));

      await closeMarket(conn, kp, ammPda);
      await new Promise(r => setTimeout(r, 2000));
    }

    // Step 2: Initialize new market IMMEDIATELY (no waiting period)
    await initMarket(conn, kp, ammPda, vaultPda);
    await new Promise(r => setTimeout(r, 1500));

    // Reset volume for new market cycle
    // Cost basis no longer needs reset - automatically scoped by cycle_id in trading_history
    await resetVolume();

    logSuccess(C.bold("✓ PRE-MARKET BETTING NOW OPEN!"));
    logInfo(`Pre-market phase: ${formatCountdown(PREMARKET_DURATION_MS)} until snapshot`);

    // Step 3: Pre-market phase - trading allowed WITHOUT snapshot
    // This combines old WAITING + PREMARKET states into one continuous pre-market
    writeStatus({
      state: "PREMARKET",
      cycleStartTime,
      snapshotTime,
      marketEndTime,
      nextCycleStartTime,
      lastUpdate: Date.now()
    });

    const premarketWaitStart = Date.now();
    while (Date.now() < snapshotTime) {
      const remaining = snapshotTime - Date.now();
      if (remaining > 0) {
        logInfo(`Pre-market open - ${formatCountdown(remaining)} until snapshot`);
        writeStatus({
          state: "PREMARKET",
          cycleStartTime,
          snapshotTime,
          marketEndTime,
          nextCycleStartTime,
          timeRemaining: remaining,
          lastUpdate: Date.now()
        });
        await new Promise(r => setTimeout(r, Math.min(10000, remaining)));
      }
    }

    // Step 4: Take snapshot (market stays open)
    log(C.bold("\n=== TAKING SNAPSHOT ==="));
    const snapshotSuccess = await snapshotStart(conn, kp, ammPda);
    if (!snapshotSuccess) {
      logError("Failed to take snapshot - aborting cycle");
      return;
    }

    logSuccess(C.bold("✓ Snapshot taken! Market continues ACTIVE for trading!"));

    // Read back the start price from AMM account
    const ammData = await readMarketData(conn, ammPda);
    if (ammData && ammData.startPrice > 0) {
      logInfo(C.bold(C.y(`📸 Start Price: $${ammData.startPrice.toFixed(2)} (BTC price locked for settlement)`)));
    }

    // Step 4.5: Set market end slot for trading lockout
    // Calculate slot when market will end based on ACTIVE_DURATION_MS
    // Solana slots are ~300ms each on average (3.33 slots per second)
    const currentSlot = await conn.getSlot();
    const remainingMs = marketEndTime - Date.now();
    const remainingSlots = Math.floor(remainingMs / 300); // ~300ms per slot
    const marketEndSlot = currentSlot + remainingSlots;

    log(C.bold("\n=== SETTING MARKET END SLOT ==="));
    logInfo(`  Current slot: ${currentSlot}`);
    logInfo(`  Time until market close: ${formatCountdown(remainingMs)}`);
    logInfo(`  Estimated slots until close: ${remainingSlots}`);
    logInfo(`  Market end slot: ${marketEndSlot}`);
    logInfo(`  Trading lockout starts at slot: ${marketEndSlot - 90} (90 slots ≈45s before close)`);

    await setMarketEndSlot(conn, kp, ammPda, marketEndSlot, marketEndTime);
    logSuccess(C.bold("✓ Market end time configured - trading lockout will activate 30 seconds before close!"));

    // Update status: ACTIVE (post-snapshot)
    writeStatus({
      state: "ACTIVE",
      cycleStartTime,
      snapshotTime,
      marketEndTime,
      nextCycleStartTime,
      lastUpdate: Date.now()
    });

    // Step 5: Continue active trading period, updating status regularly
    const activeWaitStart = Date.now();
    log(`Market will close at exactly: ${formatTime(new Date(marketEndTime))}`);

    while (true) {
      const now = Date.now();
      const remaining = marketEndTime - now;

      if (remaining <= 0) {
        break;
      }

      // Only log status if more than 5 seconds remaining
      if (remaining > 5000) {
        logInfo(`Market active (post-snapshot) - ${formatCountdown(remaining)} remaining`);
        writeStatus({
          state: "ACTIVE",
          cycleStartTime,
          snapshotTime,
          marketEndTime,
          nextCycleStartTime,
          timeRemaining: remaining,
          lastUpdate: now
        });
      }

      // Check more frequently as we approach close time
      let waitTime;
      if (remaining > 60000) {
        waitTime = 10000; // 10s intervals when > 1 min remaining
      } else if (remaining > 10000) {
        waitTime = 1000; // 1s intervals when > 10s remaining
      } else if (remaining > 1000) {
        waitTime = 100; // 100ms intervals when > 1s remaining
      } else {
        waitTime = remaining; // Precise wait for final second
      }

      await new Promise(r => setTimeout(r, Math.min(waitTime, remaining)));
    }

    // Step 6: Stop and settle market
    const actualStopTime = Date.now();
    const timingError = actualStopTime - marketEndTime;
    log(C.bold("\n=== CLOSING MARKET ==="));
    log(`Target time: ${formatTime(new Date(marketEndTime))}`);
    log(`Actual time: ${formatTime(new Date(actualStopTime))} (${timingError > 0 ? '+' : ''}${timingError}ms)`);
    await stopMarket(conn, kp, ammPda);

    // Cancel all open limit orders when market stops
    await cancelAllOpenOrders();

    await new Promise(r => setTimeout(r, 1500));

    // Capture settlement data
    const settlePrice = await readOraclePrice(conn);
    await settleMarket(conn, kp, ammPda);
    await new Promise(r => setTimeout(r, 1000));

    // Read final market data to get resolution
    const marketData = await readMarketData(conn, ammPda);

    logSuccess(C.bold("✓ Market settled! Entering waiting period..."));
    if (marketData) {
      log(`Resolution: ${C.bold(marketData.winningSide)} won (Start: $${marketData.startPrice?.toFixed(2)}, Settle: $${settlePrice?.toFixed(2)})`);
    }

    // Auto-redeem all positions (prevents locked funds) - pass prices for settlement history
    await autoRedeemAllPositions(conn, kp, ammPda, vaultPda, marketData?.startPrice, settlePrice);
    await new Promise(r => setTimeout(r, 1000));

    // Step 7: Settled phase - show results for 1 minute
    logSuccess(C.bold("✓ Market settled! Showing results..."));
    if (marketData) {
      log(`Resolution: ${C.bold(marketData.winningSide)} won (Start: $${marketData.startPrice?.toFixed(2)}, Settle: $${settlePrice?.toFixed(2)})`);
    }

    // Update status - market is stopped, next cycle begins immediately
    writeStatus({
      state: "STOPPED",
      cycleStartTime,
      snapshotTime,
      marketEndTime,
      nextCycleStartTime,
      lastUpdate: Date.now()
    });

    logSuccess(C.bold("✓ Cycle complete! Next cycle will start immediately with new pre-market."));

  } catch (err) {
    logError("Cycle error:", err.message);
    console.error(err);

    writeStatus({
      state: "ERROR",
      error: err.message,
      lastUpdate: Date.now()
    });

    // Wait a bit before retrying
    await new Promise(r => setTimeout(r, 30000));
  }
}

/* ---------------- Wipe All Positions ---------------- */
async function wipeAllPositions(conn, kp, ammPda) {
  log(C.bold("\n=== WIPING ALL POSITIONS ==="));

  const positions = await findAllPositions(conn, ammPda);

  if (positions.length === 0) {
    logInfo("No positions to wipe");
    return;
  }

  logInfo(`Found ${positions.length} positions to wipe`);

  let successCount = 0;
  let failCount = 0;

  for (const pos of positions) {
    try {
      const ownerShort = pos.owner.toString().slice(0, 8);
      log(`[${successCount + failCount + 1}/${positions.length}] Wiping position for ${ownerShort}...`);

      // Call wipe_position instruction
      const wipeIx = new TransactionInstruction({
        programId: PID,
        keys: [
          { pubkey: ammPda, isSigner: false, isWritable: true },
          { pubkey: kp.publicKey, isSigner: true, isWritable: false }, // admin
          { pubkey: pos.owner, isSigner: false, isWritable: false }, // owner (for PDA derivation)
          { pubkey: pos.pubkey, isSigner: false, isWritable: true }, // position account
        ],
        data: discriminator("wipe_position"),
      });

      const budgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 150_000 });
      const tx = new Transaction().add(budgetIx, wipeIx);
      const sig = await sendTransactionWithRetry(conn, tx, [kp]);

      logSuccess(`  ✓ Wiped: ${sig.slice(0, 16)}...`);
      successCount++;
    } catch (err) {
      logError(`  ✗ Failed for ${pos.owner.toString().slice(0, 8)}: ${err.message}`);
      failCount++;
    }
  }

  logSuccess(`\nWipe complete: ${successCount} success, ${failCount} failed`);
}

/* ---------------- Main ---------------- */
async function main() {
  console.log(C.bold("\n╔═══════════════════════════════════════════════╗"));
  console.log(C.bold("║     AUTOMATED SETTLEMENT BOT - 30 MIN CYCLES  ║"));
  console.log(C.bold("╚═══════════════════════════════════════════════╝\n"));

  logInfo(`Oracle: ${ORACLE_STATE.toString()}`);
  logInfo(`Using wallet: ${WALLET}`);

  // Load wallet
  if (!fs.existsSync(WALLET)) {
    logError(`Wallet not found: ${WALLET}`);
    process.exit(1);
  }
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(WALLET, "utf8"))));
  log(`Operator: ${C.y(kp.publicKey.toString())}`);

  // Connect
  const conn = new Connection(RPC, "confirmed");
  log(`RPC: ${C.c(RPC)}`);
  log(`Oracle: ${C.m(ORACLE_STATE.toString())}`);

  // Derive PDAs
  const [ammPda] = PublicKey.findProgramAddressSync([AMM_SEED], PID);
  const [vaultPda] = PublicKey.findProgramAddressSync([VAULT_SOL_SEED, ammPda.toBuffer()], PID);

  log(`AMM PDA: ${C.b(ammPda.toString())}`);
  log(`Vault PDA: ${C.b(vaultPda.toString())}`);

  // Initialize market IMMEDIATELY on startup (allow pre-market trading right away)
  log(C.bold("\n🚀 Initializing market for immediate pre-market trading...\n"));

  const ammInfo = await conn.getAccountInfo(ammPda);
  if (ammInfo) {
    log("Found existing market - wiping old positions first...");
    await wipeAllPositions(conn, kp, ammPda);
    await new Promise(r => setTimeout(r, 1000));

    log("Closing existing market...");
    await closeMarket(conn, kp, ammPda);
    await new Promise(r => setTimeout(r, 2000));
  }

  await initMarket(conn, kp, ammPda, vaultPda);
  await new Promise(r => setTimeout(r, 1500));

  // Reset volume for new market cycle
  await resetVolume();

  logSuccess(C.bold("✓ PRE-MARKET BETTING NOW OPEN!"));

  // Calculate next cycle start time (minute ending in 0)
  const nextStart = getNextStartTime();
  const waitMs = nextStart.getTime() - Date.now();
  const snapshotTime = nextStart.getTime();
  const marketEndTime = snapshotTime + ACTIVE_DURATION_MS;
  const nextCycleStartTime = nextStart.getTime() + CYCLE_DURATION_MS;

  log(C.bold(`\n⏰ Current cycle snapshot at: ${formatTime(nextStart)}`));
  log(`Pre-market phase: ${formatCountdown(waitMs)} until snapshot\n`);

  writeStatus({
    state: "PREMARKET",
    cycleStartTime: Date.now(),
    snapshotTime: snapshotTime,
    marketEndTime: marketEndTime,
    nextCycleStartTime: nextCycleStartTime,
    lastUpdate: Date.now()
  });

  // Wait until snapshot time
  await new Promise(r => setTimeout(r, waitMs));

  // Take snapshot at the scheduled time
  log(C.bold("\n📸 TAKING ORACLE SNAPSHOT\n"));
  const snapshotSuccess = await snapshotStart(conn, kp, ammPda);
  if (!snapshotSuccess) {
    throw new Error("Failed to take oracle snapshot");
  }

  logSuccess(C.bold("✓ ACTIVE MARKET NOW OPEN (snapshot taken)"));

  // Set market end slot for trading lockout
  const currentSlot = await conn.getSlot();
  const remainingMs = marketEndTime - Date.now();
  const remainingSlots = Math.floor(remainingMs / 300); // ~300ms per slot
  const marketEndSlot = currentSlot + remainingSlots;

  log(C.bold("\n=== SETTING MARKET END SLOT ==="));
  logInfo(`  Current slot: ${currentSlot}`);
  logInfo(`  Time until market close: ${formatCountdown(remainingMs)}`);
  logInfo(`  Estimated slots until close: ${remainingSlots}`);
  logInfo(`  Market end slot: ${marketEndSlot}`);
  logInfo(`  Trading lockout starts at slot: ${marketEndSlot - 90} (90 slots ≈45s before close)`);

  await setMarketEndSlot(conn, kp, ammPda, marketEndSlot, marketEndTime);
  logSuccess(C.bold("✓ Market end slot configured - trading lockout will activate 90 slots before close!"));

  // Update status to ACTIVE
  writeStatus({
    state: "ACTIVE",
    cycleStartTime: Date.now() - waitMs,
    snapshotTime: Date.now(),
    marketEndTime: marketEndTime,
    nextCycleStartTime: nextCycleStartTime,
    lastUpdate: Date.now()
  });

  // Wait for active trading period to end (precise timing)
  log(`Market will close at exactly: ${formatTime(new Date(marketEndTime))}`);
  log(`Active trading: ${formatCountdown(marketEndTime - Date.now())} until market closes\n`);

  // Check every second for precise timing
  while (true) {
    const now = Date.now();
    const remaining = marketEndTime - now;

    if (remaining <= 100) { // Stop within 100ms of target
      break;
    }

    const waitTime = Math.min(1000, remaining - 100);
    await new Promise(r => setTimeout(r, waitTime));
  }

  // Wait until exactly marketEndTime
  const finalWait = marketEndTime - Date.now();
  if (finalWait > 0) {
    await new Promise(r => setTimeout(r, finalWait));
  }

  // Stop and settle the first cycle
  const actualStopTime = Date.now();
  const timingError = actualStopTime - marketEndTime;
  log(C.bold("\n🛑 STOPPING MARKET\n"));
  log(`Target time: ${formatTime(new Date(marketEndTime))}`);
  log(`Actual time: ${formatTime(new Date(actualStopTime))} (${timingError > 0 ? '+' : ''}${timingError}ms)`);
  await stopMarket(conn, kp, ammPda);

  // Cancel all open limit orders when market stops
  await cancelAllOpenOrders();

  await new Promise(r => setTimeout(r, 1500));

  log(C.bold("\n⚖️  SETTLING MARKET\n"));
  const settleSuccess = await settleMarket(conn, kp, ammPda);
  if (settleSuccess) {
    const marketData = await readMarketData(conn, ammPda);
    const settlePrice = await readOraclePrice(conn);
    if (marketData) {
      log(`Resolution: ${C.bold(marketData.winningSide)} won (Start: $${marketData.startPrice?.toFixed(2)}, Settle: $${settlePrice?.toFixed(2)})`);
    }

    await autoRedeemAllPositions(conn, kp, ammPda, vaultPda, marketData?.startPrice, settlePrice);
    await new Promise(r => setTimeout(r, 1000));
  }

  // Update status to STOPPED
  writeStatus({
    state: "STOPPED",
    cycleStartTime: Date.now() - waitMs,
    snapshotTime: snapshotTime,
    marketEndTime: marketEndTime,
    nextCycleStartTime: nextCycleStartTime,
    lastUpdate: Date.now()
  });

  logSuccess(C.bold("✓ First cycle complete! Starting continuous cycles...\n"));

  // Run continuous cycles
  while (true) {
    await runCycle(conn, kp, ammPda, vaultPda);
  }
}

/* ---------------- Force Settlement (Manual Trigger) ---------------- */
async function forceSettle() {
  console.log(C.bold("\n╔═══════════════════════════════════════════════╗"));
  console.log(C.bold("║        FORCE SETTLEMENT - MANUAL TRIGGER      ║"));
  console.log(C.bold("╚═══════════════════════════════════════════════╝\n"));

  logInfo(`Oracle: ${ORACLE_STATE.toString()}`);
  logInfo(`Using wallet: ${WALLET}`);

  // Load wallet
  if (!fs.existsSync(WALLET)) {
    logError(`Wallet not found: ${WALLET}`);
    process.exit(1);
  }
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(WALLET, "utf8"))));
  log(`Operator: ${C.y(kp.publicKey.toString())}`);

  // Connect
  const conn = new Connection(RPC, "confirmed");
  log(`RPC: ${C.c(RPC)}`);

  // Derive PDAs
  const [ammPda] = PublicKey.findProgramAddressSync([AMM_SEED], PID);
  const [vaultPda] = PublicKey.findProgramAddressSync([VAULT_SOL_SEED, ammPda.toBuffer()], PID);

  log(`AMM PDA: ${C.b(ammPda.toString())}`);
  log(`Vault PDA: ${C.b(vaultPda.toString())}`);
  log("");

  // Check market state
  const marketData = await readMarketData(conn, ammPda);
  if (!marketData) {
    logError("Market not found or cannot be read");
    process.exit(1);
  }

  log(C.bold("Current Market State:"));
  log(`  Status: ${C.y(marketData.status)}`);
  log(`  Winner: ${marketData.winner === 0 ? 'Not set' : (marketData.winner === 1 ? 'YES (UP)' : 'NO (DOWN)')}`);
  log("");

  if (marketData.status === 'Open') {
    logError("Market is still OPEN. Must stop market first before settling.");
    log("Run: ANCHOR_WALLET=./operator.json node app/trade.js stop");
    process.exit(1);
  }

  if (marketData.status === 'Stopped') {
    // Check if settlement has been calculated (winner is set)
    if (marketData.winner && marketData.winner !== 'Unknown') {
      logInfo("Market is STOPPED and settled. Checking if redemptions are needed...");
      const positions = await findAllPositions(conn, ammPda);
      if (positions.length === 0) {
        logSuccess("No positions to redeem. Market settlement is complete.");
        process.exit(0);
      }
      logInfo(`Found ${positions.length} positions that need redemption`);
    } else {
      log(C.bold("🛑 Market is STOPPED but not settled. Settling now...\n"));
      // Cancel any remaining open orders
      await cancelAllOpenOrders();
      const settleSuccess = await settleMarket(conn, kp, ammPda);
      if (!settleSuccess) {
        logError("Settlement failed!");
        process.exit(1);
      }
      await new Promise(r => setTimeout(r, 2000));
      logSuccess("✓ Market settled successfully\n");
    }
  }

  // Read final market state and oracle price
  const finalMarketData = await readMarketData(conn, ammPda);
  const settlePrice = await readOraclePrice(conn);

  if (finalMarketData) {
    log(`Resolution: ${C.bold(finalMarketData.winningSide)} won`);
    log(`  Snapshot price: $${finalMarketData.startPrice?.toFixed(2) || '?'}`);
    log(`  Settle price: $${settlePrice?.toFixed(2) || '?'}`);
    log("");
  }

  // Redeem all positions
  log(C.bold("💰 Processing redemptions...\n"));
  await autoRedeemAllPositions(conn, kp, ammPda, vaultPda, finalMarketData?.startPrice, settlePrice);

  logSuccess(C.bold("\n✓ Force settlement complete!"));
  log("You can now start a new market cycle.");
}

/* ---------------- Run ---------------- */
// Check for CLI commands
const command = process.argv[2];

if (command === 'force-settle') {
  forceSettle().catch((err) => {
    logError("Force settlement failed:", err);
    process.exit(1);
  });
} else if (command === 'help' || command === '--help' || command === '-h') {
  console.log(`
${C.bold('Settlement Bot Commands:')}

  ${C.y('node app/settlement_bot.js')}
    Run the automated settlement bot (30-minute cycles starting at :00 and :30)

  ${C.y('node app/settlement_bot.js force-settle')}
    Manually trigger settlement for a stopped market
    Use this if automated settlement fails or gets stuck

  ${C.y('node app/settlement_bot.js help')}
    Show this help message

${C.bold('Examples:')}
  # Run automated bot
  node app/settlement_bot.js

  # Force manual settlement
  ANCHOR_WALLET=./operator.json node app/settlement_bot.js force-settle
  `);
  process.exit(0);
} else {
  main().catch((err) => {
    logError("Fatal error:", err);
    writeStatus({
      state: "ERROR",
      error: err.message,
      lastUpdate: Date.now()
    });
    process.exit(1);
  });
}
