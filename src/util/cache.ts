import { Database } from 'bun:sqlite';
import path from 'path';
import fs from 'fs';
import env from './env';
import logger from './logger';

export class RequestCache {
    private db: Database;
    private readonly ttl: number;

    constructor(fileName: string = 'request_cache.sqlite', ttl: number = 1000 * 60 * 60 * 3) { // 3 hours default
        const dbPath = path.join(env.DATA_DIR, fileName);
        
        // Ensure data directory exists
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        this.db = new Database(dbPath);
        this.ttl = ttl;
        this.init();
    }

    private init() {
        try {
            // Create table if not exists
            this.db.run(`
                CREATE TABLE IF NOT EXISTS cache (
                    key TEXT PRIMARY KEY,
                    value TEXT,
                    expiry INTEGER
                )
            `);
            
            // Create index on expiry for faster cleanup
            this.db.run(`CREATE INDEX IF NOT EXISTS idx_expiry ON cache(expiry)`);
            
            // Initial cleanup
            this.cleanup();
            
            logger.info('Initialized SQLite request cache.');
        } catch (e: any) {
            logger.error('Failed to initialize SQLite cache:', e);
        }
    }

    private cleanup() {
        try {
            const now = Date.now();
            const result = this.db.run('DELETE FROM cache WHERE expiry < ?', [now]);
            if (result.changes > 0) {
                logger.debug(`Cleaned up ${result.changes} expired cache items.`);
            }
        } catch (e: any) {
            logger.warn('Failed to cleanup cache:', e);
        }
    }

    public get<T>(key: string): T | undefined {
        try {
            const now = Date.now();
            
            // Lazy expiration check during get
            const stmt = this.db.prepare('SELECT value, expiry FROM cache WHERE key = ?');
            const row = stmt.get(key) as { value: string, expiry: number } | undefined;

            if (!row) return undefined;

            if (row.expiry < now) {
                this.db.run('DELETE FROM cache WHERE key = ?', [key]);
                return undefined;
            }

            return JSON.parse(row.value) as T;
        } catch (e: any) {
            logger.warn(`Cache read error for key ${key}:`, e);
            return undefined;
        }
    }

    public set<T>(key: string, value: T): void {
        try {
            const expiry = Date.now() + this.ttl;
            const serialized = JSON.stringify(value);
            
            const stmt = this.db.prepare(`
                INSERT OR REPLACE INTO cache (key, value, expiry) VALUES (?, ?, ?)
            `);
            stmt.run(key, serialized, expiry);
        } catch (e: any) {
            logger.warn(`Cache write error for key ${key}:`, e);
        }
    }

    public clear(): void {
        try {
            this.db.run('DELETE FROM cache');
            this.db.run('VACUUM'); // Reclaim space
        } catch (e: any) {
            logger.error('Failed to clear cache:', e);
        }
    }
}

// Global singleton
// Persists to data/request_cache.sqlite
export const scrapeCache = new RequestCache('request_cache.sqlite');
