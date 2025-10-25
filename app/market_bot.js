#!/usr/bin/env node
// app/market_bot.js — Market operator bot for managing market lifecycle
// Commands: restart, stop, settle, stop-settle
// Usage: ANCHOR_WALLET=./operator.json node app/market_bot.js restart

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

// === PROGRAM IDs / SEEDS ===
const PID = new PublicKey("EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF");
const AMM_SEED = Buffer.from("amm_btc_v3");
const VAULT_SOL_SEED = Buffer.from("vault_sol");

// Oracle STATE account
let ORACLE_STATE = null;
try {
  if (process.env.ORACLE_STATE) ORACLE_STATE = new PublicKey(process.env.ORACLE_STATE);
} catch (_) {}

/* ---------------- Color helpers ---------------- */
const WANT_COLOR = !process.env.NO_COLOR && process.stdout.isTTY;
const C = WANT_COLOR ? {
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  b: (s) => `\x1b[34m${s}\x1b[0m`,
  c: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
} : { r: s => s, g: s => s, y: s => s, b: s => s, c: s => s, bold: s => s };

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

/* ---------------- SHA256 discriminator ---------------- */
function sha256(data) {
  return crypto.createHash("sha256").update(data).digest();
}

function discriminator(ixName) {
  const preimage = `global:${ixName}`;
  return sha256(Buffer.from(preimage, "utf8")).slice(0, 8);
}

/* ---------------- Main ---------------- */
async function main() {
  const command = process.argv[2];

  if (!command || !["restart", "stop", "settle", "stop-settle"].includes(command)) {
    console.log(`
${C.bold("Market Bot CLI")}

${C.y("Usage:")}
  ANCHOR_WALLET=./operator.json node app/market_bot.js <command>

${C.y("Commands:")}
  ${C.g("restart")}      - Close existing market, init new one, and take snapshot
  ${C.g("stop")}         - Stop trading on current market
  ${C.g("settle")}       - Settle market by oracle price
  ${C.g("stop-settle")}  - Stop trading AND settle market in one command

${C.y("Environment:")}
  ANCHOR_WALLET       - Path to operator keypair (default: ~/.config/solana/id.json)
  ANCHOR_PROVIDER_URL - RPC endpoint (default: http://127.0.0.1:8899)
  ORACLE_STATE        - Oracle state account public key (required for settle/stop-settle)

${C.y("Examples:")}
  ANCHOR_WALLET=./operator.json node app/market_bot.js restart
  ANCHOR_WALLET=./operator.json node app/market_bot.js stop
  ORACLE_STATE=4KYeNyv1B9YjjQkfJk2C6Uqo71vKzFZriRe5NXg6GyCq node app/market_bot.js settle
  ORACLE_STATE=4KYeNyv1B9YjjQkfJk2C6Uqo71vKzFZriRe5NXg6GyCq node app/market_bot.js stop-settle
`);
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

  // Derive PDAs
  const [ammPda] = PublicKey.findProgramAddressSync([AMM_SEED], PID);
  const [vaultPda] = PublicKey.findProgramAddressSync([VAULT_SOL_SEED, ammPda.toBuffer()], PID);

  log(`AMM PDA: ${C.b(ammPda.toString())}`);

  // Execute command
  switch (command) {
    case "restart":
      await cmdRestart(conn, kp, ammPda, vaultPda);
      break;
    case "stop":
      await cmdStop(conn, kp, ammPda);
      break;
    case "settle":
      await cmdSettle(conn, kp, ammPda);
      break;
    case "stop-settle":
      await cmdStopSettle(conn, kp, ammPda);
      break;
  }
}

/* ---------------- Command: Restart Market ---------------- */
async function cmdRestart(conn, kp, ammPda, vaultPda) {
  log(C.bold("\n=== RESTARTING MARKET ===\n"));

  // Step 1: Close existing market if it exists
  const ammInfo = await conn.getAccountInfo(ammPda);
  if (ammInfo) {
    log("Closing existing market...");
    try {
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
    } catch (err) {
      logError(`Failed to close market:`, err.message);
      log("Proceeding with initialization anyway...");
    }

    await new Promise((r) => setTimeout(r, 2000));
  } else {
    log("No existing market found, proceeding to initialize...");
  }

  // Step 2: Initialize new market
  log("\nInitializing new market...");
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

  try {
    const tx = new Transaction().add(initIx);
    const sig = await sendAndConfirmTransaction(conn, tx, [kp]);
    logSuccess(`Market initialized: ${sig}`);
  } catch (err) {
    logError(`Failed to initialize market:`, err.message);
    process.exit(1);
  }

  await new Promise((r) => setTimeout(r, 1500));

  // Step 3: Take oracle snapshot
  if (!ORACLE_STATE) {
    logError("ORACLE_STATE environment variable not set - cannot take snapshot");
    log("Market initialized but snapshot not taken");
    return;
  }

  log("\nTaking oracle snapshot...");
  const snapshotIx = new TransactionInstruction({
    programId: PID,
    keys: [
      { pubkey: ammPda, isSigner: false, isWritable: true },
      { pubkey: ORACLE_STATE, isSigner: false, isWritable: false },
    ],
    data: discriminator("snapshot_start"),
  });

  try {
    const budgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });
    const tx = new Transaction().add(budgetIx, snapshotIx);
    const sig = await sendAndConfirmTransaction(conn, tx, [kp]);
    logSuccess(`Snapshot taken: ${sig}`);
  } catch (err) {
    logError(`Failed to take snapshot:`, err.message);
    process.exit(1);
  }

  log(C.bold("\n✓ Market restarted and snapshot taken successfully!\n"));
}

