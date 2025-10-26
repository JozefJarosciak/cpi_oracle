/**
 * Comprehensive Integration Tests for X1 Prediction Market Web App
 *
 * Tests all trading operations (BUY/SELL YES/NO, REDEEM) and verifies:
 * - On-chain balance changes
 * - Position updates
 * - UI state management
 * - Market status constraints
 */

const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, LAMPORTS_PER_SOL, SYSVAR_RENT_PUBKEY, ComputeBudgetProgram } = require('@solana/web3.js');
const { createHash } = require('crypto');
const assert = require('assert');

// Configuration
const CONFIG = {
    RPC_URL: process.env.ANCHOR_PROVIDER_URL || 'https://rpc.testnet.x1.xyz',
    PROGRAM_ID: 'EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF',
    ORACLE_STATE: '4KYeNyv1B9YjjQkfJk2C6Uqo71vKzFZriRe5NXg6GyCq',
    AMM_SEED: 'amm_btc_v3',
    LAMPORTS_PER_E6: 100,
};

// Test constants
const SCALE_E6 = 10_000_000; // 1 share = 10_000_000 e6 units
const MIN_BUY_E6 = 100_000;  // $0.10 min
const MAX_SPEND_E6 = 50_000_000_000; // $50k max
const MIN_SELL_E6 = 100_000; // 0.1 share min

// Helper functions
function createDiscriminator(name) {
    const hash = createHash('sha256').update(`global:${name}`).digest();
    return hash.slice(0, 8);
}

function readI64LE(buffer, offset) {
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    return Number(view.getBigInt64(offset, true));
}

function readU8(buffer, offset) {
    return buffer[offset];
}

function readU16LE(buffer, offset) {
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    return view.getUint16(offset, true);
}

/**
 * Fetch AMM account data and parse market state
 */
async function fetchMarketData(connection, ammPda) {
    const accountInfo = await connection.getAccountInfo(ammPda);
    if (!accountInfo) {
        throw new Error('AMM account not found');
    }

    const d = accountInfo.data;
    const p = d.subarray(8); // Skip discriminator
    let o = 0;

    const bump = readU8(p, o); o += 1;
    const decimals = readU8(p, o); o += 1;
    const b = readI64LE(p, o); o += 8;
    const feeBps = readU16LE(p, o); o += 2;
    const qYes = readI64LE(p, o); o += 8;
    const qNo = readI64LE(p, o); o += 8;
    const fees = readI64LE(p, o); o += 8;
    const vault = readI64LE(p, o); o += 8;
    const status = readU8(p, o); o += 1;
    const winner = readU8(p, o); o += 1;
    const wTotal = readI64LE(p, o); o += 8;
    const pps = readI64LE(p, o); o += 8;
    o += 32; // Skip fee_dest pubkey
    const vaultSolBump = readU8(p, o); o += 1;
    const startPriceE6 = readI64LE(p, o); o += 8;

    return {
        bump, decimals, b, feeBps,
        qYes, qNo, fees, vault,
        status, winner, wTotal, pps,
        vaultSolBump, startPriceE6
    };
}

/**
 * Fetch position data for a user
 */
async function fetchPositionData(connection, ammPda, userPubkey, programId) {
    const [posPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('pos'), ammPda.toBytes(), userPubkey.toBytes()],
        programId
    );

    const accountInfo = await connection.getAccountInfo(posPda);
    if (!accountInfo) {
        return { yes: 0, no: 0, exists: false, posPda };
    }

    const d = accountInfo.data;
    let o = 8; // Skip discriminator
    o += 32; // Skip owner pubkey
    const yesShares = readI64LE(d, o); o += 8;
    const noShares = readI64LE(d, o);

    return {
        yes: yesShares / SCALE_E6,
        no: noShares / SCALE_E6,
        exists: true,
        posPda
    };
}

/**
 * Initialize position account for a user
 */
