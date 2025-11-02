/**
 * Guarded Trade Simulator
 *
 * Simulates trade execution with advanced guards to show users
 * what will happen when they execute on-chain. This mirrors the
 * logic in programs/cpi_oracle/src/lib.rs::validate_advanced_guards
 */
import type { AmmState } from '../types/market.types';
export interface AdvancedGuardConfig {
    priceLimitE6: number;
    maxSlippageBps: number;
    quotePriceE6: number;
    quoteTimestamp: number;
    maxTotalCostE6: number;
    allowPartial: boolean;
    minFillSharesE6: number;
}
export interface GuardValidationResult {
    priceLimit?: {
        passed: boolean;
        reason?: string;
    };
    slippage?: {
        passed: boolean;
        reason?: string;
    };
    costLimit?: {
        passed: boolean;
        reason?: string;
    };
}
export interface SimulationResult {
    success: boolean;
    sharesToExecute: number;
    executionPrice: number;
    totalCost: number;
    isPartialFill: boolean;
    guardsStatus: GuardValidationResult;
    error?: string;
}
/**
 * Simulate guarded trade execution
 */
export declare function simulateGuardedTrade(side: number, // 1 = YES, 2 = NO
action: number, // 1 = BUY, 2 = SELL
amountE6: number, // Requested shares (e6)
guards: AdvancedGuardConfig, amm: AmmState): SimulationResult;
//# sourceMappingURL=guarded-trade-simulator.d.ts.map