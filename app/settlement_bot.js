#!/usr/bin/env node
// app/settlement_bot.js — Automated settlement bot for 10-minute market cycles
// Cycles: 5 mins active trading -> stop & settle -> 5 mins wait -> restart
// Markets start on minutes ending in 0 (e.g., 19:30, 19:40, 19:50)

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
const AMM_SEED = Buffer.from("amm_btc_v3");
const VAULT_SOL_SEED = Buffer.from("vault_sol");

// === TIMING CONSTANTS ===
const CYCLE_DURATION_MS = 10 * 60 * 1000;     // 10 minutes total
const PREMARKET_DURATION_MS = 5 * 60 * 1000;  // 5 minutes pre-market (no snapshot yet)
const ACTIVE_DURATION_MS = 5 * 60 * 1000;     // 5 minutes active (after snapshot)

// === LAMPORTS CONVERSION ===
const LAMPORTS_PER_E6 = 100;                   // Must match Rust program constant
const E6_PER_XNT = 10_000_000;                 // 1 XNT = 10M e6 units
const LAMPORTS_PER_XNT = E6_PER_XNT * LAMPORTS_PER_E6; // 1 XNT = 1 billion lamports

// === STATUS FILE ===
const STATUS_FILE = "./market_status.json";

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

/* ---------------- Helpers ---------------- */
function log(...args) {
  console.log(C.c(`[${new Date().toISOString()}]`), ...args);
}

function logError(...args) {
  console.error(C.r(`[ERROR]`), ...args);
}

function logSuccess(...args) {
  console.log(C.g(`[SUCCESS]`), ...args);
}

function logInfo(...args) {
  console.log(C.b(`[INFO]`), ...args);
}

/* ---------------- Broadcast Redemption to Trade Feed ---------------- */
function broadcastRedemption(userAddress, amountXnt, userSide) {
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

    // Also post to settlement history API
    postSettlementHistory(userAddress, amountXnt, userSide);

  } catch (err) {
    logError("Failed to broadcast redemption:", err.message);
  }
}

