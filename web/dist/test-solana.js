"use strict";
/**
 * Test Solana Integration Services
 *
 * This tests the OracleService and MarketService with real Solana data
 */
Object.defineProperty(exports, "__esModule", { value: true });
const web3_js_1 = require("@solana/web3.js");
const oracle_service_1 = require("./solana/oracle.service");
const market_service_1 = require("./solana/market.service");
// Configuration from server.js
const RPC_URL = 'https://rpc.testnet.x1.xyz';
const ORACLE_STATE = '4KYeNyv1B9YjjQkfJk2C6Uqo71vKzFZriRe5NXg6GyCq';
const PROGRAM_ID = 'EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF';
const AMM_SEED = 'amm_btc_v6';
async function testOracleService() {
    console.log('\n=== Testing OracleService ===\n');
    const connection = new web3_js_1.Connection(RPC_URL, 'confirmed');
    const oracleService = new oracle_service_1.OracleService(connection, ORACLE_STATE, {
        pollInterval: 1000,
        maxAge: 90,
        enableLogging: true,
    });
    console.log('Oracle Key:', oracleService.getOracleKey().toString());
    console.log('Config:', oracleService.getConfig());
    const price = await oracleService.fetchPrice();
    if (price) {
        console.log('\n✅ Successfully fetched oracle price:');
        console.log('   Price:', price.price.toFixed(2), 'USD');
        console.log('   Age:', price.age, 'seconds');
        console.log('   Triplet:', price.triplet);
        console.log('   Timestamp:', new Date(price.timestamp).toISOString());
    }
    else {
        console.error('❌ Failed to fetch oracle price');
        process.exit(1);
    }
}
async function testMarketService() {
    console.log('\n=== Testing MarketService ===\n');
    const connection = new web3_js_1.Connection(RPC_URL, 'confirmed');
    const marketService = new market_service_1.MarketService(connection, PROGRAM_ID, {
        ammSeed: AMM_SEED,
        pollInterval: 1500,
        lamportsPerE6: 100,
        enableLogging: true,
    });
    console.log('AMM PDA:', marketService.getAmmAddress().toString());
    console.log('Config:', marketService.getConfig());
    const marketState = await marketService.fetchMarketState();
    if (marketState) {
        console.log('\n✅ Successfully fetched market state:');
        console.log('   Status:', ['Open', 'Stopped', 'Settled'][marketState.status]);
        console.log('   Winner:', ['None', 'Yes', 'No'][marketState.winner]);
        console.log('   Vault:', marketState.vault.toFixed(2), 'XNT');
        console.log('   b (liquidity):', marketState.bScaled.toFixed(2));
        console.log('   qYes:', marketState.qYes.toFixed(2));
        console.log('   qNo:', marketState.qNo.toFixed(2));
        console.log('   Fee (bps):', marketState.feeBps);
        console.log('   Fees Collected:', marketState.feesCollected.toFixed(2));
        console.log('   Start Price:', marketState.startPrice.toFixed(2));
        console.log('   Timestamp:', new Date(marketState.timestamp).toISOString());
        // Calculate and display LMSR prices
        const prices = marketService.calculatePrices(marketState);
        console.log('\n   LMSR Prices:');
        console.log('   YES probability:', (prices.probYes * 100).toFixed(2) + '%');
        console.log('   NO probability:', (prices.probNo * 100).toFixed(2) + '%');
        console.log('   Sum check:', (prices.probYes + prices.probNo).toFixed(6), '(should be ~1.0)');
    }
    else {
        console.error('❌ Failed to fetch market state');
        process.exit(1);
    }
}
async function main() {
    try {
        await testOracleService();
        await testMarketService();
        console.log('\n=== All Solana Tests Passed! ===\n');
    }
    catch (err) {
        const error = err;
        console.error('Test failed:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}
main();
//# sourceMappingURL=test-solana.js.map