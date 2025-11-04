#!/usr/bin/env ts-node
// app/keeper.ts — Keeper bot for executing dark pool limit orders

import * as fs from 'fs';
import * as path from 'path';
import * as anchor from '@coral-xyz/anchor';
import { Connection, PublicKey, Keypair, SystemProgram, Transaction, ComputeBudgetProgram, SYSVAR_INSTRUCTIONS_PUBKEY, TransactionInstruction } from '@solana/web3.js';
import axios from 'axios';
import * as borsh from '@coral-xyz/borsh';

/* ==================== CONFIG ==================== */
// Load config from file if it exists, otherwise use defaults
interface KeeperConfig {
  rpc?: string;
  orderbookApi?: string;
  keeperWallet?: string;
  pollIntervalMs?: number;
  keeperFeeBps?: number;
}

function loadConfig(): KeeperConfig {
  const configPath = path.join(__dirname, '..', 'keeper.config.json');
  try {
    if (fs.existsSync(configPath)) {
      const configData = fs.readFileSync(configPath, 'utf8');
      return JSON.parse(configData);
    }
  } catch (err) {
    console.warn('⚠️  Failed to load keeper.config.json, using defaults');
  }
  return {};
}

const config = loadConfig();
const RPC = process.env.ANCHOR_PROVIDER_URL || config.rpc || 'http://127.0.0.1:8899';
const KEEPER_WALLET = process.env.KEEPER_WALLET || process.env.ANCHOR_WALLET || config.keeperWallet || `${process.env.HOME}/.config/solana/id.json`;
const ORDER_BOOK_API = process.env.ORDER_BOOK_API || config.orderbookApi || 'http://localhost:3000';
const CHECK_INTERVAL = parseInt(process.env.KEEPER_CHECK_INTERVAL || String(config.pollIntervalMs || 2000)); // ms
const MIN_PROFIT_LAMPORTS = parseInt(process.env.KEEPER_MIN_PROFIT || '100000'); // 0.0001 SOL

// Program IDs
const PID = new PublicKey('EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF');
const AMM_SEED = Buffer.from('amm_btc_v6');
const POS_SEED = Buffer.from('pos');
const VAULT_SOL_SEED = Buffer.from('vault_sol');
const USER_VAULT_SEED = Buffer.from('user_vault');

/* ==================== TYPES ==================== */
interface LimitOrder {
  market: string;
  user: string;
  action: number; // 1=BUY, 2=SELL
  side: number;   // 1=YES, 2=NO
  shares_e6: number;
  limit_price_e6: number;
  max_cost_e6: number;
  min_proceeds_e6: number;
  expiry_ts: number;
  nonce: number;
  keeper_fee_bps: number;
  min_fill_bps: number;
}

interface OrderData {
  order_id: number;
  order_hash: string;
  order: LimitOrder;
  signature: string;
  submitted_at: string;
}

interface PendingOrdersResponse {
  orders: OrderData[];
}

interface AmmAccount {
  bump: number;
  decimals: number;
  b: anchor.BN;
  feeBps: number;
  qYes: anchor.BN;
  qNo: anchor.BN;
  fees: anchor.BN;
  vaultE6: anchor.BN;
  status: number;
  winner: number;
  wTotalE6: anchor.BN;
  ppsE6: anchor.BN;
  feeDest: PublicKey;
  vaultSolBump: number;
  startPriceE6: anchor.BN;
  startTs: anchor.BN;
  settlePriceE6: anchor.BN;
  settleTs: anchor.BN;
  marketEndSlot: anchor.BN;
  marketEndTime: anchor.BN;
}

/* ==================== HELPERS ==================== */
function loadKeeper(path: string): Keypair {
  const rawKey = JSON.parse(fs.readFileSync(path, 'utf8'));
  return Keypair.fromSecretKey(Uint8Array.from(rawKey));
}

function getAmmPda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([AMM_SEED], PID);
  return pda;
}

function getPositionPda(amm: PublicKey, user: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [POS_SEED, amm.toBuffer(), user.toBuffer()],
    PID
  );
  return pda;
}

function getVaultPda(amm: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [VAULT_SOL_SEED, amm.toBuffer()],
    PID
  );
  return pda;
}

