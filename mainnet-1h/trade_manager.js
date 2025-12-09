#!/usr/bin/env node
// trade_manager.js - Manages trades with observation period, loss-cutting, and cycle limits
// 1-HOUR MARKET VERSION
// Usage: node trade_manager.js [max_investment] [min_edge] [observation_seconds]

const fs = require("fs");
const crypto = require("crypto");
const bs58 = require("bs58");
const {
  Connection, PublicKey, Keypair, SystemProgram,
  Transaction, TransactionInstruction,
  ComputeBudgetProgram, SYSVAR_RENT_PUBKEY,
} = require("@solana/web3.js");

/* ---------------- CONFIG ---------------- */
const RPC = "https://rpc.mainnet.x1.xyz";
const WALLET_PATH = "./bot.key";
const MAX_CYCLE_INVESTMENT = Math.min(parseFloat(process.argv[2]) || 50, 50);
const MIN_EDGE_PERCENT = parseFloat(process.argv[3]) || 30; // Increased: need 30%+ edge (price < $0.70)
const MIN_OBSERVATION_SECONDS = parseInt(process.argv[4]) || 600; // Wait 10+ minutes to see clear trend (1h market)
const EXIT_WINDOW_START = 120; // Start checking for exit at 120s remaining
const EXIT_WINDOW_END = 46; // Must exit by 46s (before 45s lockout)
const MOMENTUM_WINDOW = 10; // Track last N price readings for momentum
const MAX_ENTRY_PRICE = 0.55; // Only buy when 45%+ upside potential
const LAST_MINUTE_MAX_PRICE = 0.55; // Same limit for last-minute
const MIN_PRICE_DIFF = 15; // Relaxed: $15+ movement for testing
const REVERSAL_THRESHOLD = 30; // Exit if momentum reverses by $30+ against our position
const MAX_TOTAL_POSITION = 50; // Maximum total position size

// Conviction levels: [minEdge, minPriceDiff, minMomentum, tradeSize]
// Level 1: Low conviction - small entry
// Level 2: Medium conviction
// Level 3: High conviction
// Level 4: Very high conviction - max entry
const CONVICTION_LEVELS = [
  { level: 1, minEdge: 30, minPriceDiff: 15, minMomentum: 5,  tradeSize: 10 },
  { level: 2, minEdge: 35, minPriceDiff: 30, minMomentum: 15, tradeSize: 20 },
  { level: 3, minEdge: 40, minPriceDiff: 50, minMomentum: 25, tradeSize: 35 },
  { level: 4, minEdge: 50, minPriceDiff: 80, minMomentum: 40, tradeSize: 50 },
];

function getConvictionLevel(edge, priceDiff, momentum) {
  const absPriceDiff = Math.abs(priceDiff);
  const absMomentum = Math.abs(momentum);

  // Find highest matching conviction level (check from highest to lowest)
  for (let i = CONVICTION_LEVELS.length - 1; i >= 0; i--) {
    const level = CONVICTION_LEVELS[i];
    if (edge >= level.minEdge && absPriceDiff >= level.minPriceDiff && absMomentum >= level.minMomentum) {
      return level;
    }
  }
  return null; // No conviction level met
}

// Price history for momentum analysis
let priceHistory = [];
let totalPositionSize = 0; // Track total position entered this cycle
let lastTradeTime = 0; // Track when last trade was made
const TRADE_COOLDOWN = 60; // Wait 60 seconds between trades

const PID = new PublicKey("GK9BejLw2JoRXdJfZmSJzsTvn3JGKDbZzhBChZr7ewvz");
const AMM_SEED = Buffer.from("amm_btc_1h");
const VAULT_SOL_SEED = Buffer.from("vault_sol");
const USER_VAULT_SEED = Buffer.from("user_vault");
const POS_SEED = Buffer.from("pos");
const ORACLE_STATE = new PublicKey("CqhjUyyiQ21GHFEPB99tyu1txumWG31vNaRxKTGYdEGy");
const E6_PER_XNT = 10_000_000;
const LAMPORTS_PER_XNT = E6_PER_XNT * 100;

/* ---------------- Helpers ---------------- */
const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);
const logError = (...args) => console.error(`[${new Date().toISOString()}] ❌`, ...args);
const logSuccess = (...args) => console.log(`[${new Date().toISOString()}] ✓`, ...args);
const logWarn = (...args) => console.log(`[${new Date().toISOString()}] ⚠️`, ...args);

