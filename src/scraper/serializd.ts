import Axios from 'axios';
import { serializdLimiter, tvItemQueue, createRateLimitedAxios } from '../util/queues';
import logger from '../util/logger';
import { scrapeCache } from '../util/cache';
import { ScrapedSeries } from './index';
import { retryOperation } from '../util/retry';

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

// Create rate-limited axios for Serializd API
const baseAxios = Axios.create({
    headers: {
        'X-Requested-With': 'serializd_vercel',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    },
    timeout: 30000
});

const axios = createRateLimitedAxios(baseAxios, serializdLimiter, 'Serializd');

export class SerializdScraper {
    private baseUrl: string;

    constructor(private url: string) {
        this.baseUrl = url;
    }

    private async resolveSeasonNumbers(showId: number, seasonIds: number[]): Promise<number[]> {
        const seasonNumbers: number[] = [];
        let showDetails: SerializdShowDetails | undefined;

        for (const seasonId of seasonIds) {
            // Check permanent cache
            const cachedSeasonNumber = scrapeCache.getSeason(seasonId);
            if (cachedSeasonNumber !== undefined) {
                seasonNumbers.push(cachedSeasonNumber);
                continue;
            }

            // Fetch details if not in cache
            if (!showDetails) {
                logger.debug(`Fetching details for show ${showId} to resolve season IDs...`);
                try {
                    const cacheKey = `serializd_show_details_${showId}`;
                    showDetails = scrapeCache.get<SerializdShowDetails>(cacheKey);

                    if (!showDetails) {
                        // Rate-limited axios call
                        const response = await axios.get<SerializdShowDetails>(`https://www.serializd.com/api/show/${showId}`);
                        showDetails = response.data;

                        if (showDetails) {
                            scrapeCache.set(cacheKey, showDetails);
                        }
                    } else {
                        logger.debug(`[CACHE HIT] Serializd Show: ${showId}`);
                    }
                } catch (e: any) {
                    logger.error(`Failed to fetch details for show ${showId}:`, e);
                    continue;
                }
            }

            if (showDetails && showDetails.seasons) {
                const season = showDetails.seasons.find(s => s.id === seasonId);
                if (season) {
                    scrapeCache.setSeason(seasonId, season.seasonNumber);
                    seasonNumbers.push(season.seasonNumber);
                }
            }
        }

        return seasonNumbers;
    }

    async getSeries(): Promise<{ items: ScrapedSeries[], hasErrors: boolean }> {
        logger.info(`Scraping Serializd watchlist: ${this.url}`);

        const match = this.url.match(/user\/([^\/]+)\/watchlist/);
        if (!match) {
            throw new Error(`Invalid Serializd watchlist URL: ${this.url}`);
        }
        const username = match[1];
        const baseUrl = `https://www.serializd.com/api/user/${username}/watchlistpage_v2`;

        const allItems: SerializdItem[] = [];
        let page = 1;
        let totalPages = 1;
        let hasErrors = false;

        try {
            do {
                const apiUrl = `${baseUrl}/${page}?sort_by=date_added_desc`;
                logger.debug(`Fetching Serializd page ${page}`);

                const response = await retryOperation(async () => {
                    // Rate-limited axios call
                    return await axios.get<SerializdResponse>(apiUrl, {
                        headers: {
                            'Referer': this.url
                        }
                    });
                }, `fetch serializd page ${page}`);

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

            logger.info(`Found ${allItems.length} items in Serializd watchlist.`);

            // Use tvItemQueue for concurrency - HTTP calls already rate-limited
            const seriesPromise = await tvItemQueue.addAll(allItems.map(item => {
                return async () => {
                    try {
                        let seasons: number[] = [];
                        if (item.seasonIds && item.seasonIds.length > 0) {
                            seasons = await this.resolveSeasonNumbers(item.showId, item.seasonIds);
                        }

                        return {
                            id: item.showId,
                            name: item.showName,
                            showId: item.showId,
                            tmdbId: item.showId.toString(),
                            slug: item.showName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
                            seasons: seasons
                        } as ScrapedSeries;
                    } catch (e: any) {
                        logger.warn(`Failed to process ${item.showName}: ${e.message}`);
                        hasErrors = true;
                        return null;
                    }
                };
            }));

            const validSeries = seriesPromise.filter((s): s is ScrapedSeries => s !== null);
            return { items: validSeries, hasErrors };

        } catch (error) {
            logger.error('Error scraping Serializd:', error as any);
            throw error;
        }
    }
}
