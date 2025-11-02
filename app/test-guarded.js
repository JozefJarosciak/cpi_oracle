#!/usr/bin/env node
// Test script for guarded transactions (limit orders) on X1 testnet

const fs = require("fs");
const {
  Connection, PublicKey, Keypair, SystemProgram,
  Transaction, TransactionInstruction,
  ComputeBudgetProgram, SYSVAR_RENT_PUBKEY,
} = require("@solana/web3.js");
const { BN } = require("bn.js");

// Configuration
const RPC = process.env.ANCHOR_PROVIDER_URL || "https://rpc.testnet.x1.xyz";
const WALLET = process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/id.json`;
const PID = new PublicKey("EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF");
const AMM_SEED = Buffer.from("amm_btc_v6");
const POS_SEED = Buffer.from("pos");
const VAULT_SOL_SEED = Buffer.from("vault_sol");
const USER_VAULT_SEED = Buffer.from("user_vault");

// Oracle state on testnet
const ORACLE_STATE = new PublicKey("4KYeNyv1B9YjjQkfJk2C6Uqo71vKzFZriRe5NXg6GyCq");

// Trade constants
const SIDE_YES = 1;
const SIDE_NO = 2;
const ACTION_BUY = 1;
const ACTION_SELL = 2;

// Load IDL for instruction encoding
const idl = JSON.parse(fs.readFileSync("./target/idl/cpi_oracle.json", "utf8"));

// Colors
const C = {
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  c: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

// Helper functions
function readKeypair(path) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8"))));
}

function ammPda() {
  return PublicKey.findProgramAddressSync([AMM_SEED], PID)[0];
}

function posPda(owner, amm) {
  return PublicKey.findProgramAddressSync([POS_SEED, amm.toBuffer(), owner.toBuffer()], PID)[0];
}

function vaultSolPda(amm) {
  return PublicKey.findProgramAddressSync([VAULT_SOL_SEED, amm.toBuffer()], PID)[0];
}

function userVaultPda(pos) {
  return PublicKey.findProgramAddressSync([USER_VAULT_SEED, pos.toBuffer()], PID)[0];
}

// Find discriminator for trade_guarded instruction
function getInstructionDiscriminator(name) {
  const instruction = idl.instructions.find(ix => ix.name === name);
  if (!instruction) throw new Error(`Instruction ${name} not found in IDL`);
  return Buffer.from(instruction.discriminator);
}

// Encode trade_guarded instruction
function encodeTradeGuarded(side, action, amount, priceLimitE6) {
  const discriminator = getInstructionDiscriminator("trade_guarded");
  const buf = Buffer.alloc(8 + 1 + 1 + 8 + 8); // disc(8) + side(1) + action(1) + amount(8) + price_limit(8)

  let offset = 0;
  discriminator.copy(buf, offset);
  offset += 8;

  buf.writeUInt8(side, offset);
  offset += 1;

  buf.writeUInt8(action, offset);
  offset += 1;

  // Write amount as i64 (little endian)
  const amountBN = new BN(amount);
  amountBN.toArrayLike(Buffer, "le", 8).copy(buf, offset);
  offset += 8;

  // Write price_limit_e6 as i64 (little endian)
  const limitBN = new BN(priceLimitE6);
  limitBN.toArrayLike(Buffer, "le", 8).copy(buf, offset);

  return buf;
}

async function main() {
  console.log(C.bold(C.c("=".repeat(60))));
  console.log(C.bold(C.c("Guarded Transactions Test - X1 Testnet")));
  console.log(C.bold(C.c("=".repeat(60))));
  console.log("");

  // Connect to testnet
  const connection = new Connection(RPC, "confirmed");
  console.log(C.g("✓ Connected to X1 testnet"));

  // Load wallet
  const payer = readKeypair(WALLET);
  console.log(C.g(`✓ Loaded wallet: ${payer.publicKey.toBase58()}`));

  // Check balance
  const balance = await connection.getBalance(payer.publicKey);
  console.log(C.g(`✓ Balance: ${(balance / 1e9).toFixed(4)} SOL`));
  console.log("");

  // Get PDAs
  const amm = ammPda();
  const pos = posPda(payer.publicKey, amm);
  const vaultSol = vaultSolPda(amm);
  const userVault = userVaultPda(pos);

  console.log("PDAs:");
  console.log(`  AMM: ${amm.toBase58()}`);
  console.log(`  Position: ${pos.toBase58()}`);
  console.log(`  Vault SOL: ${vaultSol.toBase58()}`);
  console.log(`  User Vault: ${userVault.toBase58()}`);
  console.log("");

  // Check if AMM exists and fetch fee_dest
  let feeDest;
  try {
    const ammAccount = await connection.getAccountInfo(amm);
    if (!ammAccount) {
      console.log(C.y("⚠ AMM account not found. You need to initialize the market first."));
      console.log(C.y("  Run: ANCHOR_WALLET=<wallet> node app/trade.js init 500 25"));
      process.exit(1);
    }
    console.log(C.g("✓ AMM account exists"));

    // Parse AMM account to get fee_dest
    // AMM borsh layout (no padding):
    // disc(8) + bump(1) + decimals(1) + b(8) + fee_bps(2) + q_yes(8) + q_no(8) + fees(8) + vault_e6(8) + status(1) + winner(1) + w_total_e6(8) + pps_e6(8) + fee_dest(32)
    const data = ammAccount.data;
    const feeDestOffset = 8 + 1 + 1 + 8 + 2 + 8 + 8 + 8 + 8 + 1 + 1 + 8 + 8; // = 70
    feeDest = new PublicKey(data.slice(feeDestOffset, feeDestOffset + 32));
    console.log(C.g(`✓ Fee destination: ${feeDest.toBase58()}`));
  } catch (err) {
    console.error(C.r(`✗ Error checking AMM: ${err.message}`));
    process.exit(1);
  }

  // Check if position exists
  try {
    const posAccount = await connection.getAccountInfo(pos);
    if (!posAccount) {
      console.log(C.y("⚠ Position account not found. You need to initialize your position first."));
      console.log(C.y("  Run: ANCHOR_WALLET=<wallet> node app/trade.js init-pos"));
      process.exit(1);
    }
    console.log(C.g("✓ Position account exists"));
  } catch (err) {
    console.error(C.r(`✗ Error checking position: ${err.message}`));
    process.exit(1);
  }

  console.log("");
  console.log(C.bold("Running guarded transaction tests..."));
  console.log("");

  // Test 1: BUY YES with high limit (should succeed)
  console.log(C.bold("Test 1: BUY YES with high price limit ($0.90)"));
  try {
    const amount = 1_000_000; // 1 share
    const priceLimit = 900_000; // $0.90 per share

    const data = encodeTradeGuarded(SIDE_YES, ACTION_BUY, amount, priceLimit);

    const ix = new TransactionInstruction({
      programId: PID,
      keys: [
        { pubkey: amm, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: pos, isSigner: false, isWritable: true },
        { pubkey: userVault, isSigner: false, isWritable: true },
        { pubkey: feeDest, isSigner: false, isWritable: true },
        { pubkey: vaultSol, isSigner: false, isWritable: true },
        { pubkey: ORACLE_STATE, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ix
    );

    const sig = await connection.sendTransaction(tx, [payer], {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });

    await connection.confirmTransaction(sig, "confirmed");
    console.log(C.g(`  ✓ Transaction succeeded: ${sig}`));
    console.log(C.g(`  Explorer: https://explorer.testnet.x1.xyz/tx/${sig}`));
  } catch (err) {
    console.error(C.r(`  ✗ Test 1 failed: ${err.message}`));
    if (err.logs) {
      console.log("  Logs:");
      err.logs.forEach(log => console.log(`    ${log}`));
    }
  }

  console.log("");

  // Test 2: BUY YES with very low limit (should fail with PriceLimitExceeded)
  console.log(C.bold("Test 2: BUY YES with low price limit ($0.10) - should reject"));
  try {
    const amount = 1_000_000; // 1 share
    const priceLimit = 100_000; // $0.10 per share (too low)

    const data = encodeTradeGuarded(SIDE_YES, ACTION_BUY, amount, priceLimit);

    const ix = new TransactionInstruction({
      programId: PID,
      keys: [
        { pubkey: amm, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: pos, isSigner: false, isWritable: true },
        { pubkey: userVault, isSigner: false, isWritable: true },
        { pubkey: feeDest, isSigner: false, isWritable: true },
        { pubkey: vaultSol, isSigner: false, isWritable: true },
        { pubkey: ORACLE_STATE, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ix
    );

    const sig = await connection.sendTransaction(tx, [payer], {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });

    await connection.confirmTransaction(sig, "confirmed");
    console.log(C.r(`  ✗ Test 2 should have failed but succeeded: ${sig}`));
  } catch (err) {
    if (err.message.includes("PriceLimitExceeded") || err.logs?.some(log => log.includes("PriceLimitExceeded"))) {
      console.log(C.g("  ✓ Correctly rejected with PriceLimitExceeded"));
    } else {
      console.error(C.y(`  ⚠ Test 2 failed with unexpected error: ${err.message}`));
      if (err.logs) {
        console.log("  Logs:");
        err.logs.forEach(log => console.log(`    ${log}`));
      }
    }
  }

  console.log("");

  // Test 3: BUY with no limit (price_limit_e6 = 0)
  console.log(C.bold("Test 3: BUY YES with no price limit"));
  try {
    const amount = 500_000; // 0.5 shares
    const priceLimit = 0; // No limit

    const data = encodeTradeGuarded(SIDE_YES, ACTION_BUY, amount, priceLimit);

    const ix = new TransactionInstruction({
      programId: PID,
      keys: [
        { pubkey: amm, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: pos, isSigner: false, isWritable: true },
        { pubkey: userVault, isSigner: false, isWritable: true },
        { pubkey: feeDest, isSigner: false, isWritable: true },
        { pubkey: vaultSol, isSigner: false, isWritable: true },
        { pubkey: ORACLE_STATE, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ix
    );

    const sig = await connection.sendTransaction(tx, [payer], {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });

    await connection.confirmTransaction(sig, "confirmed");
    console.log(C.g(`  ✓ Transaction succeeded: ${sig}`));
    console.log(C.g(`  Explorer: https://explorer.testnet.x1.xyz/tx/${sig}`));
  } catch (err) {
    console.error(C.r(`  ✗ Test 3 failed: ${err.message}`));
    if (err.logs) {
      console.log("  Logs:");
      err.logs.forEach(log => console.log(`    ${log}`));
    }
  }

  console.log("");
  console.log(C.bold(C.c("=".repeat(60))));
  console.log(C.bold(C.g("Tests complete!")));
  console.log(C.bold(C.c("=".repeat(60))));
}

main().catch(err => {
  console.error(C.r(`Fatal error: ${err.message}`));
  console.error(err.stack);
  process.exit(1);
});
