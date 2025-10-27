#!/usr/bin/env node
// Migration script: JSON price history → SQLite

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'price_history.db');
const JSON_FILE = path.join(__dirname, 'price_history.json');

console.log('🔄 Migrating price history from JSON to SQLite...');

// Create/open database
const db = new Database(DB_FILE);

// Create schema
console.log('📋 Creating schema...');
db.exec(`
    CREATE TABLE IF NOT EXISTS price_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        price REAL NOT NULL,
        timestamp INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_timestamp ON price_history(timestamp);
`);

// Check if we need to migrate
const count = db.prepare('SELECT COUNT(*) as count FROM price_history').get();
if (count.count > 0) {
    console.log(`✓ Database already has ${count.count} records. Checking for new data...`);
} else {
    console.log('📦 Empty database, will migrate all data...');
}

// Load JSON data
if (fs.existsSync(JSON_FILE)) {
    console.log('📂 Loading JSON data...');
    const jsonData = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));

    if (!jsonData.prices || !Array.isArray(jsonData.prices)) {
        console.error('❌ Invalid JSON format');
        process.exit(1);
    }

    console.log(`📊 Found ${jsonData.prices.length} price records in JSON`);

    // Get the latest timestamp in DB to avoid duplicates
    const latestRow = db.prepare('SELECT MAX(timestamp) as latest FROM price_history').get();
    const latestTimestamp = latestRow.latest || 0;

    // Prepare insert statement
    const insert = db.prepare('INSERT INTO price_history (price, timestamp) VALUES (?, ?)');

    // Batch insert with transaction
    const insertMany = db.transaction((prices) => {
        let inserted = 0;
        for (const item of prices) {
            const price = typeof item === 'number' ? item : item.price;
            const timestamp = item.timestamp || Date.now();

            // Skip if already exists
            if (timestamp <= latestTimestamp) continue;

            insert.run(price, timestamp);
            inserted++;
        }
        return inserted;
    });

    console.log('💾 Inserting data into SQLite...');
    const inserted = insertMany(jsonData.prices);
    console.log(`✓ Inserted ${inserted} new records`);

    // Show final stats
    const finalCount = db.prepare('SELECT COUNT(*) as count FROM price_history').get();
    console.log(`✓ Total records in database: ${finalCount.count}`);

    // Backup JSON file
    const backupFile = JSON_FILE + '.backup';
    fs.copyFileSync(JSON_FILE, backupFile);
    console.log(`✓ Created backup: ${backupFile}`);

} else {
    console.log('⚠️  No JSON file found at:', JSON_FILE);
}

// Show database info
const dbStats = db.prepare(`
    SELECT
        COUNT(*) as total_records,
        MIN(timestamp) as oldest,
        MAX(timestamp) as newest
    FROM price_history
`).get();

if (dbStats.total_records > 0) {
    const oldestDate = new Date(dbStats.oldest);
    const newestDate = new Date(dbStats.newest);
    console.log('\n📈 Database Statistics:');
    console.log(`   Total Records: ${dbStats.total_records}`);
    console.log(`   Oldest: ${oldestDate.toLocaleString()}`);
    console.log(`   Newest: ${newestDate.toLocaleString()}`);
    console.log(`   File Size: ${(fs.statSync(DB_FILE).size / 1024 / 1024).toFixed(2)} MB`);
}

db.close();
console.log('\n✅ Migration complete!');
