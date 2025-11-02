/**
 * Volume repository - handles cumulative volume tracking per market cycle
 */
import Database from 'better-sqlite3';
import { CumulativeVolume } from '../types';
/**
 * Repository for managing volume data across market cycles
 */
export declare class VolumeRepository {
    private db;
    constructor(db: Database.Database);
    /**
     * Load the most recent cycle's volume data
     */
    loadCurrent(): CumulativeVolume | null;
    /**
     * Save or update volume data for a cycle
     */
    save(volume: CumulativeVolume): boolean;
    /**
     * Create a new cycle with initial volume data
     */
    createNewCycle(): CumulativeVolume;
    /**
     * Get volume data for a specific cycle
     */
    findByCycleId(cycleId: string): CumulativeVolume | null;
    /**
     * Get all volume history (recent cycles)
     */
    findRecent(limit?: number): CumulativeVolume[];
    /**
     * Convert database row to CumulativeVolume object
     */
    private rowToVolume;
    /**
     * Update volume for a specific side (YES/NO)
     */
    addVolume(volume: CumulativeVolume, side: 'YES' | 'NO', amount: number, shares: number): CumulativeVolume;
}
//# sourceMappingURL=volume.repository.d.ts.map