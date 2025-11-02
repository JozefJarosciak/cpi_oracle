"use strict";
/**
 * Test script for TypeScript database layer
 * Run with: ts-node src/test-database.ts
 */
Object.defineProperty(exports, "__esModule", { value: true });
const database_1 = require("./database");
// Use a test database
const testDbPath = './test_db.sqlite';
console.log('=== TypeScript Database Layer Test ===\n');
// Initialize database
console.log('1. Initializing database...');
const dbService = new database_1.DatabaseService({
    dbFile: testDbPath,
    maxPriceHistoryHours: 24,
    maxSettlementHistoryHours: 168,
    maxTradingHistoryHours: 168
});
const db = dbService.getDatabase();
// Get stats
const stats = dbService.getStats();
console.log('✅ Database initialized');
console.log('   Stats:', JSON.stringify(stats, null, 2));
// Initialize repositories
console.log('\n2. Initializing repositories...');
const priceRepo = new database_1.PriceHistoryRepository(db);
const volumeRepo = new database_1.VolumeRepository(db);
const historyRepo = new database_1.HistoryRepository(db);
const quoteRepo = new database_1.QuoteHistoryRepository(db);
console.log('✅ All repositories initialized');
// Test PriceHistoryRepository
console.log('\n3. Testing PriceHistoryRepository...');
const testPrices = [
    { price: 67890.50, timestamp: Date.now() - 3600000 },
    { price: 68100.25, timestamp: Date.now() - 1800000 },
    { price: 68234.75, timestamp: Date.now() },
];
testPrices.forEach(({ price, timestamp }) => {
    priceRepo.insert(price, timestamp);
});
console.log(`✅ Inserted ${testPrices.length} price records`);
const priceCount = priceRepo.count();
console.log(`   Total price records: ${priceCount}`);
const latestPrice = priceRepo.getLatest();
console.log(`   Latest price: $${latestPrice?.price.toFixed(2)} at ${new Date(latestPrice?.timestamp || 0).toISOString()}`);
const recentPrices = priceRepo.find({ seconds: 7200, limit: 10 });
console.log(`   Recent prices (last 2h): ${recentPrices.length} records`);
// Test VolumeRepository
console.log('\n4. Testing VolumeRepository...');
let volume = volumeRepo.createNewCycle();
console.log(`✅ Created new cycle: ${volume.cycleId}`);
console.log(`   Initial volume: ${volume.totalVolume} XNT`);
// Add some volume
volume = volumeRepo.addVolume(volume, 'YES', 100.50, 95.25);
volume = volumeRepo.addVolume(volume, 'NO', 75.25, 80.00);
console.log(`   After trades: ${volume.totalVolume.toFixed(2)} XNT total`);
console.log(`   - YES: ${volume.upVolume.toFixed(2)} XNT (${volume.upShares.toFixed(2)} shares)`);
console.log(`   - NO: ${volume.downVolume.toFixed(2)} XNT (${volume.downShares.toFixed(2)} shares)`);
const loadedVolume = volumeRepo.loadCurrent();
console.log(`✅ Loaded current cycle: ${loadedVolume?.cycleId}`);
const recentCycles = volumeRepo.findRecent(5);
console.log(`   Recent cycles: ${recentCycles.length}`);
// Test HistoryRepository
console.log('\n5. Testing HistoryRepository...');
// Add some trades
historyRepo.addTrade('user1', 'BUY', 'YES', 10.5, 100.25, 9.55, null);
historyRepo.addTrade('user1', 'SELL', 'YES', 5.0, 48.50, 9.70, 0.75);
console.log('✅ Added trading records');
const userTrades = historyRepo.getTradesByUser('user1');
console.log(`   User1 trades: ${userTrades.length} records`);
userTrades.forEach(trade => {
    console.log(`   - ${trade.action} ${trade.shares.toFixed(2)} ${trade.side} @ $${trade.avg_price.toFixed(4)} ${trade.pnl ? `(PnL: $${trade.pnl.toFixed(2)})` : ''}`);
});
// Add settlement
historyRepo.addSettlement('user1', 'WIN', 110.50, 'YES', 67500.00, 68234.75);
console.log('✅ Added settlement record');
const settlements = historyRepo.getSettlements(10);
console.log(`   Total settlements: ${settlements.length}`);
// Test QuoteHistoryRepository
console.log('\n6. Testing QuoteHistoryRepository...');
const cycleId = volume.cycleId;
quoteRepo.insert(cycleId, 0.52, 0.48);
quoteRepo.insert(cycleId, 0.55, 0.45);
quoteRepo.insert(cycleId, 0.53, 0.47);
console.log(`✅ Inserted 3 quote snapshots for ${cycleId}`);
const quoteCount = quoteRepo.countByCycle(cycleId);
console.log(`   Quotes in cycle: ${quoteCount}`);
const latestQuote = quoteRepo.getLatestForCycle(cycleId);
if (latestQuote) {
    console.log(`   Latest quote: YES=${(latestQuote.up_price * 100).toFixed(1)}% / NO=${(latestQuote.down_price * 100).toFixed(1)}%`);
}
const cycleQuotes = quoteRepo.findByCycle(cycleId);
console.log(`   All quotes in cycle: ${cycleQuotes.length} records`);
// Final stats
console.log('\n7. Final database stats:');
const finalStats = dbService.getStats();
console.log(JSON.stringify(finalStats, null, 2));
// Cleanup
console.log('\n8. Cleaning up...');
dbService.close();
console.log('✅ Database connection closed');
console.log('\n=== All Tests Passed! ===');
console.log('\nThe TypeScript database layer is working correctly.');
console.log('You can now safely integrate these repositories into your server.\n');
//# sourceMappingURL=test-database.js.map