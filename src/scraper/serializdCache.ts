import fs from 'fs';
import path from 'path';
import env from '../util/env';
import logger from '../util/logger';

// Cache format: "SeasonID": SeasonNumber
interface SeasonCache {
    [key: string]: number;
}

class SerializdCache {
    private static instance: SerializdCache;
    private cache: SeasonCache = {};
    private cachePath: string;
    private isDirty: boolean = false;

    private constructor() {
        this.cachePath = path.join(env.DATA_DIR, 'serializd_cache.json');
        this.load();
    }

    public static getInstance(): SerializdCache {
        if (!SerializdCache.instance) {
            SerializdCache.instance = new SerializdCache();
        }
        return SerializdCache.instance;
    }

    private load() {
        try {
            if (fs.existsSync(this.cachePath)) {
                this.cache = JSON.parse(fs.readFileSync(this.cachePath, 'utf-8'));
                logger.debug(`Loaded Serializd cache with ${Object.keys(this.cache).length} entries.`);
            }
        } catch (e: any) {
            logger.warn('Failed to load Serializd cache, starting fresh.', e);
            this.cache = {};
        }
    }

    public save() {
        if (!this.isDirty) return;

        try {
            // Ensure data directory exists
            const dir = path.dirname(this.cachePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 2));
            this.isDirty = false;
        } catch (e: any) {
            logger.error('Failed to save Serializd cache:', e);
        }
    }

    /**
     * Get a cached season number for a given season ID
     */
    public get(seasonId: number | string): number | undefined {
        return this.cache[seasonId.toString()];
    }

    /**
     * Update the cache with a new season mapping
     */
    public set(seasonId: number | string, seasonNumber: number) {
        if (this.cache[seasonId.toString()] !== seasonNumber) {
            this.cache[seasonId.toString()] = seasonNumber;
            this.isDirty = true;
            this.save(); // Save immediately for now, or could debounce
        }
    }

    /**
     * Bulk update cache
     */
    public update(seasonMap: { [id: string]: number }) {
        let changed = false;
        for (const [id, num] of Object.entries(seasonMap)) {
             if (this.cache[id] !== num) {
                 this.cache[id] = num;
                 changed = true;
             }
        }
        if (changed) {
            this.isDirty = true;
            this.save();
        }
    }
}

export default SerializdCache;
