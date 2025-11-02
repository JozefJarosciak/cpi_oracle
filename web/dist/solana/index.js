"use strict";
/**
 * Solana Integration Module
 *
 * Provides type-safe services for interacting with Solana blockchain:
 * - OracleService: Fetch BTC prices from oracle account
 * - MarketService: Fetch AMM state from market account
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MarketService = exports.OracleService = void 0;
var oracle_service_1 = require("./oracle.service");
Object.defineProperty(exports, "OracleService", { enumerable: true, get: function () { return oracle_service_1.OracleService; } });
var market_service_1 = require("./market.service");
Object.defineProperty(exports, "MarketService", { enumerable: true, get: function () { return market_service_1.MarketService; } });
//# sourceMappingURL=index.js.map