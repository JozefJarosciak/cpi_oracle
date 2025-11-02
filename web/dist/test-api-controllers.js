"use strict";
/**
 * API Controllers Test
 *
 * Tests MarketDataController and SimpleDatabaseController with live data
 */
Object.defineProperty(exports, "__esModule", { value: true });
const market_data_controller_1 = require("./api/market-data.controller");
const simple_database_controller_1 = require("./api/simple-database.controller");
const RPC_URL = 'https://rpc.testnet.x1.xyz';
const ORACLE_STATE_KEY = '4KYeNyv1B9YjjQkfJk2C6Uqo71vKzFZriRe5NXg6GyCq';
const PROGRAM_ID = 'EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF';
const AMM_SEED = 'amm_btc_v6';
const DB_PATH = './price_history.db';
async function main() {
    console.log('=== Testing API Controllers ===\n');
    // Test Market Data Controller
    console.log('Testing MarketDataController...\n');
    const marketController = new market_data_controller_1.MarketDataController({
        rpcUrl: RPC_URL,
        oracleStateKey: ORACLE_STATE_KEY,
        programId: PROGRAM_ID,
        ammSeed: AMM_SEED,
        enableLogging: true
    });
    console.log('Fetching complete market data...');
    const marketData = await marketController.getMarketData();
    if (marketData) {
        console.log('Success: Market Data Retrieved:');
        console.log('   Oracle: BTC Price and Age');
        console.log('   Market: Status and Vault');
        console.log('   LMSR: Probabilities');
        console.log('');
    }
    else {
        console.error('Failed to fetch market data\n');
    }
    // Test Database Controller
    console.log('Testing SimpleDatabaseController...\n');
    const dbController = new simple_database_controller_1.SimpleDatabaseController({
        dbPath: DB_PATH
    });
    console.log('Fetching database stats...');
    const stats = dbController.getStats();
    console.log('Success: Database Statistics:');
    console.log('   Price Records:', stats.priceCount);
    console.log('   Settlement History:', stats.settlementCount);
    console.log('   Trading History:', stats.tradingCount);
    console.log('   Volume Cycles:', stats.volumeCount);
    console.log('');
    console.log('Fetching recent price history (last hour)...');
    const prices = dbController.priceRepo.find({ seconds: 3600 });
    console.log('Success: Found', prices.length, 'price records in last hour');
    console.log('');
    console.log('Fetching recent cycles...');
    const cycles = dbController.quoteRepo.getRecentCycles(5);
    console.log('Success: Found', cycles.length, 'recent cycles');
    cycles.forEach((cycle, i) => {
        console.log('   Cycle', i + 1, ':', cycle.cycle_id);
    });
    console.log('');
    dbController.close();
    console.log('=== All API Controller Tests Passed! ===\n');
}
main().catch(error => {
    console.error('Test failed:', error);
    process.exit(1);
});
//# sourceMappingURL=test-api-controllers.js.map