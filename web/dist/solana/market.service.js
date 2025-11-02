"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MarketService = void 0;
const web3_js_1 = require("@solana/web3.js");
const types_1 = require("../types");
/**
 * Market Service - Fetches AMM state from Solana program account
 *
 * Deserializes the AMM account structure:
 * - Discriminator (8 bytes)
 * - Bump (1 byte)
 * - Decimals (1 byte)
 * - b_scaled (8 bytes)
 * - fee_bps (2 bytes)
 * - q_yes, q_no, fees_collected, vault_e6 (8 bytes each)
 * - status, winner (1 byte each)
 * - winning_total, price_per_share (8 bytes each)
 * - fee_dest (32 bytes)
 * - vault_sol_bump (1 byte)
 * - start_price_e6 (8 bytes)
 * - market_end_time (8 bytes, optional)
 */
class MarketService {
    constructor(connection, programId, config) {
        this.connection = connection;
        this.programId = new web3_js_1.PublicKey(programId);
        this.config = {
            ammSeed: config?.ammSeed ?? 'amm_btc_v6',
            pollInterval: config?.pollInterval ?? 1500,
            lamportsPerE6: config?.lamportsPerE6 ?? 100,
            enableLogging: config?.enableLogging ?? true,
        };
    }
    /**
     * Fetch current AMM state from Solana
     * @returns AmmState or null if fetch fails
     */
    async fetchMarketState() {
        try {
            const ammPda = this.deriveAmmPda();
            this.log(`Fetching market state from PDA: ${ammPda.toString()}`);
            const accountInfo = await this.connection.getAccountInfo(ammPda);
            if (!accountInfo) {
                this.logError(`Market account not found at: ${ammPda.toString()}`);
                return null;
            }
            return this.deserializeAmmAccount(accountInfo);
        }
        catch (err) {
            const error = err;
            this.logError(`Failed to fetch market state: ${error.message}`);
            return null;
        }
    }
    /**
     * Derive AMM PDA from program ID and seed
     */
    deriveAmmPda() {
        const [pda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from(this.config.ammSeed)], this.programId);
        return pda;
    }
    /**
     * Deserialize AMM account data
     * @param accountInfo - Raw account info from Solana
     * @returns Parsed AMM state or null
     */
    deserializeAmmAccount(accountInfo) {
        try {
            const d = accountInfo.data;
            // Validate minimum size: 8 (disc) + 62 (core fields) = 70
            const MIN_SIZE = 8 + 62;
            if (d.length < MIN_SIZE) {
                this.logError(`Market data invalid: expected at least ${MIN_SIZE} bytes, got ${d.length}`);
                return null;
            }
            // Skip discriminator (8 bytes) and work with payload
            const payload = d.subarray(8);
            let offset = 0;
            // Helper functions for reading
            const readU8 = () => {
                const value = payload.readUInt8(offset);
                offset += 1;
                return value;
            };
            const readU16LE = () => {
                const value = payload.readUInt16LE(offset);
                offset += 2;
                return value;
            };
            const readI64LE = () => {
                const value = payload.readBigInt64LE(offset);
                offset += 8;
                return value;
            };
            const readPublicKey = () => {
                const keyBytes = payload.subarray(offset, offset + 32);
                offset += 32;
                return new web3_js_1.PublicKey(keyBytes);
            };
            // Read AMM fields in order
            const bump = readU8();
            const decimals = readU8();
            const bScaled = readI64LE();
            const feeBps = readU16LE();
            const qYes = readI64LE();
            const qNo = readI64LE();
            const feesCollected = readI64LE();
            const vaultE6 = readI64LE();
            const status = readU8();
            const winner = readU8();
            const winningTotal = readI64LE();
            const pricePerShare = readI64LE();
            const feeDest = readPublicKey();
            const vaultSolBump = readU8();
            const startPriceE6 = readI64LE();
            // Optional: market_end_time (if present)
            let marketEndTime = null;
            if (d.length >= MIN_SIZE + 8) {
                marketEndTime = readI64LE();
            }
            // Convert to JavaScript numbers with proper scaling
            // NOTE: vault uses LAMPORTS_PER_E6 = 100, so 1 XNT = 10_000_000 e6 units
            const LAMPORTS_PER_E6 = this.config.lamportsPerE6;
            const vaultLamportsScale = LAMPORTS_PER_E6 * 100000; // 10_000_000 for 1 XNT
            const baseState = {
                bump,
                decimals,
                bScaled: Number(bScaled) / 1000000,
                feeBps,
                qYes: Number(qYes) / 1000000,
                qNo: Number(qNo) / 1000000,
                feesCollected: Number(feesCollected) / 1000000,
                vault: Number(vaultE6) / vaultLamportsScale,
                status: this.parseMarketStatus(status),
                winner: this.parseWinner(winner),
                winningTotal: Number(winningTotal) / 1000000,
                pricePerShare: Number(pricePerShare) / 1000000,
                feeDest,
                vaultSolBump,
                startPrice: Number(startPriceE6) / 1000000,
                timestamp: Date.now(),
            };
            // Conditionally add marketEndTime only if present
            const ammState = marketEndTime !== null
                ? { ...baseState, marketEndTime: Number(marketEndTime) }
                : baseState;
            this.log(`Market: status=${types_1.MarketStatus[ammState.status]} vault=${ammState.vault.toFixed(2)} ` +
                `qY=${ammState.qYes.toFixed(2)} qN=${ammState.qNo.toFixed(2)}`);
            return ammState;
        }
        catch (err) {
            const error = err;
            this.logError(`Failed to deserialize AMM account: ${error.message}`);
            return null;
        }
    }
    /**
     * Parse market status enum
     */
    parseMarketStatus(status) {
        switch (status) {
            case 0:
                return types_1.MarketStatus.Open;
            case 1:
                return types_1.MarketStatus.Stopped;
            case 2:
                return types_1.MarketStatus.Settled;
            default:
                this.logError(`Unknown market status: ${status}, defaulting to Open`);
                return types_1.MarketStatus.Open;
        }
    }
    /**
     * Parse winner enum
     */
    parseWinner(winner) {
        switch (winner) {
            case 0:
                return types_1.Winner.None;
            case 1:
                return types_1.Winner.Yes;
            case 2:
                return types_1.Winner.No;
            default:
                this.logError(`Unknown winner: ${winner}, defaulting to None`);
                return types_1.Winner.None;
        }
    }
    /**
     * Calculate LMSR prices from AMM state
     * @param ammState - Current AMM state
     * @returns Calculated YES/NO probabilities
     */
    calculatePrices(ammState) {
        const b = ammState.bScaled;
        const qY = ammState.qYes;
        const qN = ammState.qNo;
        // LMSR: P(YES) = e^(qY/b) / (e^(qY/b) + e^(qN/b))
        const expY = Math.exp(qY / b);
        const expN = Math.exp(qN / b);
        const sum = expY + expN;
        const probYes = expY / sum;
        const probNo = expN / sum;
        return {
            probYes,
            probNo,
            yesPrice: probYes,
            noPrice: probNo,
        };
    }
    /**
     * Get AMM PDA address
     */
    getAmmAddress() {
        return this.deriveAmmPda();
    }
    /**
     * Get market configuration
     */
    getConfig() {
        return { ...this.config };
    }
    /**
     * Update configuration
     */
    updateConfig(config) {
        this.config = { ...this.config, ...config };
    }
    /**
     * Log info message if logging enabled
     */
    log(message) {
        if (this.config.enableLogging) {
            console.log(`📈 ${message}`);
        }
    }
    /**
     * Log error message
     */
    logError(message) {
        console.error(`[MarketService] ${message}`);
    }
}
exports.MarketService = MarketService;
//# sourceMappingURL=market.service.js.map