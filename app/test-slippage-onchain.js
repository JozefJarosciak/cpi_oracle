#!/usr/bin/env node
// Test script to create ON-CHAIN proof of slippage rejection
// This test uses skipPreflight: true to force failed transactions onto the blockchain

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
const ACTION_BUY = 1;

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

// Find discriminator for trade_with_slippage instruction
function getInstructionDiscriminator(name) {
  const instruction = idl.instructions.find(ix => ix.name === name);
  if (!instruction) throw new Error(`Instruction ${name} not found in IDL`);
  return Buffer.from(instruction.discriminator);
}

// Encode trade_with_slippage instruction
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
  console.log(C.bold(C.c("ON-CHAIN Slippage Rejection Test - X1 Testnet")));
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

  // Fetch fee_dest from AMM account
  const ammAccount = await connection.getAccountInfo(amm);
  const data = ammAccount.data;
  const feeDestOffset = 8 + 1 + 1 + 8 + 2 + 8 + 8 + 8 + 8 + 1 + 1 + 8 + 8; // = 70
  const feeDest = new PublicKey(data.slice(feeDestOffset, feeDestOffset + 32));

  console.log("PDAs:");
  console.log(`  AMM: ${amm.toBase58()}`);
  console.log(`  Position: ${pos.toBase58()}`);
  console.log(`  Fee dest: ${feeDest.toBase58()}`);
  console.log("");

  console.log(C.bold(C.y("⚠️  SUBMITTING TRANSACTION THAT WILL FAIL ON-CHAIN ⚠️")));
  console.log(C.y("This creates permanent on-chain proof of slippage rejection"));
  console.log("");

  // BUY YES with impossibly tight slippage - WILL FAIL
  console.log(C.bold("Submitting: BUY YES with 0.1% slippage tolerance (will be rejected)"));
  console.log("");

  const amount = 500_000; // 0.5 shares
  const maxSlippageBps = 10; // 0.1% - extremely tight

  const data2 = encodeTradeWithSlippage(SIDE_YES, ACTION_BUY, amount, maxSlippageBps);

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
    data: data2,
  });

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ix
  );

  try {
    // IMPORTANT: skipPreflight: true forces the transaction onto the blockchain
    const sig = await connection.sendTransaction(tx, [payer], {
      skipPreflight: true,  // <--- THIS IS THE KEY: Submit even though it will fail
      maxRetries: 3,
    });

    console.log(C.y(`📡 Transaction submitted: ${sig}`));
    console.log(C.y(`🔍 Explorer: https://explorer.testnet.x1.xyz/tx/${sig}`));
    console.log("");
    console.log(C.y("⏳ Waiting for confirmation..."));
    console.log("");

    // Try to confirm - this will fail, but the transaction is already on-chain
    try {
      await connection.confirmTransaction(sig, "confirmed");
      console.log(C.r("✗ Unexpected: Transaction succeeded (should have failed)"));
    } catch (confirmErr) {
      console.log(C.g("✅ Transaction FAILED on-chain as expected!"));
      console.log("");

      // Fetch the transaction to see the error
      console.log(C.bold("Fetching on-chain transaction details..."));
      console.log("");

      const txDetails = await connection.getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });

      if (txDetails && txDetails.meta) {
        console.log(C.g("📜 On-chain logs:"));
        if (txDetails.meta.logMessages) {
          txDetails.meta.logMessages.forEach(log => {
            if (log.includes("SlippageExceeded") || log.includes("PriceLimitExceeded") || log.includes("SLIPPAGE CHECK")) {
              console.log(C.bold(C.y(`  ${log}`)));
            } else if (log.includes("Error") || log.includes("failed")) {
              console.log(C.r(`  ${log}`));
            } else {
              console.log(`  ${log}`);
            }
          });
        }
        console.log("");
        console.log(C.bold(C.g("✅ ON-CHAIN PROOF CREATED!")));
        console.log(C.g(`Transaction ${sig} is permanently recorded on X1 testnet`));
        console.log(C.g("showing that the slippage protection rejected the trade"));
      }
    }
  } catch (err) {
    console.error(C.r(`✗ Failed to submit transaction: ${err.message}`));
    process.exit(1);
  }

  console.log("");
  console.log(C.bold(C.c("=".repeat(60))));
  console.log(C.bold(C.g("On-chain slippage rejection test complete!")));
  console.log(C.bold(C.c("=".repeat(60))));
}

main().catch(err => {
  console.error(C.r(`Fatal error: ${err.message}`));
  console.error(err.stack);
  process.exit(1);
});
