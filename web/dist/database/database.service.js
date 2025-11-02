"use strict";
/**
 * Database service - SQLite connection and schema management
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DatabaseService = void 0;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
/**
 * Database service class for managing SQLite connection and schema
 */
class DatabaseService {
    constructor(config) {
        this.config = config;
        this.db = new better_sqlite3_1.default(config.dbFile);
        this.db.pragma('journal_mode = WAL'); // Better concurrency
        this.initializeSchema();
    }
    /**
     * Get the database instance
     */
    getDatabase() {
        return this.db;
    }
    /**
     * Initialize database schema (create tables and indexes)
     */
    initializeSchema() {
        this.db.exec(`
      -- Price history table
      CREATE TABLE IF NOT EXISTS price_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        price REAL NOT NULL,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_timestamp ON price_history(timestamp);

      -- Settlement history table
      CREATE TABLE IF NOT EXISTS settlement_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_prefix TEXT NOT NULL,
        result TEXT NOT NULL,
        amount REAL NOT NULL,
        side TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        snapshot_price REAL,
        settle_price REAL,
        total_buys REAL,
        total_sells REAL,
        net_spent REAL
      );
      CREATE INDEX IF NOT EXISTS idx_settlement_timestamp ON settlement_history(timestamp);

      -- Trading history table
      CREATE TABLE IF NOT EXISTS trading_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_prefix TEXT NOT NULL,
        action TEXT NOT NULL,
        side TEXT NOT NULL,
        shares REAL NOT NULL,
        cost_usd REAL NOT NULL,
        avg_price REAL NOT NULL,
        pnl REAL,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trading_user_timestamp ON trading_history(user_prefix, timestamp DESC);

      -- Volume history table
      CREATE TABLE IF NOT EXISTS volume_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cycle_id TEXT NOT NULL UNIQUE,
        cycle_start_time INTEGER NOT NULL,
        up_volume REAL NOT NULL DEFAULT 0,
        down_volume REAL NOT NULL DEFAULT 0,
        total_volume REAL NOT NULL DEFAULT 0,
        up_shares REAL NOT NULL DEFAULT 0,
        down_shares REAL NOT NULL DEFAULT 0,
        total_shares REAL NOT NULL DEFAULT 0,
        last_update INTEGER NOT NULL,
        market_state TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_volume_cycle ON volume_history(cycle_id);
      CREATE INDEX IF NOT EXISTS idx_volume_start_time ON volume_history(cycle_start_time DESC);

      -- Quote history table
      CREATE TABLE IF NOT EXISTS quote_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cycle_id TEXT NOT NULL,
        up_price REAL NOT NULL,
        down_price REAL NOT NULL,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_quote_cycle_time ON quote_history(cycle_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_quote_timestamp ON quote_history(timestamp DESC);
    `);
    }
    /**
     * Get database statistics
     */
    getStats() {
        const priceCount = this.db.prepare('SELECT COUNT(*) as count FROM price_history').get();
        const settlementCount = this.db.prepare('SELECT COUNT(*) as count FROM settlement_history').get();
        const tradingCount = this.db.prepare('SELECT COUNT(*) as count FROM trading_history').get();
        const volumeCount = this.db.prepare('SELECT COUNT(*) as count FROM volume_history').get();
        const quoteCount = this.db.prepare('SELECT COUNT(*) as count FROM quote_history').get();
        return {
            priceCount: priceCount.count,
            settlementCount: settlementCount.count,
            tradingCount: tradingCount.count,
            volumeCount: volumeCount.count,
            quoteCount: quoteCount.count,
        };
    }
    /**
     * Close the database connection
     */
    close() {
        this.db.close();
    }
    /**
     * Get the database configuration
     */
    getConfig() {
        return this.config;
    }
}
exports.DatabaseService = DatabaseService;
//# sourceMappingURL=database.service.js.map