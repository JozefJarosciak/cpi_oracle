"use strict";
/**
 * Market-related type definitions
 * Based on the Solana AMM program structure
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.Winner = exports.MarketStatus = void 0;
/**
 * Market status enum
 */
var MarketStatus;
(function (MarketStatus) {
    MarketStatus[MarketStatus["Open"] = 0] = "Open";
    MarketStatus[MarketStatus["Stopped"] = 1] = "Stopped";
    MarketStatus[MarketStatus["Settled"] = 2] = "Settled";
})(MarketStatus || (exports.MarketStatus = MarketStatus = {}));
/**
 * Winner enum for settled markets
 */
var Winner;
(function (Winner) {
    Winner[Winner["None"] = 0] = "None";
    Winner[Winner["Yes"] = 1] = "Yes";
    Winner[Winner["No"] = 2] = "No";
})(Winner || (exports.Winner = Winner = {}));
//# sourceMappingURL=market.types.js.map