/* ---------------- Command: Stop Market ---------------- */
async function cmdStop(conn, kp, ammPda) {
  log(C.bold("\n=== STOPPING MARKET ===\n"));

  const stopIx = new TransactionInstruction({
    programId: PID,
    keys: [
      { pubkey: ammPda, isSigner: false, isWritable: true },
      { pubkey: kp.publicKey, isSigner: true, isWritable: false },
    ],
    data: discriminator("stop_market"),
  });

  try {
    const tx = new Transaction().add(stopIx);
    const sig = await sendAndConfirmTransaction(conn, tx, [kp]);
    logSuccess(`Market stopped: ${sig}`);
    log(C.bold("\n✓ Trading halted. Market can now be settled.\n"));
  } catch (err) {
    logError(`Failed to stop market:`, err.message);
    process.exit(1);
  }
}

/* ---------------- Command: Settle Market ---------------- */
async function cmdSettle(conn, kp, ammPda) {
  log(C.bold("\n=== SETTLING MARKET ===\n"));

  if (!ORACLE_STATE) {
    logError("ORACLE_STATE environment variable not set");
    log("Set it like: ORACLE_STATE=4KYeNyv1B9YjjQkfJk2C6Uqo71vKzFZriRe5NXg6GyCq");
    process.exit(1);
  }

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

  try {
    const budgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });
    const tx = new Transaction().add(budgetIx, settleIx);
    const sig = await sendAndConfirmTransaction(conn, tx, [kp]);
    logSuccess(`Market settled: ${sig}`);
    log(C.bold("\n✓ Market resolved by oracle. Traders can now redeem winnings.\n"));
  } catch (err) {
    logError(`Failed to settle market:`, err.message);
    process.exit(1);
  }
}

/* ---------------- Command: Stop AND Settle Market ---------------- */
async function cmdStopSettle(conn, kp, ammPda) {
  log(C.bold("\n=== STOPPING AND SETTLING MARKET ===\n"));

  if (!ORACLE_STATE) {
    logError("ORACLE_STATE environment variable not set");
    log("Set it like: ORACLE_STATE=4KYeNyv1B9YjjQkfJk2C6Uqo71vKzFZriRe5NXg6GyCq");
    process.exit(1);
  }

  // Step 1: Stop trading
  log("Step 1: Stopping trading...");
  const stopIx = new TransactionInstruction({
    programId: PID,
    keys: [
      { pubkey: ammPda, isSigner: false, isWritable: true },
      { pubkey: kp.publicKey, isSigner: true, isWritable: false },
    ],
    data: discriminator("stop_market"),
  });

  try {
    const tx = new Transaction().add(stopIx);
    const sig = await sendAndConfirmTransaction(conn, tx, [kp]);
    logSuccess(`Market stopped: ${sig}`);
  } catch (err) {
    logError(`Failed to stop market:`, err.message);
    process.exit(1);
  }

  // Wait a moment between transactions
  await new Promise((r) => setTimeout(r, 1500));

  // Step 2: Settle by oracle
  log("\nStep 2: Settling by oracle...");
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

  try {
    const budgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });
    const tx = new Transaction().add(budgetIx, settleIx);
    const sig = await sendAndConfirmTransaction(conn, tx, [kp]);
    logSuccess(`Market settled: ${sig}`);
    log(C.bold("\n✓ Market stopped and settled! Traders can now redeem winnings.\n"));
  } catch (err) {
    logError(`Failed to settle market:`, err.message);
    process.exit(1);
  }
}

/* ---------------- Run ---------------- */
main().catch((err) => {
  logError("Fatal error:", err);
  process.exit(1);
});
