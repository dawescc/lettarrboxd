import axios from 'axios';
import fs from 'fs';
import path from 'path';
import Bluebird from 'bluebird';
import logger from '../util/logger';
import env from '../util/env';
import { LetterboxdMovie, ScrapedSeries } from './index';

interface SerializdItem {
    showId: number;
    showName: string;
    bannerImage: string;
    dateAdded: string;
    seasonIds: number[];
}

interface SerializdResponse {
    items: SerializdItem[];
    totalPages: number;
    numberOfShows: number;
}

interface SerializdShowDetails {
    seasons: Array<{
        id: number;
        seasonNumber: number;
    }>;
}

// Cache format: "SeasonID": SeasonNumber
interface SeasonCache {
    [key: string]: number;
}

export class SerializdScraper {
    private cachePath: string;
    private cache: SeasonCache = {};

    constructor(private url: string) {

        this.cachePath = path.join(env.DATA_DIR, 'serializd_cache.json');
        this.loadCache();
    }

    private loadCache() {
        try {
            if (fs.existsSync(this.cachePath)) {
                this.cache = JSON.parse(fs.readFileSync(this.cachePath, 'utf-8'));
            }
        } catch (e: any) {
            logger.warn('Failed to load Serializd cache, starting fresh.', e);
            this.cache = {};
        }
    }

    private saveCache() {
        try {
            // Ensure data directory exists
            const dir = path.dirname(this.cachePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 2));
        } catch (e: any) {
            logger.error('Failed to save Serializd cache:', e);
        }
    }

    private async resolveSeasonNumbers(showId: number, seasonIds: number[]): Promise<number[]> {
        const seasonNumbers: number[] = [];
        let fetchedDetails = false;

        // Check if we have all IDs in cache
        const missingIds = seasonIds.filter(id => this.cache[id.toString()] === undefined);

        if (missingIds.length > 0) {
            logger.debug(`Fetching details for show ${showId} to resolve ${missingIds.length} season IDs...`);
            try {
                // Fetch show details
                // Rate limit slightly
                await new Promise(resolve => setTimeout(resolve, 200)); 

                const response = await axios.get<SerializdShowDetails>(`https://www.serializd.com/api/show/${showId}`, {
                    headers: {
                        'X-Requested-With': 'serializd_vercel',
                        'User-Agent': 'Mozilla/5.0'
                    },
                    timeout: 30000
                });

                if (response.data && response.data.seasons) {
                    response.data.seasons.forEach(season => {
                        this.cache[season.id.toString()] = season.seasonNumber;
                    });
                    this.saveCache();
                    fetchedDetails = true;
                }
            } catch (e: any) {
                logger.error(`Failed to fetch details for show ${showId}:`, e);
                // Return what we can, or empty?
            }
        }

        // Map IDs to Numbers
        seasonIds.forEach(id => {
            const num = this.cache[id.toString()];
            if (num !== undefined) {
                seasonNumbers.push(num);
            }
        });

        return seasonNumbers;
    }

    async getSeries(): Promise<{ items: ScrapedSeries[], hasErrors: boolean }> {
        logger.info(`Scraping Serializd watchlist: ${this.url}`);
        
        // Extract username from URL
        const match = this.url.match(/user\/([^\/]+)\/watchlist/);
        if (!match) {
            throw new Error(`Invalid Serializd watchlist URL: ${this.url}. Expected format: .../user/USERNAME/watchlist`);
        }
        const username = match[1];
        const baseUrl = `https://www.serializd.com/api/user/${username}/watchlistpage_v2`;
        
        const allItems: SerializdItem[] = []; // Intermediate storage
        let page = 1;
        let totalPages = 1;
        let hasErrors = false;

        try {

            do {
                const apiUrl = `${baseUrl}/${page}?sort_by=date_added_desc`;
                logger.debug(`Fetching Serializd API: ${apiUrl}`);

                const response = await axios.get<SerializdResponse>(apiUrl, {
                    headers: {
                        'X-Requested-With': 'serializd_vercel',
                        'Referer': this.url,
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                    },
                    timeout: 30000
                });

                const data = response.data;
                totalPages = data.totalPages;

                if (data.items) {
                    allItems.push(...data.items);
                }

                page++;
                
                if (page <= totalPages) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }

            } while (page <= totalPages);

            logger.debug(`Found ${allItems.length} raw items in Serializd watchlist. resolving details...`);


            const seriesPromise = await Bluebird.map(allItems, async (item) => {
                try {
                    let seasons: number[] = [];
                    if (item.seasonIds && item.seasonIds.length > 0) {
                        seasons = await this.resolveSeasonNumbers(item.showId, item.seasonIds);
                    }

                    return {
                        id: item.showId,
                        name: item.showName,
                        showId: item.showId,
                        tmdbId: item.showId.toString(), // Serializd IDs are often TMDB IDs or mapped? Assuming showId is usable.
                        slug: item.showName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
                        seasons: seasons
                    } as ScrapedSeries;
                } catch (e: any) {
                    logger.warn(`Failed to process Serializd item ${item.showName} (ID: ${item.showId}): ${e.message}`);
                    hasErrors = true;
                    return null;
                }
            }, { concurrency: 5 });

            const validSeries = seriesPromise.filter((s): s is ScrapedSeries => s !== null);
            return { items: validSeries, hasErrors };

        } catch (error) {
            logger.error('Error scraping Serializd:', error as any);
            throw error;
        }
    }
}
