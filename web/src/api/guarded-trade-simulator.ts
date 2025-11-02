/**
 * Guarded Trade Simulator
 *
 * Simulates trade execution with advanced guards to show users
 * what will happen when they execute on-chain. This mirrors the
 * logic in programs/cpi_oracle/src/lib.rs::validate_advanced_guards
 */

import type { AmmState } from '../types/market.types';

const MIN_SELL_E6 = 100_000; // 0.1 shares minimum

export interface AdvancedGuardConfig {
  priceLimitE6: number;          // 0 = no limit; max for BUY, min for SELL
  maxSlippageBps: number;        // 0 = no slippage check
  quotePriceE6: number;          // Reference price for slippage calc
  quoteTimestamp: number;        // When quote was generated (unix seconds)
  maxTotalCostE6: number;        // 0 = no max cost (only for BUY)
  allowPartial: boolean;         // Allow partial execution?
  minFillSharesE6: number;       // Minimum shares to execute (if partial)
}

export interface GuardValidationResult {
  priceLimit?: { passed: boolean; reason?: string };
  slippage?: { passed: boolean; reason?: string };
  costLimit?: { passed: boolean; reason?: string };
}

export interface SimulationResult {
  success: boolean;
  sharesToExecute: number;       // e6
  executionPrice: number;        // e6
  totalCost: number;             // e6
  isPartialFill: boolean;
  guardsStatus: GuardValidationResult;
  error?: string;
}

// LMSR helper functions (matching Rust implementation)
function sh(x: number): number {
  return x / 1_000_000.0;
}

function lmsrCost(amm: AmmState, qYesFloat: number, qNoFloat: number): number {
  // NOTE: amm.bScaled is already in human-readable units (not e6)
  // MarketService converts it: bScaled = Number(bScaled) / 1_000_000
  const b = amm.bScaled;
  const expY = Math.exp(qYesFloat / b);
  const expN = Math.exp(qNoFloat / b);
  return b * Math.log(expY + expN);
}

function lmsrBuyYesForShares(amm: AmmState, sharesE6: number): number {
  const pre = lmsrCost(amm, sh(amm.qYes), sh(amm.qNo));
  const post = lmsrCost(amm, sh(amm.qYes + sharesE6), sh(amm.qNo));
  const costFloat = post - pre;
  if (!isFinite(costFloat) || costFloat < 0) return 0;
  return Math.round(costFloat * 1_000_000);
}

function lmsrBuyNoForShares(amm: AmmState, sharesE6: number): number {
  const pre = lmsrCost(amm, sh(amm.qYes), sh(amm.qNo));
  const post = lmsrCost(amm, sh(amm.qYes), sh(amm.qNo + sharesE6));
  const costFloat = post - pre;
  if (!isFinite(costFloat) || costFloat < 0) return 0;
  return Math.round(costFloat * 1_000_000);
}

function calculateSellYesProceeds(amm: AmmState, sharesE6: number): number {
  const sellE6 = Math.min(sharesE6, amm.qYes);
  if (sellE6 <= 0) return 0;

  const pre = lmsrCost(amm, sh(amm.qYes), sh(amm.qNo));
  const post = lmsrCost(amm, sh(amm.qYes - sellE6), sh(amm.qNo));
  let grossH = pre - post;
  if (!isFinite(grossH) || grossH < 0) grossH = 0;

  const grossE6 = grossH * 1_000_000;
  const feeE6 = (grossE6 * amm.feeBps) / 10_000;
  const netE6 = Math.max(0, grossE6 - feeE6);
  return Math.round(netE6);
}

function calculateSellNoProceeds(amm: AmmState, sharesE6: number): number {
  const sellE6 = Math.min(sharesE6, amm.qNo);
  if (sellE6 <= 0) return 0;

  const pre = lmsrCost(amm, sh(amm.qYes), sh(amm.qNo));
  const post = lmsrCost(amm, sh(amm.qYes), sh(amm.qNo - sellE6));
  let grossH = pre - post;
  if (!isFinite(grossH) || grossH < 0) grossH = 0;

  const grossE6 = grossH * 1_000_000;
  const feeE6 = (grossE6 * amm.feeBps) / 10_000;
  const netE6 = Math.max(0, grossE6 - feeE6);
  return Math.round(netE6);
}

/**
 * Check if a given number of shares passes all guards
 */