function getUserVaultPda(position: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [USER_VAULT_SEED, position.toBuffer()],
    PID
  );
  return pda;
}

function serializeOrder(order: any): Buffer {
  // Serialize LimitOrder struct to match Rust Borsh encoding
  // Order must match Rust struct field order exactly
  const buffers: Buffer[] = [];

  // market: Pubkey (32 bytes)
  buffers.push(order.market.toBuffer());

  // user: Pubkey (32 bytes)
  buffers.push(order.user.toBuffer());

  // action: u8 (1 byte)
  const actionBuf = Buffer.alloc(1);
  actionBuf.writeUInt8(order.action);
  buffers.push(actionBuf);

  // side: u8 (1 byte)
  const sideBuf = Buffer.alloc(1);
  sideBuf.writeUInt8(order.side);
  buffers.push(sideBuf);

  // shares_e6: i64 (8 bytes, little-endian)
  const sharesBuf = Buffer.alloc(8);
  sharesBuf.writeBigInt64LE(BigInt(order.sharesE6.toString()));
  buffers.push(sharesBuf);

  // limit_price_e6: i64 (8 bytes, little-endian)
  const limitPriceBuf = Buffer.alloc(8);
  limitPriceBuf.writeBigInt64LE(BigInt(order.limitPriceE6.toString()));
  buffers.push(limitPriceBuf);

  // max_cost_e6: i64 (8 bytes, little-endian)
  const maxCostBuf = Buffer.alloc(8);
  maxCostBuf.writeBigInt64LE(BigInt(order.maxCostE6.toString()));
  buffers.push(maxCostBuf);

  // min_proceeds_e6: i64 (8 bytes, little-endian)
  const minProceedsBuf = Buffer.alloc(8);
  minProceedsBuf.writeBigInt64LE(BigInt(order.minProceedsE6.toString()));
  buffers.push(minProceedsBuf);

  // expiry_ts: i64 (8 bytes, little-endian)
  const expiryBuf = Buffer.alloc(8);
  expiryBuf.writeBigInt64LE(BigInt(order.expiryTs.toString()));
  buffers.push(expiryBuf);

  // nonce: u64 (8 bytes, little-endian)
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(order.nonce.toString()));
  buffers.push(nonceBuf);

  // keeper_fee_bps: u16 (2 bytes, little-endian)
  const keeperFeeBuf = Buffer.alloc(2);
  keeperFeeBuf.writeUInt16LE(order.keeperFeeBps);
  buffers.push(keeperFeeBuf);

  // min_fill_bps: u16 (2 bytes, little-endian)
  const minFillBuf = Buffer.alloc(2);
  minFillBuf.writeUInt16LE(order.minFillBps);
  buffers.push(minFillBuf);

  return Buffer.concat(buffers);
}

/* ==================== PRICE CALCULATION ==================== */
function calculateLmsrCost(amm: AmmAccount, qYes: number, qNo: number): number {
  const b = amm.b.toNumber() / 1e6;
  const a = qYes / b;
  const c = qNo / b;
  const m = Math.max(a, c);
  const ea = Math.exp(a - m);
  const ec = Math.exp(c - m);
  return b * (m + Math.log(ea + ec));
}

function calculateCurrentPrice(amm: AmmAccount, action: number, side: number, shares: number): number {
  // Calculate price for buying/selling shares (shares in regular units, not e6)
  // Q values are in e6 on-chain, so divide by 1e6 to get regular units
  const currentQYes = amm.qYes.toNumber() / 10_000_000;  // Match app.js: 10M = 1 share
  const currentQNo = amm.qNo.toNumber() / 10_000_000;

  const baseCost = calculateLmsrCost(amm, currentQYes, currentQNo);

  let targetCost: number;
  if (action === 1) { // BUY
    if (side === 1) { // YES
      targetCost = calculateLmsrCost(amm, currentQYes + shares, currentQNo - shares);
    } else { // NO
      targetCost = calculateLmsrCost(amm, currentQYes, currentQNo + shares);
    }
  } else { // SELL
    if (side === 1) { // YES
      targetCost = calculateLmsrCost(amm, currentQYes - shares, currentQNo + shares);
    } else { // NO
      targetCost = calculateLmsrCost(amm, currentQYes, currentQNo - shares);
    }
  }

  const netCost = Math.abs(targetCost - baseCost);

  // Apply fees
  const feeBps = amm.feeBps;
  const grossCost = action === 1
    ? netCost / (1 - feeBps / 10000)
    : netCost * (1 - feeBps / 10000);

  // Average price per share in e6 scale
  const avgPrice = (grossCost / shares) * 1e6; // Price in USD with e6 scaling

  return Math.floor(avgPrice);
}