/* ---------------- Post Settlement to History API ---------------- */
function postSettlementHistory(userAddress, amountXnt, userSide) {
  try {
    const userPrefix = userAddress.substring(0, 6);
    const result = amountXnt > 0 ? 'WIN' : 'LOSE';

    const postData = JSON.stringify({
      userPrefix: userPrefix,
      result: result,
      amount: amountXnt,
      side: userSide // The side the user held (YES/NO)
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
        logInfo(`  → Settlement history saved for ${userPrefix}...`);
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
          logInfo('📊 Volume reset for new market cycle');
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
  log("Initializing new market...");
  const b = 500_000_000; // 500.00 in e6
  const feeBps = 25;

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
  logSuccess(`Market initialized: ${sig}`);
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
  const accounts = await conn.getProgramAccounts(PID, {
    filters: [
      {
        dataSize: 8 + 32 + 8 + 8, // discriminator + owner pubkey + yes_shares + no_shares
      },
    ],
  });

  const positions = [];
  for (const { pubkey, account } of accounts) {
    try {
      const data = account.data;
      if (data.length < 8 + 32 + 8 + 8) continue;

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

async function autoRedeemAllPositions(conn, kp, ammPda, vaultPda) {
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

  let successCount = 0;
  let failCount = 0;

  for (const pos of positions) {
    try {
      const yesSharesDisplay = (pos.yesShares / 1_000_000).toFixed(2);
      const noSharesDisplay = (pos.noShares / 1_000_000).toFixed(2);

      // Calculate payout amount
      let payoutAmount = 0;
      if (winningSide === 'YES' && pos.yesShares > 0) {
        payoutAmount = (pos.yesShares / 1_000_000) * payoutPerShare;
      } else if (winningSide === 'NO' && pos.noShares > 0) {
        payoutAmount = (pos.noShares / 1_000_000) * payoutPerShare;
      }

      log(`Redeeming for ${pos.owner.toString().slice(0, 8)}... (UP: ${yesSharesDisplay}, DOWN: ${noSharesDisplay})`);

      // Get user's balance before redeem
      const balanceBefore = await conn.getBalance(pos.owner);

      // Use admin_redeem instruction
      const redeemIx = new TransactionInstruction({
        programId: PID,
        keys: [
          { pubkey: ammPda, isSigner: false, isWritable: true },
          { pubkey: kp.publicKey, isSigner: true, isWritable: true }, // Admin (fee_dest)
          { pubkey: pos.owner, isSigner: false, isWritable: true }, // User receives payout
          { pubkey: pos.pubkey, isSigner: false, isWritable: true }, // Position account
          { pubkey: kp.publicKey, isSigner: false, isWritable: true }, // fee_dest (same as admin)
          { pubkey: vaultPda, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: discriminator("admin_redeem"),
      });

      const budgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 });
      const tx = new Transaction().add(budgetIx, redeemIx);
      const sig = await sendTransactionWithRetry(conn, tx, [kp]);

      // Get user's balance after redeem
      const balanceAfter = await conn.getBalance(pos.owner);
      // Convert lamports to XNT using LAMPORTS_PER_XNT constant
      const actualPayout = (balanceAfter - balanceBefore) / LAMPORTS_PER_XNT;

      logSuccess(`  ✓ Redeemed: ${sig.slice(0, 16)}... → ${actualPayout.toFixed(2)} XNT paid to user`);

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

      // Broadcast redemption event with user's actual side
      broadcastRedemption(pos.owner.toString(), actualPayout, userSide);

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
  const minutes = now.getMinutes();
  const seconds = now.getSeconds();

  // Calculate total seconds since start of hour
  const totalSeconds = minutes * 60 + seconds;

  logInfo(C.bold("📅 Calculating next cycle start time:"));
  logInfo(`  Current time: ${formatTime(now)} (${minutes}m ${seconds}s)`);
  logInfo(`  Total seconds since hour start: ${totalSeconds}s`);

  // Find next 10-minute boundary (600 seconds = 10 minutes)
  const nextBoundarySeconds = Math.ceil(totalSeconds / 600) * 600;
  logInfo(`  Next 10-minute boundary: ${nextBoundarySeconds}s (${Math.floor(nextBoundarySeconds / 60)}m)`);

  const nextStart = new Date(now);

  if (nextBoundarySeconds >= 3600) {
    // Roll over to next hour (3600 seconds = 60 minutes)
    logInfo(`  Boundary >= 3600s, rolling to next hour`);
    nextStart.setHours(nextStart.getHours() + 1);
    nextStart.setMinutes(0);
  } else {
    logInfo(`  Setting minutes to: ${Math.floor(nextBoundarySeconds / 60)}`);
    nextStart.setMinutes(Math.floor(nextBoundarySeconds / 60));
  }

  nextStart.setSeconds(0);
  nextStart.setMilliseconds(0);

  logInfo(C.g(`  ✓ Next cycle will start at: ${formatTime(nextStart)}`));
  logInfo(C.g(`  ✓ Time until next cycle: ${formatCountdown(nextStart.getTime() - now.getTime())}`));

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
  // Wait until the next aligned time boundary (minute ending in 0)
  const nextStart = getNextStartTime();
  const now = Date.now();
  const waitMs = nextStart.getTime() - now;

  if (waitMs > 1000) {
    log(C.bold(`\n⏰ Waiting ${formatCountdown(waitMs)} until next cycle at ${formatTime(nextStart)}`));
    await new Promise(r => setTimeout(r, waitMs));
  }

  // Use the aligned start time for all calculations
  const cycleStartTime = nextStart.getTime();
  const snapshotTime = cycleStartTime + PREMARKET_DURATION_MS;
  const marketEndTime = snapshotTime + ACTIVE_DURATION_MS;
  const nextCycleStartTime = cycleStartTime + CYCLE_DURATION_MS;

  log(C.bold("\n=== STARTING NEW MARKET CYCLE ==="));
  logInfo(C.bold("⏱️  Cycle Timing Breakdown:"));
  logInfo(`  Cycle start time: ${formatTime(new Date(cycleStartTime))} (${cycleStartTime}ms)`);
  logInfo(`  + ${PREMARKET_DURATION_MS / 1000}s pre-market = Snapshot at: ${formatTime(new Date(snapshotTime))}`);
  logInfo(`  + ${ACTIVE_DURATION_MS / 1000}s active trading = Market close at: ${formatTime(new Date(marketEndTime))}`);
  logInfo(C.y(`  + ${CYCLE_DURATION_MS / 1000}s total cycle = Next cycle at: ${formatTime(new Date(nextCycleStartTime))}`));
  log(C.bold(`\n📊 Current Cycle: ${formatTime(new Date(cycleStartTime))} → ${formatTime(new Date(marketEndTime))}`));
  log(C.bold(C.y(`🔄 Next Cycle Scheduled: ${formatTime(new Date(nextCycleStartTime))} (in ${formatCountdown(nextCycleStartTime - Date.now())})`)));

  try {
    // Step 1: Close existing market if exists, then IMMEDIATELY open new one
    const ammInfo = await conn.getAccountInfo(ammPda);
    if (ammInfo) {
      await closeMarket(conn, kp, ammPda);
      await new Promise(r => setTimeout(r, 2000));
    }

    // Step 2: Initialize new market IMMEDIATELY (no waiting period)
    await initMarket(conn, kp, ammPda, vaultPda);
    await new Promise(r => setTimeout(r, 1500));

    // Reset volume for new market cycle
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

    // Auto-redeem all positions (prevents locked funds)
    await autoRedeemAllPositions(conn, kp, ammPda, vaultPda);
    await new Promise(r => setTimeout(r, 1000));

    // Update status to SETTLED
    writeStatus({
      state: "SETTLED",
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

/* ---------------- Main ---------------- */
async function main() {
  console.log(C.bold("\n╔═══════════════════════════════════════════════╗"));
  console.log(C.bold("║     AUTOMATED SETTLEMENT BOT - 10 MIN CYCLES  ║"));
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
  await new Promise(r => setTimeout(r, 1500));

  log(C.bold("\n⚖️  SETTLING MARKET\n"));
  const settleSuccess = await settleMarket(conn, kp, ammPda);
  if (settleSuccess) {
    const marketData = await readMarketData(conn, ammPda);
    if (marketData) {
      const settlePrice = await readOraclePrice(conn);
      log(`Resolution: ${C.bold(marketData.winningSide)} won (Start: $${marketData.startPrice?.toFixed(2)}, Settle: $${settlePrice?.toFixed(2)})`);
    }

    await autoRedeemAllPositions(conn, kp, ammPda, vaultPda);
    await new Promise(r => setTimeout(r, 1000));
  }

  // Update status to SETTLED
  writeStatus({
    state: "SETTLED",
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

/* ---------------- Run ---------------- */
main().catch((err) => {
  logError("Fatal error:", err);
  writeStatus({
    state: "ERROR",
    error: err.message,
    lastUpdate: Date.now()
  });
  process.exit(1);
});