function sharesPassGuards(
  sharesE6: number,
  action: number,
  side: number,
  guards: AdvancedGuardConfig,
  amm: AmmState
): { passed: boolean; validation: GuardValidationResult } {
  const validation: GuardValidationResult = {};

  // Calculate execution price and cost for this number of shares
  let executionPriceE6: number;
  let totalCostE6: number;

  if (action === 1) { // BUY
    const spendE6 = side === 1
      ? lmsrBuyYesForShares(amm, sharesE6)
      : lmsrBuyNoForShares(amm, sharesE6);
    executionPriceE6 = sharesE6 > 0 ? Math.floor((spendE6 * 1_000_000) / sharesE6) : 0;
    totalCostE6 = spendE6;
  } else { // SELL
    const proceedsE6 = side === 1
      ? calculateSellYesProceeds(amm, sharesE6)
      : calculateSellNoProceeds(amm, sharesE6);
    executionPriceE6 = sharesE6 > 0 ? Math.floor((proceedsE6 * 1_000_000) / sharesE6) : 0;
    totalCostE6 = proceedsE6;
  }

  let allPassed = true;

  // Check absolute price limit
  if (guards.priceLimitE6 > 0) {
    if (action === 1) { // BUY: execution price must not exceed limit
      const passed = executionPriceE6 <= guards.priceLimitE6;
      const details = `Exec: $${(executionPriceE6/1e6).toFixed(4)} vs Limit: $${(guards.priceLimitE6/1e6).toFixed(4)} (max for BUY)`;

      if (passed) {
        validation.priceLimit = { passed, reason: details };
      } else {
        validation.priceLimit = {
          passed,
          reason: `${details} → EXCEEDED`
        };
        allPassed = false;
      }
    } else { // SELL: execution price must not fall below limit
      const passed = executionPriceE6 >= guards.priceLimitE6;
      const details = `Exec: $${(executionPriceE6/1e6).toFixed(4)} vs Limit: $${(guards.priceLimitE6/1e6).toFixed(4)} (min for SELL)`;

      if (passed) {
        validation.priceLimit = { passed, reason: details };
      } else {
        validation.priceLimit = {
          passed,
          reason: `${details} → BELOW MIN`
        };
        allPassed = false;
      }
    }
  }

  // Check slippage against quote
  if (guards.maxSlippageBps > 0 && guards.quotePriceE6 > 0) {
    const maxDeviation = Math.floor((guards.quotePriceE6 * guards.maxSlippageBps) / 10_000);

    if (action === 1) { // BUY: price can go up by slippage%
      const maxPrice = guards.quotePriceE6 + maxDeviation;
      const passed = executionPriceE6 <= maxPrice;

      const details = `Quote: $${(guards.quotePriceE6/1e6).toFixed(4)} + ${(guards.maxSlippageBps/100).toFixed(1)}% = Max: $${(maxPrice/1e6).toFixed(4)}, Exec: $${(executionPriceE6/1e6).toFixed(4)}`;

      if (passed) {
        validation.slippage = { passed, reason: details };
      } else {
        validation.slippage = {
          passed,
          reason: `${details} → EXCEEDED`
        };
        allPassed = false;
      }
    } else { // SELL: price can go down by slippage%
      const minPrice = Math.max(0, guards.quotePriceE6 - maxDeviation);
      const passed = executionPriceE6 >= minPrice;

      const details = `Quote: $${(guards.quotePriceE6/1e6).toFixed(4)} - ${(guards.maxSlippageBps/100).toFixed(1)}% = Min: $${(minPrice/1e6).toFixed(4)}, Exec: $${(executionPriceE6/1e6).toFixed(4)}`;

      if (passed) {
        validation.slippage = { passed, reason: details };
      } else {
        validation.slippage = {
          passed,
          reason: `${details} → BELOW MIN`
        };
        allPassed = false;
      }
    }
  }

  // Check max total cost (only for BUY)
  if (action === 1 && guards.maxTotalCostE6 > 0) {
    const passed = totalCostE6 <= guards.maxTotalCostE6;
    const details = `Total cost: $${(totalCostE6/1e6).toFixed(2)} vs Limit: $${(guards.maxTotalCostE6/1e6).toFixed(2)}`;

    if (passed) {
      validation.costLimit = { passed, reason: details };
    } else {
      validation.costLimit = {
        passed,
        reason: `${details} → EXCEEDED`
      };
      allPassed = false;
    }
  }

  return { passed: allPassed, validation };
}

/**
 * Binary search to find maximum executable shares within guard constraints
 */
function findMaxExecutableShares(
  action: number,
  side: number,
  maxSharesE6: number,
  guards: AdvancedGuardConfig,
  amm: AmmState
): { shares: number; validation: GuardValidationResult } {
  const minTrade = action === 2 ? MIN_SELL_E6 : 100_000; // Min 0.1 shares
  let left = Math.max(guards.minFillSharesE6, minTrade);
  let right = maxSharesE6;
  let best = 0;
  let bestValidation: GuardValidationResult = {};

  // Binary search (max 16 iterations for compute efficiency)
  for (let i = 0; i < 16; i++) {
    if (left > right) break;

    const mid = Math.floor((left + right) / 2);
    const result = sharesPassGuards(mid, action, side, guards, amm);

    if (result.passed) {
      best = mid;
      bestValidation = result.validation;
      left = mid + 1; // Try larger
    } else {
      right = mid - 1; // Try smaller
    }
  }

  return { shares: best, validation: bestValidation };
}