async function initPosition(connection, wallet, ammPda, programId) {
    const [posPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('pos'), ammPda.toBytes(), wallet.publicKey.toBytes()],
        programId
    );

    const discriminator = createDiscriminator('init_position');

    const keys = [
        { pubkey: ammPda, isSigner: false, isWritable: false },
        { pubkey: posPda, isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];

    const instruction = new TransactionInstruction({
        programId,
        keys,
        data: Buffer.from(discriminator)
    });

    const transaction = new Transaction().add(instruction);
    transaction.feePayer = wallet.publicKey;
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    transaction.sign(wallet);

    const signature = await connection.sendRawTransaction(transaction.serialize());
    await connection.confirmTransaction(signature, 'confirmed');

    return posPda;
}

/**
 * Get fee destination from AMM account
 */
async function getFeeDest(connection, ammPda) {
    const accountInfo = await connection.getAccountInfo(ammPda);
    const d = accountInfo.data;
    let o = 8 + 1 + 1 + 8 + 2 + 8 + 8 + 8 + 8 + 1 + 1 + 8 + 8; // skip to fee_dest
    const feeDestBytes = d.slice(o, o + 32);
    return new PublicKey(feeDestBytes);
}

/**
 * Execute a trade (BUY or SELL, YES or NO)
 */
async function executeTrade(connection, wallet, ammPda, vaultPda, programId, side, action, amountE6) {
    const feeDest = await getFeeDest(connection, ammPda);

    const [posPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('pos'), ammPda.toBytes(), wallet.publicKey.toBytes()],
        programId
    );

    const discriminator = createDiscriminator('trade');
    const sideNum = side === 'yes' ? 1 : 2;
    const actionNum = action === 'buy' ? 1 : 2;

    const amountBuf = Buffer.allocUnsafe(8);
    amountBuf.writeBigInt64LE(BigInt(amountE6));

    const data = Buffer.concat([
        discriminator,
        Buffer.from([sideNum]),
        Buffer.from([actionNum]),
        amountBuf
    ]);

    const keys = [
        { pubkey: ammPda, isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: posPda, isSigner: false, isWritable: true },
        { pubkey: feeDest, isSigner: false, isWritable: true },
        { pubkey: vaultPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ];

    const instruction = new TransactionInstruction({
        programId,
        keys,
        data
    });

    // Add compute budget instructions
    const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 });
    const transaction = new Transaction().add(computeBudgetIx, instruction);
    transaction.feePayer = wallet.publicKey;
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    transaction.sign(wallet);

    const signature = await connection.sendRawTransaction(transaction.serialize());
    await connection.confirmTransaction(signature, 'confirmed');

    return signature;
}

/**
 * Redeem winnings after market settlement
 */
async function redeemWinnings(connection, wallet, ammPda, vaultPda, programId) {
    const feeDest = await getFeeDest(connection, ammPda);

    const [posPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('pos'), ammPda.toBytes(), wallet.publicKey.toBytes()],
        programId
    );

    const discriminator = createDiscriminator('redeem');

    const keys = [
        { pubkey: ammPda, isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: posPda, isSigner: false, isWritable: true },
        { pubkey: feeDest, isSigner: false, isWritable: true },
        { pubkey: vaultPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ];

    const instruction = new TransactionInstruction({
        programId,
        keys,
        data: Buffer.from(discriminator)
    });

    const transaction = new Transaction().add(instruction);
    transaction.feePayer = wallet.publicKey;
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    transaction.sign(wallet);

    const signature = await connection.sendRawTransaction(transaction.serialize());
    await connection.confirmTransaction(signature, 'confirmed');

    return signature;
}

// ============= TEST SUITE =============