/* ==================== ORDER CHECKING ==================== */
async function fetchPendingOrders(): Promise<OrderData[]> {
  try {
    const response = await axios.get<PendingOrdersResponse>(`${ORDER_BOOK_API}/api/orders/pending`, {
      params: { limit: 100 }
    });
    return response.data.orders;
  } catch (err: any) {
    console.error('❌ Error fetching pending orders:', err.message);
    return [];
  }
}

async function checkIfExecutable(
  connection: Connection,
  amm: AmmAccount,
  order: LimitOrder
): Promise<boolean> {
  try {
    // Check market is open
    if (amm.status !== 1) {
      return false;
    }

    // Check not expired
    const now = Math.floor(Date.now() / 1000);
    if (order.expiry_ts <= now) {
      return false;
    }

    // Calculate current price for 1 share to check condition
    const currentPrice = calculateCurrentPrice(amm, order.action, order.side, 1);

    console.log(`   Current price: $${(currentPrice / 1e6).toFixed(6)} | Limit: $${(order.limit_price_e6 / 1e6).toFixed(6)}`);

    // Check price condition
    if (order.action === 1) { // BUY
      const executable = currentPrice <= order.limit_price_e6;
      console.log(`   BUY condition: ${currentPrice} <= ${order.limit_price_e6} = ${executable}`);
      return executable;
    } else { // SELL
      const executable = currentPrice >= order.limit_price_e6;
      console.log(`   SELL condition: ${currentPrice} >= ${order.limit_price_e6} = ${executable}`);
      return executable;
    }
  } catch (err: any) {
    console.error(`❌ Error checking executability:`, err.message);
    return false;
  }
}