/**
 * Simulate guarded trade execution
 */
export function simulateGuardedTrade(
  side: number,           // 1 = YES, 2 = NO
  action: number,         // 1 = BUY, 2 = SELL
  amountE6: number,       // Requested shares (e6)
  guards: AdvancedGuardConfig,
  amm: AmmState
): SimulationResult {
  // Validate quote staleness if using slippage guard
  if (guards.maxSlippageBps > 0 && guards.quotePriceE6 > 0) {
    const now = Math.floor(Date.now() / 1000);
    if (now - guards.quoteTimestamp > 30) {
      return {
        success: false,
        sharesToExecute: 0,
        executionPrice: 0,
        totalCost: 0,
        isPartialFill: false,
        guardsStatus: {},
        error: 'Quote is stale (>30 seconds old). Please fetch a fresh quote.'
      };
    }
  }

  // Validate guard configuration
  if (guards.allowPartial && guards.minFillSharesE6 <= 0) {
    return {
      success: false,
      sharesToExecute: 0,
      executionPrice: 0,
      totalCost: 0,
      isPartialFill: false,
      guardsStatus: {},
      error: 'Invalid guard config: partial fills enabled but no minimum fill specified'
    };
  }

  // Try full execution first
  const fullResult = sharesPassGuards(amountE6, action, side, guards, amm);

  if (fullResult.passed) {
    // Calculate final execution details
    let executionPriceE6: number;
    let totalCostE6: number;

    if (action === 1) { // BUY
      const spendE6 = side === 1
        ? lmsrBuyYesForShares(amm, amountE6)
        : lmsrBuyNoForShares(amm, amountE6);
      executionPriceE6 = Math.floor((spendE6 * 1_000_000) / amountE6);
      totalCostE6 = spendE6;
    } else { // SELL
      const proceedsE6 = side === 1
        ? calculateSellYesProceeds(amm, amountE6)
        : calculateSellNoProceeds(amm, amountE6);
      executionPriceE6 = Math.floor((proceedsE6 * 1_000_000) / amountE6);
      totalCostE6 = proceedsE6;
    }

    return {
      success: true,
      sharesToExecute: amountE6,
      executionPrice: executionPriceE6,
      totalCost: totalCostE6,
      isPartialFill: false,
      guardsStatus: fullResult.validation
    };
  }

  // If partial fills not allowed, reject
  if (!guards.allowPartial) {
    return {
      success: false,
      sharesToExecute: 0,
      executionPrice: 0,
      totalCost: 0,
      isPartialFill: false,
      guardsStatus: fullResult.validation,
      error: 'Full execution failed and partial fills not enabled'
    };
  }

  // Binary search for max executable shares
  const partialResult = findMaxExecutableShares(action, side, amountE6, guards, amm);

  if (partialResult.shares < guards.minFillSharesE6) {
    return {
      success: false,
      sharesToExecute: partialResult.shares,
      executionPrice: 0,
      totalCost: 0,
      isPartialFill: false,
      guardsStatus: partialResult.validation,
      error: `Max executable shares (${(partialResult.shares/1e6).toFixed(2)}) below minimum fill requirement (${(guards.minFillSharesE6/1e6).toFixed(2)})`
    };
  }

  // Calculate final execution details for partial fill
  let executionPriceE6: number;
  let totalCostE6: number;

  if (action === 1) { // BUY
    const spendE6 = side === 1
      ? lmsrBuyYesForShares(amm, partialResult.shares)
      : lmsrBuyNoForShares(amm, partialResult.shares);
    executionPriceE6 = Math.floor((spendE6 * 1_000_000) / partialResult.shares);
    totalCostE6 = spendE6;
  } else { // SELL
    const proceedsE6 = side === 1
      ? calculateSellYesProceeds(amm, partialResult.shares)
      : calculateSellNoProceeds(amm, partialResult.shares);
    executionPriceE6 = Math.floor((proceedsE6 * 1_000_000) / partialResult.shares);
    totalCostE6 = proceedsE6;
  }

  return {
    success: true,
    sharesToExecute: partialResult.shares,
    executionPrice: executionPriceE6,
    totalCost: totalCostE6,
    isPartialFill: true,
    guardsStatus: partialResult.validation
  };
}
