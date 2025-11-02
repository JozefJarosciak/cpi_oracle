#!/usr/bin/env node
// Test script for slippage-protected transactions on X1 testnet

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
  m: (s) => `\x1b[35m${s}\x1b[0m`,
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

// Find discriminator for instruction
function getInstructionDiscriminator(name) {
  const instruction = idl.instructions.find(ix => ix.name === name);
  if (!instruction) throw new Error(`Instruction ${name} not found in IDL`);
  return Buffer.from(instruction.discriminator);
}

// Encode trade_with_slippage instruction
// Layout: disc(8) + side(1) + action(1) + amount(8) + max_slippage_bps(2)
function encodeTradeWithSlippage(side, action, amount, maxSlippageBps) {
  const discriminator = getInstructionDiscriminator("trade_with_slippage");
  const buf = Buffer.alloc(8 + 1 + 1 + 8 + 2);

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

  // Write max_slippage_bps as u16 (little endian)
  buf.writeUInt16LE(maxSlippageBps, offset);

  return buf;
}

async function main() {
  console.log(C.bold(C.c("=".repeat(60))));
  console.log(C.bold(C.c("Slippage Protection Test - X1 Testnet")));
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
  console.log(C.bold("Running slippage protection tests..."));
  console.log("");

  // Test 1: BUY YES with generous slippage (10% = 1000 bps) - should succeed
  console.log(C.bold("Test 1: BUY YES with 10% slippage tolerance"));
  try {
    const amount = 500_000; // 0.5 shares
    const maxSlippageBps = 1000; // 10%

    const data = encodeTradeWithSlippage(SIDE_YES, ACTION_BUY, amount, maxSlippageBps);

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

  // Test 2: BUY YES with very tight slippage (0.1% = 10 bps) - might fail
  console.log(C.bold("Test 2: BUY YES with tight 0.1% slippage tolerance"));
  try {
    const amount = 500_000; // 0.5 shares
    const maxSlippageBps = 10; // 0.1% - very tight

    const data = encodeTradeWithSlippage(SIDE_YES, ACTION_BUY, amount, maxSlippageBps);

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
    if (err.message.includes("SlippageExceeded") || err.logs?.some(log => log.includes("SlippageExceeded") || log.includes("PriceLimitExceeded"))) {
      console.log(C.y("  ⚠ Correctly rejected with slippage/price limit exceeded"));
    } else {
      console.error(C.y(`  ⚠ Test 2 failed with unexpected error: ${err.message}`));
      if (err.logs) {
        console.log("  Logs:");
        err.logs.forEach(log => console.log(`    ${log}`));
      }
    }
  }

  console.log("");

  // Test 3: BUY with no slippage protection (0 bps)
  console.log(C.bold("Test 3: BUY YES with no slippage protection"));
  try {
    const amount = 300_000; // 0.3 shares
    const maxSlippageBps = 0; // No protection

    const data = encodeTradeWithSlippage(SIDE_YES, ACTION_BUY, amount, maxSlippageBps);

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

  // Test 4: SELL YES with 5% slippage tolerance
  console.log(C.bold("Test 4: SELL YES with 5% slippage tolerance"));
  try {
    const amount = 200_000; // 0.2 shares
    const maxSlippageBps = 500; // 5%

    const data = encodeTradeWithSlippage(SIDE_YES, ACTION_SELL, amount, maxSlippageBps);

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
    console.error(C.r(`  ✗ Test 4 failed: ${err.message}`));
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