/* ==================== ORDER EXECUTION ==================== */
async function executeOrder(
  connection: Connection,
  keeper: Keypair,
  order: LimitOrder,
  signature: string,
  orderId: number
): Promise<string | null> {
  try {
    const ammPda = getAmmPda();
    const userPubkey = new PublicKey(order.user);
    const positionPda = getPositionPda(ammPda, userPubkey);
    const vaultSolPda = getVaultPda(ammPda);
    const userVaultPda = getUserVaultPda(positionPda);

    console.log(`\n🔧 Building transaction for order ${orderId}...`);
    console.log(`   User: ${order.user}`);
    console.log(`   Action: ${order.action === 1 ? 'BUY' : 'SELL'} ${order.side === 1 ? 'YES' : 'NO'}`);
    console.log(`   Shares: ${order.shares_e6 / 1e6}`);
    console.log(`   Limit Price: $${(order.limit_price_e6 / 1e6).toFixed(6)}`);

    // Load IDL and create program
    const idl = JSON.parse(fs.readFileSync('target/idl/cpi_oracle.json', 'utf8'));
    const provider = new anchor.AnchorProvider(
      connection,
      new anchor.Wallet(keeper),
      { commitment: 'confirmed' }
    );
    const program = new anchor.Program(idl, provider);

    // Fetch AMM account to get fee_dest
    const ammAccountInfo = await connection.getAccountInfo(ammPda);
    if (!ammAccountInfo) {
      throw new Error('AMM account not found');
    }

    // Decode AMM account - feeDest is at offset 70 (empirically determined)
    const feeDest = new PublicKey(ammAccountInfo.data.slice(70, 102));

    // Build limit order struct for instruction
    const limitOrderStruct = {
      market: new PublicKey(order.market),
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

    // Convert signature from hex to Uint8Array (64 bytes)
    const signatureBytes = Buffer.from(signature, 'hex');
    if (signatureBytes.length !== 64) {
      throw new Error(`Invalid signature length: ${signatureBytes.length} (expected 64)`);
    }
    const signatureArray = Array.from(signatureBytes);

    // Serialize the order using Borsh (must match Rust serialization)
    const messageBytes = serializeOrder(limitOrderStruct);

    // Manually create Ed25519 verification instruction without account metadata
    // This avoids the "writable privilege escalation" error
    const ED25519_PROGRAM_ID = new PublicKey('Ed25519SigVerify111111111111111111111111111');

    // Build instruction data according to Ed25519 program format:
    // [num_signatures: u8][padding: u8][signature_offset: u16][signature_instruction_index: u16]
    // [public_key_offset: u16][public_key_instruction_index: u16][message_data_offset: u16]
    // [message_data_size: u16][message_instruction_index: u16][public_key: 32 bytes][signature: 64 bytes][message: variable]

    const publicKeyBytes = userPubkey.toBytes();
    const numSignatures = 1;
    const publicKeyOffset = 16;           // Offset to public key data
    const signatureOffset = 48;            // Offset to signature data (16 + 32)
    const messageDataOffset = 112;         // Offset to message data (16 + 32 + 64)
    const messageDataSize = messageBytes.length;
    const signatureInstructionIndex = 0xffff; // Special value meaning "this instruction"
    const publicKeyInstructionIndex = 0xffff;
    const messageInstructionIndex = 0xffff;

    // Create header buffer with proper byte order
    const headerBuffer = Buffer.alloc(16);
    headerBuffer.writeUInt8(numSignatures, 0);                   // offset 0: num_signatures
    headerBuffer.writeUInt8(0, 1);                                // offset 1: padding
    headerBuffer.writeUInt16LE(signatureOffset, 2);              // offset 2-3: signature_offset
    headerBuffer.writeUInt16LE(signatureInstructionIndex, 4);    // offset 4-5: signature_instruction_index
    headerBuffer.writeUInt16LE(publicKeyOffset, 6);              // offset 6-7: public_key_offset
    headerBuffer.writeUInt16LE(publicKeyInstructionIndex, 8);    // offset 8-9: public_key_instruction_index
    headerBuffer.writeUInt16LE(messageDataOffset, 10);           // offset 10-11: message_data_offset
    headerBuffer.writeUInt16LE(messageDataSize, 12);             // offset 12-13: message_data_size
    headerBuffer.writeUInt16LE(messageInstructionIndex, 14);     // offset 14-15: message_instruction_index

    const ed25519InstructionData = Buffer.concat([
      headerBuffer,                                                    // 16 bytes: header
      Buffer.from(publicKeyBytes),                                     // 32 bytes: public key
      signatureBytes,                                                  // 64 bytes: signature
      messageBytes,                                                    // variable: message
    ]);

    // Create the instruction WITHOUT any accounts (no account metadata)
    const ed25519Ix = new TransactionInstruction({
      keys: [], // Empty array - no accounts referenced
      programId: ED25519_PROGRAM_ID,
      data: ed25519InstructionData,
    });

    // Create compute budget instruction to increase CU limit
    const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: 400_000, // Increase from default 200K to 400K
    });

    console.log(`   Executing on-chain with Anchor...`);
    console.log(`     - AMM: ${ammPda.toString()}`);
    console.log(`     - Position: ${positionPda.toString()}`);
    console.log(`     - User Vault: ${userVaultPda.toString()}`);
    console.log(`     - Fee Dest: ${feeDest.toString()}`);
    console.log(`     - Vault Sol: ${vaultSolPda.toString()}`);
    console.log(`     - User: ${userPubkey.toString()}`);
    console.log(`     - Keeper: ${keeper.publicKey.toString()}`);
    console.log(`     - Instructions Sysvar: ${SYSVAR_INSTRUCTIONS_PUBKEY.toString()}`);

    // Execute the limit order instruction with Ed25519 verification
    const tx = await program.methods
      .executeLimitOrder(limitOrderStruct, signatureArray)
      .accountsStrict({
        amm: ammPda,
        position: positionPda,
        userVault: userVaultPda,
        feeDest: feeDest,
        vaultSol: vaultSolPda,
        user: userPubkey,
        keeper: keeper.publicKey,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([
        computeBudgetIx, // Increase compute budget first
        ed25519Ix,  // Ed25519 verification must come before the main instruction
      ])
      .rpc();

    console.log(`✅ Transaction sent: ${tx}`);
    console.log(`   View: https://explorer.solana.com/tx/${tx}?cluster=custom`);

    return tx;

  } catch (err: any) {
    console.error(`❌ Error executing order ${orderId}:`, err.message);
    if (err.logs) {
      console.error('Transaction logs:', err.logs);
    }
    return null;
  }
}

async function markOrderFilled(
  orderId: number,
  txSignature: string,
  sharesFilled: number,
  executionPrice: number,
  keeperPubkey: string
): Promise<void> {
  try {
    await axios.post(`${ORDER_BOOK_API}/api/orders/${orderId}/fill`, {
      tx_signature: txSignature,
      shares_filled: sharesFilled,
      execution_price: executionPrice,
      keeper_pubkey: keeperPubkey,
    });
    console.log(`✅ Order ${orderId} marked as filled in database`);
  } catch (err: any) {
    console.error(`❌ Error marking order ${orderId} as filled:`, err.message);
  }
}

/* ==================== MAIN LOOP ==================== */
async function keeperLoop() {
  const keeper = loadKeeper(KEEPER_WALLET);
  const connection = new Connection(RPC, 'confirmed');
  const ammPda = getAmmPda();

  console.log('🤖 Keeper Bot Started');
  console.log('━'.repeat(60));
  console.log(`Keeper:         ${keeper.publicKey.toString()}`);
  console.log(`RPC:            ${RPC}`);
  console.log(`Order Book API: ${ORDER_BOOK_API}`);
  console.log(`AMM:            ${ammPda.toString()}`);
  console.log(`Check Interval: ${CHECK_INTERVAL}ms`);
  console.log('━'.repeat(60));

  let iteration = 0;

  while (true) {
    try {
      iteration++;
      const timestamp = new Date().toISOString();

      // Fetch pending orders
      const orders = await fetchPendingOrders();

      if (orders.length === 0) {
        if (iteration % 10 === 0) {
          console.log(`[${timestamp}] 💤 No pending orders (checked ${iteration} times)`);
        }
      } else {
        console.log(`\n[${timestamp}] 📋 Found ${orders.length} pending order(s)`);

        // Fetch AMM state
        const ammAccountInfo = await connection.getAccountInfo(ammPda);
        if (!ammAccountInfo) {
          console.error('❌ AMM account not found');
          await sleep(CHECK_INTERVAL);
          continue;
        }

        // Deserialize AMM account (simplified - would use Anchor IDL in production)
        // For now, we'll skip actual deserialization and use mock data
        const amm: AmmAccount = {
          bump: 0,
          decimals: 6,
          b: new anchor.BN(500_000_000), // b = 500
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

        console.log(`📊 AMM State: qYes=${amm.qYes.toNumber() / 1e6}, qNo=${amm.qNo.toNumber() / 1e6}, status=${amm.status}`);

        // Check each order
        for (const orderData of orders) {
          const { order, signature, order_id } = orderData;

          console.log(`\n🔍 Checking order ${order_id}:`);
          console.log(`   ${order.action === 1 ? 'BUY' : 'SELL'} ${order.shares_e6 / 1e6} ${order.side === 1 ? 'YES' : 'NO'} @ limit $${(order.limit_price_e6 / 1e6).toFixed(6)}`);

          const executable = await checkIfExecutable(connection, amm, order);

          if (executable) {
            console.log(`✅ Order ${order_id} is executable!`);

            const tx = await executeOrder(connection, keeper, order, signature, order_id);

            if (tx) {
              console.log(`✅ Order ${order_id} executed: ${tx}`);

              // Mark as filled in database
              await markOrderFilled(
                order_id,
                tx,
                order.shares_e6,
                order.limit_price_e6,
                keeper.publicKey.toString()
              );
            } else {
              console.log(`⚠️  Order ${order_id} execution skipped (implementation pending)`);
            }
          } else {
            console.log(`❌ Order ${order_id} not executable yet (price condition not met or expired)`);
          }
        }
      }

    } catch (err: any) {
      console.error('❌ Error in keeper loop:', err.message);
    }

    await sleep(CHECK_INTERVAL);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* ==================== START ==================== */
keeperLoop().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