function sha256(data) { return crypto.createHash("sha256").update(data).digest(); }
function discriminator(name) { return sha256(Buffer.from(`global:${name}`, "utf8")).slice(0, 8); }
function getAmmPda() { const [pda] = PublicKey.findProgramAddressSync([AMM_SEED], PID); return pda; }
function getVaultPda(ammPda) { const [pda] = PublicKey.findProgramAddressSync([VAULT_SOL_SEED, ammPda.toBuffer()], PID); return pda; }
function getPositionPda(ammPda, user) { const [pda] = PublicKey.findProgramAddressSync([POS_SEED, ammPda.toBuffer(), user.toBuffer()], PID); return pda; }
function getUserVaultPda(positionPda) { const [pda] = PublicKey.findProgramAddressSync([USER_VAULT_SEED, positionPda.toBuffer()], PID); return pda; }

async function getFeeDest(conn, ammPda) {
  const ammAccountInfo = await conn.getAccountInfo(ammPda);
  return new PublicKey(ammAccountInfo.data.slice(70, 102));
}

async function getAmmState(conn, ammPda) {
  const ammInfo = await conn.getAccountInfo(ammPda);
  if (!ammInfo) return null;
  const d = ammInfo.data;
  let o = 8; o += 2;
  const bRaw = d.readBigInt64LE(o); o += 8;
  const feeBps = d.readUInt16LE(o); o += 2;
  const qYesRaw = d.readBigInt64LE(o); o += 8;
  const qNoRaw = d.readBigInt64LE(o); o += 8;
  o += 8 + 8; const status = d.readUInt8(o); o += 1 + 1 + 8 + 8 + 33;
  const startPriceE6 = d.readBigInt64LE(o); o += 8 + 8 + 8 + 8 + 8;
  const marketEndTime = d.readBigInt64LE(o);
  const qYes = Number(qYesRaw) / 10000000;
  const qNo = Number(qNoRaw) / 10000000;
  const b = Number(bRaw) / 10000000;
  const pYes = Math.exp(qYes / b) / (Math.exp(qYes / b) + Math.exp(qNo / b));
  return { status, qYes, qNo, b, pYes, pNo: 1 - pYes, startPriceE6: Number(startPriceE6), marketEndTime: Number(marketEndTime), feeBps };
}

async function getOraclePrice(conn) {
  const oracleInfo = await conn.getAccountInfo(ORACLE_STATE);
  if (!oracleInfo) return 0;
  // New oracle: BTC prices at offsets 48 and 56, e8 format
  const p1 = Number(oracleInfo.data.readBigInt64LE(48));
  const p2 = Number(oracleInfo.data.readBigInt64LE(56));
  return ((p1 + p2) / 2) / 1e8;
}

async function getPositionInfo(conn, posPda) {
  const posAccount = await conn.getAccountInfo(posPda);
  if (!posAccount) return { balance: 0, yesShares: 0, noShares: 0 };

  // Get actual lamports from user_vault PDA instead of tracking field
  const userVaultPda = getUserVaultPda(posPda);
  const userVaultInfo = await conn.getAccountInfo(userVaultPda);
  const vaultLamports = userVaultInfo ? userVaultInfo.lamports : 0;

  return {
    yesShares: Number(posAccount.data.readBigInt64LE(40)) / E6_PER_XNT,
    noShares: Number(posAccount.data.readBigInt64LE(48)) / E6_PER_XNT,
    balance: vaultLamports / LAMPORTS_PER_XNT
  };
}

async function getVaultBalance(conn, ammPda) {
  const vaultPda = getVaultPda(ammPda);
  const vaultInfo = await conn.getAccountInfo(vaultPda);
  if (!vaultInfo) return 0;
  // Vault balance is stored as lamports in account data at offset 0
  return vaultInfo.lamports / LAMPORTS_PER_XNT;
}

