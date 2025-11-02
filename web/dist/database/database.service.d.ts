/**
 * Database service - SQLite connection and schema management
 */
import Database from 'better-sqlite3';
import { DatabaseConfig } from '../types';
/**
 * Database service class for managing SQLite connection and schema
 */
export declare class DatabaseService {
    private db;
    private config;
    constructor(config: DatabaseConfig);
    /**
     * Get the database instance
     */
    getDatabase(): Database.Database;
    /**
     * Initialize database schema (create tables and indexes)
     */
    private initializeSchema;
    /**
     * Get database statistics
     */
    getStats(): {
        priceCount: number;
        settlementCount: number;
        tradingCount: number;
        volumeCount: number;
        quoteCount: number;
    };
    /**
     * Close the database connection
     */
    close(): void;
    /**
     * Get the database configuration
     */
    getConfig(): DatabaseConfig;
}
//# sourceMappingURL=database.service.d.ts.map