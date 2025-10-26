#!/usr/bin/env node
// Test script for admin_redeem functionality

const fs = require("fs");
const crypto = require("crypto");
const {
  Connection, PublicKey, Keypair, SystemProgram,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
  ComputeBudgetProgram, SYSVAR_RENT_PUBKEY,
} = require("@solana/web3.js");

/* ---------------- CONFIG ---------------- */
const RPC = process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899";
const ADMIN_WALLET = process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/id.json`;
const ORACLE_STATE = new PublicKey(process.env.ORACLE_STATE || "4KYeNyv1B9YjjQkfJk2C6Uqo71vKzFZriRe5NXg6GyCq");

const PID = new PublicKey("EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF");
const AMM_SEED = Buffer.from("amm_btc_v3");
const VAULT_SOL_SEED = Buffer.from("vault_sol");
const POS_SEED = Buffer.from("pos");

/* ---------------- Helpers ---------------- */
function sha256(data) {
  return crypto.createHash("sha256").update(data).digest();
}

function discriminator(ixName) {
  const preimage = `global:${ixName}`;
  return sha256(Buffer.from(preimage, "utf8")).slice(0, 8);
}

/* ---------------- Main Test ---------------- */
async function main() {
  console.log("\n╔═══════════════════════════════════════════════╗");
  console.log("║     TESTING ADMIN_REDEEM FUNCTIONALITY       ║");
  console.log("╚═══════════════════════════════════════════════╝\n");

  // Load admin wallet
  const adminKp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(ADMIN_WALLET, "utf8"))));
  console.log(`Admin: ${adminKp.publicKey.toString()}`);

  // Connect
  const conn = new Connection(RPC, "confirmed");
  console.log(`RPC: ${RPC}\n`);

  // Derive PDAs
  const [ammPda] = PublicKey.findProgramAddressSync([AMM_SEED], PID);
  const [vaultPda] = PublicKey.findProgramAddressSync([VAULT_SOL_SEED, ammPda.toBuffer()], PID);

  console.log(`AMM PDA: ${ammPda.toString()}`);
  console.log(`Vault PDA: ${vaultPda.toString()}\n`);

  // Check if AMM exists and is settled
  const ammInfo = await conn.getAccountInfo(ammPda);
  if (!ammInfo) {
    console.log("❌ AMM account not found. Run a market cycle first.");
    return;
  }

  const ammData = ammInfo.data;
  const status = ammData.readUInt8(8 + 1 + 1 + 8 + 2 + 8 + 8 + 8 + 8);
  const statusNames = ["Open", "Stopped", "Settled"];
  console.log(`Market Status: ${statusNames[status] || "Unknown"}`);

  // Read fee_dest from AMM
  let ammOffset = 8 + 1 + 1 + 8 + 2 + 8 + 8 + 8 + 8 + 1 + 1 + 8 + 8;
  const feeDestBytes = ammData.slice(ammOffset, ammOffset + 32);
  const feeDest = new PublicKey(feeDestBytes);
  console.log(`Fee Dest: ${feeDest.toString()}`);

  // Try to find the fee_dest wallet
  let feeDestKp = adminKp;
  if (!feeDest.equals(adminKp.publicKey)) {
    console.log(`⚠️  Admin wallet doesn't match fee_dest`);
    console.log(`   Trying to find fee_dest wallet...\n`);

    // Try common wallet locations
    const walletPaths = [
      './operator.json',
      './fees.json',
      './userA.json',
      './userB.json',
      './userC.json',
      './userD.json',
      './userE.json',
      `${process.env.HOME}/.config/solana/id.json`
    ];

    let found = false;
    for (const path of walletPaths) {
      try {
        if (fs.existsSync(path)) {
          const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8"))));
          if (kp.publicKey.equals(feeDest)) {
            feeDestKp = kp;
            found = true;
            console.log(`✅ Found fee_dest wallet: ${path}`);
            break;
          }
        }
      } catch (e) {
        // Skip invalid files
      }
    }

    if (!found) {
      console.log(`❌ Could not find wallet for fee_dest: ${feeDest.toString()}`);
      console.log(`   Admin redeem requires fee_dest private key`);
      return;
    }
  }

  console.log(`Admin (fee_dest): ${feeDestKp.publicKey.toString()}\n`);

  if (status !== 2) {
    console.log("❌ Market not settled. Cannot test admin_redeem.");
    return;
  }

  // Find all positions
  console.log("\n📊 Scanning for positions...");
  const positions = await conn.getProgramAccounts(PID, {
    filters: [{ dataSize: 8 + 32 + 8 + 8 }],
  });

  console.log(`Found ${positions.length} position accounts\n`);

  if (positions.length === 0) {
    console.log("❌ No positions found. Create some positions first.");
    return;
  }

  // Find a position with non-zero shares that matches PDA derivation
  let testPos = null;
  let owner = null;
  let yesShares = 0;
  let noShares = 0;

  for (const pos of positions) {
    const posData = pos.account.data;
    let offset = 8; // Skip discriminator
    const ownerBytes = posData.slice(offset, offset + 32);
    const posOwner = new PublicKey(ownerBytes);
    offset += 32;

    const yes = Number(posData.readBigInt64LE(offset)); offset += 8;
    const no = Number(posData.readBigInt64LE(offset));

    // Check if PDA matches expected derivation
    const [expectedPda] = PublicKey.findProgramAddressSync(
      [POS_SEED, ammPda.toBuffer(), posOwner.toBuffer()],
      PID
    );

    if (expectedPda.equals(pos.pubkey) && (yes > 0 || no > 0)) {
      testPos = pos;
      owner = posOwner;
      yesShares = yes;
      noShares = no;
      break;
    }
  }

  if (!testPos) {
    console.log("❌ No valid positions with shares found (or PDA mismatch).");
    return;
  }

  console.log(`Testing position for user: ${owner.toString()}`);
  console.log(`  Position PDA: ${testPos.pubkey.toString()}`);
  console.log(`  YES shares: ${(yesShares / 1_000_000).toFixed(2)}`);
  console.log(`  NO shares: ${(noShares / 1_000_000).toFixed(2)}\n`);

  // Derive the position PDA (should match)
  const [expectedPosPda] = PublicKey.findProgramAddressSync(
    [POS_SEED, ammPda.toBuffer(), owner.toBuffer()],
    PID
  );
  console.log(`PDA derivation: ✅ Match confirmed\n`);

  // Get user balance before
  const userBalBefore = await conn.getBalance(owner);
  console.log(`User balance before: ${(userBalBefore / 1e9).toFixed(4)} SOL`);

  // Call admin_redeem
  console.log("\n🔧 Calling admin_redeem...");

  const redeemIx = new TransactionInstruction({
    programId: PID,
    keys: [
      { pubkey: ammPda, isSigner: false, isWritable: true },
      { pubkey: feeDestKp.publicKey, isSigner: true, isWritable: true }, // Admin (must match fee_dest)
      { pubkey: owner, isSigner: false, isWritable: true }, // User (receives payout)
      { pubkey: expectedPosPda, isSigner: false, isWritable: true }, // Position (use derived PDA)
      { pubkey: feeDest, isSigner: false, isWritable: true }, // fee_dest from AMM
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: discriminator("admin_redeem"),
  });

  const budgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 });
  const tx = new Transaction().add(budgetIx, redeemIx);

  try {
    const sig = await sendAndConfirmTransaction(conn, tx, [feeDestKp], { skipPreflight: false });
    console.log(`✅ Success! Tx: ${sig}\n`);

    // Check user balance after
    await new Promise(r => setTimeout(r, 1000));
    const userBalAfter = await conn.getBalance(owner);
    const payout = (userBalAfter - userBalBefore) / 1e9;
    console.log(`User balance after: ${(userBalAfter / 1e9).toFixed(4)} SOL`);
    console.log(`Payout: ${payout.toFixed(4)} SOL`);

    // Check position is wiped
    const posAfter = await conn.getAccountInfo(expectedPosPda);
    if (posAfter) {
      const posDataAfter = posAfter.data;
      let o = 8 + 32;
      const yesAfter = Number(posDataAfter.readBigInt64LE(o)); o += 8;
      const noAfter = Number(posDataAfter.readBigInt64LE(o));
      console.log(`\nPosition after redeem:`);
      console.log(`  YES shares: ${(yesAfter / 1_000_000).toFixed(2)}`);
      console.log(`  NO shares: ${(noAfter / 1_000_000).toFixed(2)}`);

      if (yesAfter === 0 && noAfter === 0) {
        console.log("\n✅ Position successfully wiped!");
      }
    }

  } catch (err) {
    console.log(`❌ Error: ${err.message}`);
    if (err.logs) {
      console.log("\nProgram logs:");
      err.logs.forEach(log => console.log(`  ${log}`));
    }
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