// Calculate LMSR slippage for a trade
// Returns the average price per share and slippage amount
function calculateSlippage(amm, side, amount) {
  const { qYes, qNo, b } = amm;

  // Current cost function value
  const costBefore = b * Math.log(Math.exp(qYes / b) + Math.exp(qNo / b));

  // Cost after trade
  let costAfter;
  if (side === 'yes') {
    costAfter = b * Math.log(Math.exp((qYes + amount) / b) + Math.exp(qNo / b));
  } else {
    costAfter = b * Math.log(Math.exp(qYes / b) + Math.exp((qNo + amount) / b));
  }

  // Total cost to buy 'amount' shares
  const totalCost = costAfter - costBefore;
  const avgPricePerShare = totalCost / amount;

  // Current spot price
  const spotPrice = side === 'yes' ? amm.pYes : amm.pNo;

  // Slippage is the difference
  const slippage = avgPricePerShare - spotPrice;

  return { avgPrice: avgPricePerShare, spotPrice, slippage, totalCost };
}

async function executeTrade(conn, kp, ammPda, amountXnt, side, action) {
  const posPda = getPositionPda(ammPda, kp.publicKey);
  const userVaultPda = getUserVaultPda(posPda);
  const vaultPda = getVaultPda(ammPda);
  const feeDest = await getFeeDest(conn, ammPda);
  const amount_e6 = Math.floor(amountXnt * E6_PER_XNT);

  const tradeData = Buffer.alloc(18);
  discriminator("trade").copy(tradeData, 0);
  tradeData.writeUInt8(side === 'yes' ? 1 : 2, 8);
  tradeData.writeUInt8(action === 'buy' ? 1 : 2, 9);
  tradeData.writeBigInt64LE(BigInt(amount_e6), 10);

  const ix = new TransactionInstruction({
    programId: PID,
    keys: [
      { pubkey: ammPda, isSigner: false, isWritable: true },
      { pubkey: kp.publicKey, isSigner: true, isWritable: true },
      { pubkey: posPda, isSigner: false, isWritable: true },
      { pubkey: userVaultPda, isSigner: false, isWritable: true },
      { pubkey: feeDest, isSigner: false, isWritable: true },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: ORACLE_STATE, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: tradeData,
  });

  const memoIx = new TransactionInstruction({
    keys: [{ pubkey: kp.publicKey, isSigner: true, isWritable: false }],
    programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
    data: Buffer.from(Math.floor(Math.random() * 1000000).toString()),
  });

  const budgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 });
  const tx = new Transaction().add(budgetIx, memoIx, ix);
  const { blockhash } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = kp.publicKey;
  tx.sign(kp);

  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, 'confirmed');
  return sig;
}