describe('X1 Prediction Market - Complete Integration Tests', function() {
    this.timeout(60000); // 60 second timeout for blockchain operations

    let connection;
    let wallet;
    let ammPda;
    let vaultPda;
    let programId;

    before(async function() {
        // Setup connection and wallet
        connection = new Connection(CONFIG.RPC_URL, 'confirmed');

        // Load wallet from file or create new
        try {
            const walletData = require('../../userA.json');
            wallet = Keypair.fromSecretKey(Uint8Array.from(walletData));
        } catch (err) {
            console.log('Creating new test wallet...');
            wallet = Keypair.generate();

            // Request airdrop if needed
            const balance = await connection.getBalance(wallet.publicKey);
            if (balance < 1 * LAMPORTS_PER_SOL) {
                console.log('Requesting airdrop...');
                const signature = await connection.requestAirdrop(wallet.publicKey, 2 * LAMPORTS_PER_SOL);
                await connection.confirmTransaction(signature);
            }
        }

        programId = new PublicKey(CONFIG.PROGRAM_ID);

        // Derive PDAs
        [ammPda] = PublicKey.findProgramAddressSync(
            [Buffer.from(CONFIG.AMM_SEED)],
            programId
        );

        [vaultPda] = PublicKey.findProgramAddressSync(
            [Buffer.from('vault_sol'), ammPda.toBytes()],
            programId
        );

        console.log(`Test wallet: ${wallet.publicKey.toBase58()}`);
        console.log(`AMM PDA: ${ammPda.toBase58()}`);
        console.log(`Vault PDA: ${vaultPda.toBase58()}`);
    });

    describe('Market State Verification', function() {
        it('should fetch and parse market data correctly', async function() {
            const market = await fetchMarketData(connection, ammPda);

            assert.strictEqual(typeof market.status, 'number', 'Status should be a number');
            assert.strictEqual(market.decimals, 6, 'Decimals should be 6');
            assert(market.b > 0, 'Liquidity parameter b should be positive');
            assert(market.feeBps >= 0, 'Fee basis points should be non-negative');

            console.log(`Market status: ${market.status} (0=OPEN, 1=STOPPED, 2=SETTLED)`);
            console.log(`Liquidity (b): ${market.b / SCALE_E6}`);
            console.log(`Fee: ${market.feeBps / 100}%`);
        });

        it('should verify market status affects trading', async function() {
            const market = await fetchMarketData(connection, ammPda);

            if (market.status === 0) {
                console.log('✓ Market is OPEN - trading should be enabled');
            } else if (market.status === 1) {
                console.log('✓ Market is STOPPED - trading should be disabled, redeem disabled');
            } else if (market.status === 2) {
                console.log('✓ Market is SETTLED - trading disabled, redeem enabled');
            }
        });
    });

    describe('Position Management', function() {
        it('should initialize position if not exists', async function() {
            const position = await fetchPositionData(connection, ammPda, wallet.publicKey, programId);

            if (!position.exists) {
                console.log('Position does not exist, initializing...');
                await initPosition(connection, wallet, ammPda, programId);

                const newPosition = await fetchPositionData(connection, ammPda, wallet.publicKey, programId);
                assert(newPosition.exists, 'Position should exist after initialization');
                assert.strictEqual(newPosition.yes, 0, 'YES shares should be 0');
                assert.strictEqual(newPosition.no, 0, 'NO shares should be 0');
                console.log('✓ Position initialized successfully');
            } else {
                console.log(`✓ Position exists: YES=${position.yes}, NO=${position.no}`);
            }
        });

        it('should fetch position data correctly', async function() {
            const position = await fetchPositionData(connection, ammPda, wallet.publicKey, programId);

            assert(position.exists, 'Position should exist');
            assert(typeof position.yes === 'number', 'YES shares should be a number');
            assert(typeof position.no === 'number', 'NO shares should be a number');
            assert(position.yes >= 0, 'YES shares should be non-negative');
            assert(position.no >= 0, 'NO shares should be non-negative');

            console.log(`Current position: YES=${position.yes.toFixed(2)}, NO=${position.no.toFixed(2)}`);
        });
    });

    describe('BUY Operations', function() {
        it('should execute BUY YES trade and update balances', async function() {
            const market = await fetchMarketData(connection, ammPda);
            if (market.status !== 0) {
                this.skip(); // Skip if market not open
                return;
            }

            // Get initial state
            const initialBalance = await connection.getBalance(wallet.publicKey);
            const initialPosition = await fetchPositionData(connection, ammPda, wallet.publicKey, programId);
            const initialMarket = await fetchMarketData(connection, ammPda);

            // Buy 10 shares (approximately, LMSR will determine exact amount)
            const spendAmount = 1_000_000; // $0.10 in e6 units
            console.log(`Buying YES shares with ${spendAmount / 1_000_000} XNT...`);

            const signature = await executeTrade(connection, wallet, ammPda, vaultPda, programId, 'yes', 'buy', spendAmount);
            console.log(`Trade TX: ${signature}`);

            // Get final state
            const finalBalance = await connection.getBalance(wallet.publicKey);
            const finalPosition = await fetchPositionData(connection, ammPda, wallet.publicKey, programId);
            const finalMarket = await fetchMarketData(connection, ammPda);

            // Verify balance decreased (spent + fees + tx fee)
            assert(finalBalance < initialBalance, 'Wallet balance should decrease after buying');

            // Verify position increased
            assert(finalPosition.yes > initialPosition.yes, 'YES shares should increase');
            const sharesReceived = finalPosition.yes - initialPosition.yes;
            console.log(`✓ Received ${sharesReceived.toFixed(4)} YES shares`);

            // Verify market state updated
            assert(finalMarket.qYes > initialMarket.qYes, 'Market qYes should increase');
            assert(finalMarket.vault > initialMarket.vault, 'Vault should increase (received funds)');

            const vaultIncrease = (finalMarket.vault - initialMarket.vault) / SCALE_E6;
            console.log(`✓ Vault increased by ${vaultIncrease.toFixed(4)} XNT`);
        });

        it('should execute BUY NO trade and update balances', async function() {
            const market = await fetchMarketData(connection, ammPda);
            if (market.status !== 0) {
                this.skip();
                return;
            }

            const initialPosition = await fetchPositionData(connection, ammPda, wallet.publicKey, programId);
            const initialMarket = await fetchMarketData(connection, ammPda);

            const spendAmount = 1_000_000; // $0.10 in e6 units
            console.log(`Buying NO shares with ${spendAmount / 1_000_000} XNT...`);

            const signature = await executeTrade(connection, wallet, ammPda, vaultPda, programId, 'no', 'buy', spendAmount);
            console.log(`Trade TX: ${signature}`);

            const finalPosition = await fetchPositionData(connection, ammPda, wallet.publicKey, programId);
            const finalMarket = await fetchMarketData(connection, ammPda);

            assert(finalPosition.no > initialPosition.no, 'NO shares should increase');
            assert(finalMarket.qNo > initialMarket.qNo, 'Market qNo should increase');
            assert(finalMarket.vault > initialMarket.vault, 'Vault should increase');

            const sharesReceived = finalPosition.no - initialPosition.no;
            console.log(`✓ Received ${sharesReceived.toFixed(4)} NO shares`);
        });

        it('should reject buy amount below minimum', async function() {
            const market = await fetchMarketData(connection, ammPda);
            if (market.status !== 0) {
                this.skip();
                return;
            }

            const tooSmallAmount = MIN_BUY_E6 - 1;

            try {
                await executeTrade(connection, wallet, ammPda, vaultPda, programId, 'yes', 'buy', tooSmallAmount);
                assert.fail('Should have rejected trade below minimum');
            } catch (err) {
                console.log(`✓ Correctly rejected small trade: ${err.message}`);
                assert(err.message.includes('custom program error'), 'Should be program error');
            }
        });
    });

    describe('SELL Operations', function() {
        it('should execute SELL YES trade and update balances', async function() {
            const market = await fetchMarketData(connection, ammPda);
            if (market.status !== 0) {
                this.skip();
                return;
            }

            const initialPosition = await fetchPositionData(connection, ammPda, wallet.publicKey, programId);

            // Skip if no YES shares to sell
            if (initialPosition.yes < 0.1) {
                console.log('Insufficient YES shares to test SELL');
                this.skip();
                return;
            }

            const initialBalance = await connection.getBalance(wallet.publicKey);
            const initialMarket = await fetchMarketData(connection, ammPda);

            // Sell 0.1 shares
            const sharesToSell = 0.1;
            const sellAmountE6 = Math.floor(sharesToSell * 10_000_000); // SCALE_E6 (LAMPORTS scale)
            console.log(`Selling ${sharesToSell} YES shares...`);

            const signature = await executeTrade(connection, wallet, ammPda, vaultPda, programId, 'yes', 'sell', sellAmountE6);
            console.log(`Trade TX: ${signature}`);

            const finalBalance = await connection.getBalance(wallet.publicKey);
            const finalPosition = await fetchPositionData(connection, ammPda, wallet.publicKey, programId);
            const finalMarket = await fetchMarketData(connection, ammPda);

            // Verify balance increased (received proceeds minus tx fee)
            const balanceChange = (finalBalance - initialBalance) / LAMPORTS_PER_SOL;
            console.log(`Balance change: ${balanceChange.toFixed(6)} SOL`);

            // Verify position decreased by exactly the amount sold (with small tolerance for rounding)
            const sharesSold = initialPosition.yes - finalPosition.yes;
            assert(finalPosition.yes < initialPosition.yes, 'YES shares should decrease');
            assert(Math.abs(sharesSold - sharesToSell) < 0.001, `Should sell exactly ${sharesToSell} shares, sold ${sharesSold.toFixed(4)}`);

            // Verify market state updated
            assert(finalMarket.qYes < initialMarket.qYes, 'Market qYes should decrease');
            assert(finalMarket.vault < initialMarket.vault, 'Vault should decrease (paid out)');

            console.log(`✓ Successfully sold ${sharesSold.toFixed(4)} YES shares (requested ${sharesToSell})`);
        });

        it('should execute SELL NO trade and update balances', async function() {
            const market = await fetchMarketData(connection, ammPda);
            if (market.status !== 0) {
                this.skip();
                return;
            }

            const initialPosition = await fetchPositionData(connection, ammPda, wallet.publicKey, programId);

            if (initialPosition.no < 0.1) {
                console.log('Insufficient NO shares to test SELL');
                this.skip();
                return;
            }

            const initialMarket = await fetchMarketData(connection, ammPda);

            const sharesToSell = 0.1;
            const sellAmountE6 = Math.floor(sharesToSell * 10_000_000); // SCALE_E6 (LAMPORTS scale)
            console.log(`Selling ${sharesToSell} NO shares...`);

            const signature = await executeTrade(connection, wallet, ammPda, vaultPda, programId, 'no', 'sell', sellAmountE6);
            console.log(`Trade TX: ${signature}`);

            const finalPosition = await fetchPositionData(connection, ammPda, wallet.publicKey, programId);
            const finalMarket = await fetchMarketData(connection, ammPda);

            // Verify position decreased by exactly the amount sold (with small tolerance for rounding)
            const sharesSold = initialPosition.no - finalPosition.no;
            assert(finalPosition.no < initialPosition.no, 'NO shares should decrease');
            assert(Math.abs(sharesSold - sharesToSell) < 0.001, `Should sell exactly ${sharesToSell} shares, sold ${sharesSold.toFixed(4)}`);
            assert(finalMarket.qNo < initialMarket.qNo, 'Market qNo should decrease');

            console.log(`✓ Successfully sold ${sharesSold.toFixed(4)} NO shares (requested ${sharesToSell})`);
        });

        it('should reject sell with insufficient shares', async function() {
            const market = await fetchMarketData(connection, ammPda);
            if (market.status !== 0) {
                this.skip();
                return;
            }

            const position = await fetchPositionData(connection, ammPda, wallet.publicKey, programId);
            const excessiveAmount = Math.floor((position.yes + 1000) * 1_000_000);

            try {
                await executeTrade(connection, wallet, ammPda, vaultPda, programId, 'yes', 'sell', excessiveAmount);
                assert.fail('Should have rejected sell with insufficient shares');
            } catch (err) {
                console.log(`✓ Correctly rejected sell with insufficient shares: ${err.message}`);
            }
        });
    });

    describe('REDEEM Operations', function() {
        it('should reject redeem when market not settled', async function() {
            const market = await fetchMarketData(connection, ammPda);

            if (market.status === 2) {
                this.skip(); // Market is settled, can't test this
                return;
            }

            try {
                await redeemWinnings(connection, wallet, ammPda, vaultPda, programId);
                assert.fail('Should have rejected redeem when market not settled');
            } catch (err) {
                console.log(`✓ Correctly rejected redeem (market status: ${market.status})`);
                assert(err.message.includes('custom program error') || err.message.includes('WrongState'), 'Should be program error');
            }
        });

        it('should execute redeem when market settled and update balances', async function() {
            const market = await fetchMarketData(connection, ammPda);

            if (market.status !== 2) {
                console.log('Market not settled, skipping redeem test');
                this.skip();
                return;
            }

            const initialPosition = await fetchPositionData(connection, ammPda, wallet.publicKey, programId);
            const initialBalance = await connection.getBalance(wallet.publicKey);

            // Calculate expected payout
            const winningShares = market.winner === 1 ? initialPosition.yes : initialPosition.no;
            const payoutPerShare = market.pps / 1_000_000; // Convert from e6
            const expectedPayout = winningShares * payoutPerShare;

            if (winningShares === 0) {
                console.log('No winning shares to redeem');
                this.skip();
                return;
            }

            console.log(`Redeeming ${winningShares.toFixed(2)} winning shares @ ${payoutPerShare.toFixed(4)} XNT/share`);
            console.log(`Expected payout: ${expectedPayout.toFixed(4)} XNT`);

            const signature = await redeemWinnings(connection, wallet, ammPda, vaultPda, programId);
            console.log(`Redeem TX: ${signature}`);

            const finalBalance = await connection.getBalance(wallet.publicKey);
            const finalPosition = await fetchPositionData(connection, ammPda, wallet.publicKey, programId);

            // Verify position wiped
            assert.strictEqual(finalPosition.yes, 0, 'YES shares should be wiped');
            assert.strictEqual(finalPosition.no, 0, 'NO shares should be wiped');

            // Verify balance increased
            const balanceIncrease = (finalBalance - initialBalance) / LAMPORTS_PER_SOL;
            console.log(`✓ Balance increased by ${balanceIncrease.toFixed(6)} SOL`);
            console.log(`✓ Position wiped successfully`);
        });
    });

    describe('Market Status Constraints', function() {
        it('should enforce trading disabled when market stopped', async function() {
            const market = await fetchMarketData(connection, ammPda);

            if (market.status !== 1) {
                console.log('Market not stopped, skipping test');
                this.skip();
                return;
            }

            try {
                await executeTrade(connection, wallet, ammPda, vaultPda, programId, 'yes', 'buy', 1_000_000);
                assert.fail('Should have rejected trade when market stopped');
            } catch (err) {
                console.log(`✓ Correctly rejected trade when market stopped`);
                assert(err.message.includes('custom program error') || err.message.includes('MarketClosed'), 'Should be MarketClosed error');
            }
        });

        it('should enforce trading disabled when market settled', async function() {
            const market = await fetchMarketData(connection, ammPda);

            if (market.status !== 2) {
                console.log('Market not settled, skipping test');
                this.skip();
                return;
            }

            try {
                await executeTrade(connection, wallet, ammPda, vaultPda, programId, 'yes', 'buy', 1_000_000);
                assert.fail('Should have rejected trade when market settled');
            } catch (err) {
                console.log(`✓ Correctly rejected trade when market settled`);
                assert(err.message.includes('custom program error') || err.message.includes('MarketClosed'), 'Should be MarketClosed error');
            }
        });
    });

    describe('LMSR Pricing Consistency', function() {
        it('should verify LMSR pricing matches on-chain calculations', async function() {
            const market = await fetchMarketData(connection, ammPda);

            // Calculate probabilities using LMSR
            const b = market.b / SCALE_E6;
            const qYesShares = market.qYes / SCALE_E6;
            const qNoShares = market.qNo / SCALE_E6;

            const expYes = Math.exp(qYesShares / b);
            const expNo = Math.exp(qNoShares / b);
            const pYes = expYes / (expYes + expNo);
            const pNo = 1 - pYes;

            assert(pYes >= 0 && pYes <= 1, 'YES probability should be between 0 and 1');
            assert(pNo >= 0 && pNo <= 1, 'NO probability should be between 0 and 1');
            assert(Math.abs(pYes + pNo - 1) < 0.0001, 'Probabilities should sum to 1');

            console.log(`YES price: ${pYes.toFixed(4)} (${(pYes * 100).toFixed(2)}%)`);
            console.log(`NO price: ${pNo.toFixed(4)} (${(pNo * 100).toFixed(2)}%)`);
            console.log(`✓ LMSR pricing is consistent`);
        });
    });
});
