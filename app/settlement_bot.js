#!/usr/bin/env node
// app/settlement_bot.js — Automated settlement bot for 10-minute market cycles
// Cycles: 5 mins active trading -> stop & settle -> 5 mins wait -> restart
// Markets start on minutes ending in 0 (e.g., 19:30, 19:40, 19:50)

const fs = require("fs");
const crypto = require("crypto");
const {
  Connection, PublicKey, Keypair, SystemProgram,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
  ComputeBudgetProgram, SYSVAR_RENT_PUBKEY,
} = require("@solana/web3.js");

/* ---------------- CONFIG ---------------- */
const RPC = process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899";
const WALLET = process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/id.json`;
const ORACLE_STATE = process.env.ORACLE_STATE ? new PublicKey(process.env.ORACLE_STATE) : null;

// === PROGRAM IDs / SEEDS ===
const PID = new PublicKey("EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF");
const AMM_SEED = Buffer.from("amm_btc_v3");
const VAULT_SOL_SEED = Buffer.from("vault_sol");

// === TIMING CONSTANTS ===
const CYCLE_DURATION_MS = 10 * 60 * 1000; // 10 minutes
const ACTIVE_DURATION_MS = 5 * 60 * 1000; // 5 minutes active trading
const WAIT_DURATION_MS = 5 * 60 * 1000;   // 5 minutes waiting

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
  const sig = await sendAndConfirmTransaction(conn, tx, [kp]);
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
  const sig = await sendAndConfirmTransaction(conn, tx, [kp]);
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
  const sig = await sendAndConfirmTransaction(conn, tx, [kp]);
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
  const sig = await sendAndConfirmTransaction(conn, tx, [kp]);
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
  const sig = await sendAndConfirmTransaction(conn, tx, [kp]);
  logSuccess(`Market settled: ${sig}`);
  return true;
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
    o += 8; // payout_per_share
    o += 32; // fee_dest
    o += 1; // vault_sol_bump
    const startPriceE6 = Number(d.readBigInt64LE(8 + o));

    // Calculate winner based on probabilities
    const b = bScaled;
    const a = Math.exp(qY / b);
    const c = Math.exp(qN / b);
    const yesProb = a / (a + c);

    const winningSide = yesProb > 0.5 ? 'YES' : 'NO';
    const startPrice = startPriceE6 > 0 ? startPriceE6 / 1_000_000 : null;

    return {
      status,
      winner,
      winningSide,
      startPrice,
      yesProb,
      noProb: 1 - yesProb
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
  const ms = now.getMilliseconds();

  // Find next minute ending in 0 (e.g., 19:30, 19:40, 19:50, 20:00)
  let nextMinute = Math.ceil(minutes / 10) * 10;
  if (nextMinute === 60) nextMinute = 0;

  const nextStart = new Date(now);
  if (nextMinute === 0) {
    nextStart.setHours(nextStart.getHours() + 1);
  }
  nextStart.setMinutes(nextMinute);
  nextStart.setSeconds(0);
  nextStart.setMilliseconds(0);

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
  const cycleStartTime = Date.now();
  const marketEndTime = cycleStartTime + ACTIVE_DURATION_MS;
  const nextCycleStartTime = cycleStartTime + CYCLE_DURATION_MS;

  log(C.bold("\n=== STARTING NEW MARKET CYCLE ==="));
  log(`Cycle start: ${formatTime(new Date(cycleStartTime))}`);
  log(`Market will close at: ${formatTime(new Date(marketEndTime))}`);
  log(`Next cycle starts at: ${formatTime(new Date(nextCycleStartTime))}`);

  try {
    // Step 1: Close existing market if exists
    const ammInfo = await conn.getAccountInfo(ammPda);
    if (ammInfo) {
      await closeMarket(conn, kp, ammPda);
      await new Promise(r => setTimeout(r, 2000));
    }

    // Step 2: Initialize new market
    await initMarket(conn, kp, ammPda, vaultPda);
    await new Promise(r => setTimeout(r, 1500));

    // Step 3: Take snapshot
    const snapshotSuccess = await snapshotStart(conn, kp, ammPda);
    if (!snapshotSuccess) {
      logError("Failed to take snapshot - aborting cycle");
      return;
    }

    logSuccess(C.bold("✓ Market is now ACTIVE for trading!"));

    // Update status: ACTIVE
    writeStatus({
      state: "ACTIVE",
      cycleStartTime,
      marketEndTime,
      nextCycleStartTime,
      lastUpdate: Date.now()
    });

    // Step 4: Wait for active period, updating status regularly
    const activeWaitStart = Date.now();
    while (Date.now() < marketEndTime) {
      const remaining = marketEndTime - Date.now();
      if (remaining > 0) {
        logInfo(`Market active - ${formatCountdown(remaining)} remaining`);
        writeStatus({
          state: "ACTIVE",
          cycleStartTime,
          marketEndTime,
          nextCycleStartTime,
          timeRemaining: remaining,
          lastUpdate: Date.now()
        });
        await new Promise(r => setTimeout(r, Math.min(10000, remaining))); // Update every 10s
      }
    }

    // Step 5: Stop and settle market
    log(C.bold("\n=== CLOSING MARKET ==="));
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

    // Update status: WAITING with last resolution data
    const lastResolution = marketData && marketData.startPrice && settlePrice ? {
      startPrice: marketData.startPrice,
      settlePrice: settlePrice,
      winner: marketData.winningSide
    } : null;

    writeStatus({
      state: "WAITING",
      cycleStartTime,
      marketEndTime,
      nextCycleStartTime,
      lastUpdate: Date.now(),
      lastResolution
    });

    // Step 6: Wait for next cycle, updating status regularly
    while (Date.now() < nextCycleStartTime) {
      const remaining = nextCycleStartTime - Date.now();
      if (remaining > 0) {
        logInfo(`Waiting for next cycle - ${formatCountdown(remaining)} until ${formatTime(new Date(nextCycleStartTime))}`);
        writeStatus({
          state: "WAITING",
          cycleStartTime,
          marketEndTime,
          nextCycleStartTime,
          timeRemaining: remaining,
          lastUpdate: Date.now(),
          lastResolution
        });
        await new Promise(r => setTimeout(r, Math.min(10000, remaining))); // Update every 10s
      }
    }

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

  if (!ORACLE_STATE) {
    logError("ORACLE_STATE environment variable not set!");
    logError("Set it like: ORACLE_STATE=4KYeNyv1B9YjjQkfJk2C6Uqo71vKzFZriRe5NXg6GyCq");
    process.exit(1);
  }

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

  // Wait for next start time (minute ending in 0)
  const nextStart = getNextStartTime();
  const waitMs = nextStart.getTime() - Date.now();

  log(C.bold(`\n⏰ Next market starts at: ${formatTime(nextStart)}`));
  log(`Waiting ${formatCountdown(waitMs)}...\n`);

  writeStatus({
    state: "WAITING",
    nextCycleStartTime: nextStart.getTime(),
    timeRemaining: waitMs,
    lastUpdate: Date.now()
  });

  await new Promise(r => setTimeout(r, waitMs));

  // Run continuous cycles
  log(C.bold("\n🚀 Starting continuous market cycles...\n"));

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