/* ---------------- Main Trading Loop ---------------- */
async function runTradeManager() {
  console.log("\n" + "=".repeat(60));
  console.log("  TRADE MANAGER - Momentum + Loss-Cutting Strategy");
  console.log("=".repeat(60));
  log(`Max per cycle: ${MAX_CYCLE_INVESTMENT} XNT`);
  log(`Min edge: ${MIN_EDGE_PERCENT}%`);
  log(`Max entry price: $${MAX_ENTRY_PRICE} (last-minute: $${LAST_MINUTE_MAX_PRICE})`);
  log(`Observation period: ${MIN_OBSERVATION_SECONDS}s`);
  log(`Exit window: ${EXIT_WINDOW_START}-${EXIT_WINDOW_END}s before end`);
  console.log("=".repeat(60) + "\n");

  const walletContent = fs.readFileSync(WALLET_PATH, "utf8").trim();
  const kp = Keypair.fromSecretKey(bs58.decode(walletContent));
  const conn = new Connection(RPC, "confirmed");
  const ammPda = getAmmPda();
  const posPda = getPositionPda(ammPda, kp.publicKey);

  log(`Wallet: ${kp.publicKey.toString()}`);

  let hasTraded = false;
  let tradedSide = null;
  let entryPrice = 0; // Track entry price for profit calculation

  // Check for existing position on startup
  const initialPos = await getPositionInfo(conn, getPositionPda(ammPda, kp.publicKey));
  if (initialPos.yesShares > 0 || initialPos.noShares > 0) {
    hasTraded = true;
    tradedSide = initialPos.yesShares > 0 ? 'yes' : 'no';
    // Get current price as entry price estimate for profit-taking
    const startupAmm = await getAmmState(conn, ammPda);
    if (startupAmm) {
      entryPrice = tradedSide === 'yes' ? startupAmm.pYes : startupAmm.pNo;
      log(`⚠️ Found existing position: ${initialPos.yesShares.toFixed(0)}Y/${initialPos.noShares.toFixed(0)}N @ ~$${entryPrice.toFixed(3)} - will not enter new trades this cycle`);
    } else {
      log(`⚠️ Found existing position: ${initialPos.yesShares.toFixed(0)}Y/${initialPos.noShares.toFixed(0)}N - will not enter new trades this cycle`);
    }
  }

  let lastCycleEndTime = 0; // Track cycle transitions

  // Main monitoring loop
  while (true) {
    try {
      const amm = await getAmmState(conn, ammPda);
      if (!amm || amm.status !== 1) {
        log("Market not active, waiting...");
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      const timeRemaining = amm.marketEndTime - Math.floor(Date.now() / 1000);
      const CYCLE_DURATION = 3540; // 59 minutes active (1h market)
      const timeElapsed = CYCLE_DURATION - timeRemaining;
      const oraclePrice = await getOraclePrice(conn);
      const startPrice = amm.startPriceE6 / 1e6;
      const priceDiff = oraclePrice - startPrice;
      const posInfo = await getPositionInfo(conn, posPda);

      // Determine current winning side
      const winningSide = priceDiff > 0 ? 'yes' : priceDiff < 0 ? 'no' : null;
      const winningPrice = winningSide === 'yes' ? amm.pYes : amm.pNo;
      const edge = winningSide ? (1 - winningPrice) * 100 : 0;

      // Track price history for momentum
      priceHistory.push({ price: oraclePrice, time: Date.now() });
      if (priceHistory.length > MOMENTUM_WINDOW) priceHistory.shift();

      // Calculate momentum (price change over last N readings)
      let momentum = 0;
      let momentumStr = '→';
      if (priceHistory.length >= 3) {
        const oldPrice = priceHistory[0].price;
        momentum = oraclePrice - oldPrice;
        if (momentum > 20) momentumStr = '🚀'; // Strong rally
        else if (momentum > 5) momentumStr = '↗';
        else if (momentum < -20) momentumStr = '💥'; // Dump
        else if (momentum < -5) momentumStr = '↘';
        else momentumStr = '→';
      }

      // Display status
      const priceDir = priceDiff > 0 ? '↑' : priceDiff < 0 ? '↓' : '→';
      console.log(`[${timeRemaining}s] Oracle: $${oraclePrice.toFixed(2)} ${priceDir}$${Math.abs(priceDiff).toFixed(2)} ${momentumStr} | YES: $${amm.pYes.toFixed(3)} NO: $${amm.pNo.toFixed(3)} | Pos: ${posInfo.yesShares.toFixed(0)}Y/${posInfo.noShares.toFixed(0)}N | Bal: ${posInfo.balance.toFixed(1)}`);

      // Check if position was settled (shares became 0) - reset trading state
      if (hasTraded && posInfo.yesShares === 0 && posInfo.noShares === 0) {
        log(`📊 Position settled/cleared - ready for new trades`);
        hasTraded = false;
        tradedSide = null;
        entryPrice = 0;
      }

      // Calculate cooldown for trade throttling (used in both reversal and entry logic)
      const now = Math.floor(Date.now() / 1000);
      const timeSinceLastTrade = now - lastTradeTime;
      const cooldownOk = timeSinceLastTrade >= TRADE_COOLDOWN || lastTradeTime === 0;

      // REVERSAL DETECTION: Exit based on conviction when momentum moves against us
      const hasPosition = posInfo.yesShares > 0 || posInfo.noShares > 0;
      if (hasPosition && timeRemaining > EXIT_WINDOW_END) {
        const heldSide = posInfo.yesShares > 0 ? 'yes' : 'no';
        const shares = heldSide === 'yes' ? posInfo.yesShares : posInfo.noShares;

        // Check if momentum is against our position
        const momentumAgainstUs = (heldSide === 'yes' && momentum < 0) || (heldSide === 'no' && momentum > 0);
        const priceAgainstUs = (heldSide === 'yes' && priceDiff < 0) || (heldSide === 'no' && priceDiff > 0);

        if (momentumAgainstUs && priceAgainstUs) {
          // Calculate exit conviction based on reversal strength
          const absMomentum = Math.abs(momentum);
          const absPriceDiff = Math.abs(priceDiff);

          let exitSize = 0;
          let exitLevel = 0;

          // Exit levels based on how bad the reversal is
          if (absMomentum >= 40 && absPriceDiff >= 50) {
            exitSize = shares; // Full exit - very strong reversal
            exitLevel = 4;
          } else if (absMomentum >= 25 && absPriceDiff >= 30) {
            exitSize = Math.min(35, shares);
            exitLevel = 3;
          } else if (absMomentum >= 15 && absPriceDiff >= 20) {
            exitSize = Math.min(20, shares);
            exitLevel = 2;
          } else if (absMomentum >= 10 && absPriceDiff >= 15) {
            exitSize = Math.min(10, shares);
            exitLevel = 1;
          }

          if (exitSize > 0 && cooldownOk) {
            logWarn(`🚨 REVERSAL L${exitLevel}! Momentum ${momentum > 0 ? '+' : ''}${momentum.toFixed(0)} against ${heldSide.toUpperCase()} - exiting ${exitSize.toFixed(1)} shares`);
            try {
              const sig = await executeTrade(conn, kp, ammPda, exitSize, heldSide, 'sell');
              logSuccess(`Exit ${exitSize.toFixed(1)} ${heldSide.toUpperCase()} [L${exitLevel}]: ${sig.slice(0,20)}...`);
              lastTradeTime = Math.floor(Date.now() / 1000);
              if (exitSize >= shares) {
                hasTraded = false;
                tradedSide = null;
              }
            } catch (err) {
              logError(`Exit failed: ${err.message}`);
            }
          }
        }
      }

      // Check in 45-60 second window before market end
      if (timeRemaining <= EXIT_WINDOW_START && timeRemaining >= EXIT_WINDOW_END) {
        const hasPosition = posInfo.yesShares > 0 || posInfo.noShares > 0;

        if (hasPosition) {
          const heldSide = posInfo.yesShares > 0 ? 'yes' : 'no';
          const shares = heldSide === 'yes' ? posInfo.yesShares : posInfo.noShares;

          if (heldSide !== winningSide) {
            // EXIT LOSING POSITION in exit window
            logWarn(`🚨 LOSING POSITION! Holding ${heldSide.toUpperCase()} but ${winningSide?.toUpperCase() || 'FLAT'} is winning - EXITING`);
            try {
              const sig = await executeTrade(conn, kp, ammPda, shares, heldSide, 'sell');
              logSuccess(`Exit ${shares.toFixed(1)} ${heldSide.toUpperCase()}: ${sig.slice(0,20)}...`);
              hasTraded = false;
              tradedSide = null;
            } catch (err) {
              logError(`Exit failed: ${err.message}`);
            }
          } else {
            log(`✅ Position OK - holding ${heldSide.toUpperCase()} and winning`);
          }
        } else if (!hasTraded && winningSide && edge >= 40 && Math.abs(priceDiff) >= MIN_PRICE_DIFF) {
          // No position - enter if signal is VERY strong (40%+ edge, $100+ diff) right before lockout
          // Check momentum alignment
          const lastMinMomentumAligned = (winningSide === 'yes' && momentum >= 0) || (winningSide === 'no' && momentum <= 0);

          if (winningPrice > LAST_MINUTE_MAX_PRICE) {
            log(`⚠️ SKIP last-minute: ${winningSide.toUpperCase()} at $${winningPrice.toFixed(3)} exceeds max $${LAST_MINUTE_MAX_PRICE}`);
          } else if (!lastMinMomentumAligned) {
            log(`⚠️ SKIP last-minute: Momentum opposing - price reversing against ${winningSide.toUpperCase()}`);
          } else {
            // Check slippage before entering
            const slippageInfo = calculateSlippage(amm, winningSide, MAX_CYCLE_INVESTMENT);
            if (slippageInfo.slippage > 0.50) {
              log(`⚠️ SKIP last-minute: Slippage $${slippageInfo.slippage.toFixed(3)} exceeds max $0.50`);
            } else {
              logWarn(`LAST-MINUTE ENTRY! Strong signal: ${winningSide.toUpperCase()} at $${winningPrice.toFixed(3)} with ${edge.toFixed(1)}% edge, diff $${Math.abs(priceDiff).toFixed(0)}`);
              log(`   Slippage: $${slippageInfo.slippage.toFixed(3)} (avg price: $${slippageInfo.avgPrice.toFixed(3)})`);
              try {
                const sig = await executeTrade(conn, kp, ammPda, MAX_CYCLE_INVESTMENT, winningSide, 'buy');
                logSuccess(`Last-minute buy ${MAX_CYCLE_INVESTMENT} XNT of ${winningSide.toUpperCase()}: ${sig.slice(0,20)}...`);
                hasTraded = true;
                tradedSide = winningSide;
              } catch (err) {
                logError(`Last-minute trade failed: ${err.message}`);
              }
            }
          }
        }
      }

      // Check for entry after observation period (don't enter within 90s of market end)
      // Allow multiple entries up to MAX_TOTAL_POSITION based on conviction level
      const currentPosition = posInfo.yesShares + posInfo.noShares;
      const remainingCapacity = MAX_TOTAL_POSITION - currentPosition;

      if (remainingCapacity > 0 && timeElapsed >= MIN_OBSERVATION_SECONDS && timeRemaining > EXIT_WINDOW_START && cooldownOk) {
        // Get conviction level based on current market conditions
        const conviction = getConvictionLevel(edge, priceDiff, momentum);

        if (winningSide && conviction) {
          // Check momentum alignment
          const momentumAligned = (winningSide === 'yes' && momentum >= 0) || (winningSide === 'no' && momentum <= 0);

          // Calculate trade size based on conviction, capped by remaining capacity
          const targetTradeSize = Math.min(conviction.tradeSize, remainingCapacity);

          console.log("\n" + "=".repeat(50));
          log("📊 TRADE ANALYSIS:");
          log(`   Start Price: $${startPrice.toFixed(2)}`);
          log(`   Current Price: $${oraclePrice.toFixed(2)} (${priceDiff > 0 ? '+' : ''}${priceDiff.toFixed(2)})`);
          log(`   Direction: ${winningSide.toUpperCase()} is winning`);
          log(`   Price Diff: $${Math.abs(priceDiff).toFixed(2)}`);
          log(`   Edge: ${edge.toFixed(1)}%`);
          log(`   Share Price: $${winningPrice.toFixed(3)} (max: $${MAX_ENTRY_PRICE})`);
          log(`   Momentum: ${momentum > 0 ? '+' : ''}${momentum.toFixed(2)} (${momentumAligned ? 'ALIGNED ✓' : 'OPPOSING ✗'})`);
          log(`   🎯 CONVICTION: Level ${conviction.level} → ${targetTradeSize} shares`);
          log(`   Current Position: ${currentPosition.toFixed(1)} / ${MAX_TOTAL_POSITION} max`);

          // Calculate slippage for this trade
          const slippageInfo = calculateSlippage(amm, winningSide, targetTradeSize);
          log(`   Slippage: $${slippageInfo.slippage.toFixed(3)} (avg price: $${slippageInfo.avgPrice.toFixed(3)})`);

          if (winningPrice > MAX_ENTRY_PRICE) {
            log(`   ⚠️ SKIP: Price $${winningPrice.toFixed(3)} too expensive (max $${MAX_ENTRY_PRICE})`);
            console.log("=".repeat(50) + "\n");
          } else if (slippageInfo.slippage > 0.50) {
            log(`   ⚠️ SKIP: Slippage $${slippageInfo.slippage.toFixed(3)} exceeds max $0.50`);
            console.log("=".repeat(50) + "\n");
          } else if (!momentumAligned) {
            log("   ⚠️ SKIP: Momentum MUST be aligned - price moving against us");
            console.log("=".repeat(50) + "\n");
          } else {
            log(`   ✅ DECISION: ENTER ${targetTradeSize} shares (Level ${conviction.level})`);
            console.log("=".repeat(50));
            try {
              const sig = await executeTrade(conn, kp, ammPda, targetTradeSize, winningSide, 'buy');
              logSuccess(`Bought ${targetTradeSize} XNT of ${winningSide.toUpperCase()} [L${conviction.level}]: ${sig.slice(0,20)}...`);
              hasTraded = true;
              tradedSide = winningSide;
              entryPrice = winningPrice;
              lastTradeTime = Math.floor(Date.now() / 1000); // Start cooldown
            } catch (err) {
              logError(`Trade failed: ${err.message}`);
            }
            console.log("");
          }
        }
      }

      // Reset for new cycle
      if (timeRemaining <= 0) {
        log("Cycle ended, resetting...");
        hasTraded = false;
        tradedSide = null;
        priceHistory = []; // Reset momentum tracking
        lastTradeTime = 0; // Reset cooldown
        await new Promise(r => setTimeout(r, 10000));
      }

      await new Promise(r => setTimeout(r, 5000));
    } catch (err) {
      logError(`Error: ${err.message}`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

runTradeManager().catch(err => {
  logError("Fatal:", err);
  process.exit(1);
});
