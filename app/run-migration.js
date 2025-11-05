#!/usr/bin/env node
// app/run-migration.js - Run position migration v1 to v2

const anchor = require('@coral-xyz/anchor');
const { Connection, PublicKey, Keypair, SystemProgram } = require('@solana/web3.js');
const fs = require('fs');

const RPC = process.env.ANCHOR_PROVIDER_URL || 'https://rpc.testnet.x1.xyz';
const PID = new PublicKey('EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF');
const AMM_SEED = Buffer.from('amm_btc_v6');
const POS_SEED = Buffer.from('pos');
const USER_VAULT_SEED = Buffer.from('user_vault');

function getAmmPda() {
  const [pda] = PublicKey.findProgramAddressSync([AMM_SEED], PID);
  return pda;
}

function getPositionPda(amm, user) {
  const [pda] = PublicKey.findProgramAddressSync(
    [POS_SEED, amm.toBuffer(), user.toBuffer()],
    PID
  );
  return pda;
}

function getUserVaultPda(position) {
  const [pda] = PublicKey.findProgramAddressSync(
    [USER_VAULT_SEED, position.toBuffer()],
    PID
  );
  return pda;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log('Usage: node app/run-migration.js <session_wallet.json> <master_wallet_pubkey>');
    console.log('');
    console.log('Example:');
    console.log('  node app/run-migration.js ./userA.json GxZpS8cU8vJWPbFmH3qT9yKjN4xM5rLvE2uDqY8wXqAf');
    console.log('');
    console.log('This will:');
    console.log('  1. Read the old 97-byte position account');
    console.log('  2. Transfer vault balance to the master wallet (Backpack)');
    console.log('  3. Close the old position account');
    console.log('  4. You can then reinitialize with: ANCHOR_WALLET=<wallet> node app/trade.js init-pos');
    process.exit(1);
  }

  const sessionWalletPath = args[0];
  const masterWalletPubkey = new PublicKey(args[1]);

  const sessionWallet = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(sessionWalletPath, 'utf8')))
  );

  const connection = new Connection(RPC, 'confirmed');
  const ammPda = getAmmPda();
  const positionPda = getPositionPda(ammPda, sessionWallet.publicKey);
  const userVaultPda = getUserVaultPda(positionPda);

  console.log('🔄 Position Migration Tool');
  console.log('━'.repeat(60));
  console.log(`RPC:            ${RPC}`);
  console.log(`Session Wallet: ${sessionWallet.publicKey.toString()}`);
  console.log(`Master Wallet:  ${masterWalletPubkey.toString()}`);
  console.log(`AMM:            ${ammPda.toString()}`);
  console.log(`Position:       ${positionPda.toString()}`);
  console.log(`User Vault:     ${userVaultPda.toString()}`);
  console.log('━'.repeat(60));

  // Check if position exists
  const positionInfo = await connection.getAccountInfo(positionPda);
  if (!positionInfo) {
    console.log('\n❌ Position account does not exist. Nothing to migrate.');
    console.log(`   Initialize with: ANCHOR_WALLET=${sessionWalletPath} node app/trade.js init-pos`);
    process.exit(0);
  }

  console.log(`\n📊 Current Position Account:`);
  console.log(`   Size: ${positionInfo.data.length} bytes`);
  console.log(`   Owner: ${positionInfo.owner.toString()}`);
  console.log(`   Lamports: ${positionInfo.lamports}`);

  if (positionInfo.data.length === 901) {
    console.log('\n✅ Position is already migrated to new layout (901 bytes).');
    console.log('   No migration needed!');
    process.exit(0);
  }

  if (positionInfo.data.length !== 97) {
    console.log(`\n⚠️  Warning: Unexpected position size (${positionInfo.data.length} bytes)`);
    console.log('   Expected 97 bytes (old) or 901 bytes (new)');
    console.log('   Proceeding anyway...');
  }

  // Parse old layout to show user what will be migrated
  const data = positionInfo.data;
  const vaultBalanceE6 = data.readBigInt64LE(88);
  const yesSharesE6 = data.readBigInt64LE(40);
  const noSharesE6 = data.readBigInt64LE(48);

  console.log(`\n📦 Position Details (Old Layout):`);
  console.log(`   YES shares: ${yesSharesE6.toString()} e6 (${Number(yesSharesE6) / 1e6})`);
  console.log(`   NO shares:  ${noSharesE6.toString()} e6 (${Number(noSharesE6) / 1e6})`);
  console.log(`   Vault balance: ${vaultBalanceE6.toString()} e6 (${Number(vaultBalanceE6) / 1e6} XNT)`);

  if (yesSharesE6 !== 0n || noSharesE6 !== 0n) {
    console.log('\n⚠️  WARNING: Position has shares!');
    console.log('   These shares will be LOST after migration!');
    console.log('   Consider redeeming or closing positions first.');
    console.log('');
  }

  if (vaultBalanceE6 > 0n) {
    console.log(`\n💰 Vault balance will be transferred to master wallet:`);
    console.log(`   Amount: ${Number(vaultBalanceE6) / 1e6} XNT`);
    console.log(`   To: ${masterWalletPubkey.toString()}`);
  }

  console.log('\n⚠️  Ready to migrate. Press Ctrl+C to cancel, or Enter to continue...');
  await new Promise(resolve => {
    process.stdin.once('data', resolve);
  });

  // Load IDL and create program
  const idl = JSON.parse(fs.readFileSync('target/idl/cpi_oracle.json', 'utf8'));
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(sessionWallet),
    { commitment: 'confirmed' }
  );
  const program = new anchor.Program(idl, provider);

  console.log('\n🚀 Executing migration transaction...');

  try {
    const tx = await program.methods
      .migratePositionV1ToV2()
      .accountsStrict({
        amm: ammPda,
        owner: sessionWallet.publicKey,
        masterWallet: masterWalletPubkey,
        oldPosition: positionPda,
        userVault: userVaultPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log(`\n✅ Migration successful!`);
    console.log(`   Transaction: ${tx}`);
    console.log(`   View: https://explorer.testnet.x1.xyz/tx/${tx}`);

    // Wait for confirmation
    await connection.confirmTransaction(tx, 'confirmed');

    console.log('\n📋 Next Steps:');
    console.log(`   1. Vault balance has been transferred to ${masterWalletPubkey.toString()}`);
    console.log(`   2. Old position account has been closed`);
    console.log(`   3. Reinitialize new position with:`);
    console.log(`      ANCHOR_WALLET=${sessionWalletPath} node app/trade.js init-pos`);

  } catch (err) {
    console.error('\n❌ Migration failed:', err.message);
    if (err.logs) {
      console.error('\nTransaction logs:');
      err.logs.forEach(log => console.error('  ', log));
    }
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
