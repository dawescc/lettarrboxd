import Axios from 'axios';
import { loadConfig } from '../util/config';
import { plexMovieLimiter, plexTvLimiter, movieItemQueue, tvItemQueue, createRateLimitedAxios } from '../util/queues';
import { ScrapedMedia } from '../scraper';
import logger from '../util/logger';
import { retryOperation } from '../util/retry';
import { calculateNextTags } from '../util/tagLogic';
import env from '../util/env';
import { scrapeCache } from '../util/cache';

// --- Types ---
interface PlexMetadata {
    ratingKey: string;
    title: string;
    type: string;
    Guid?: { id: string }[];
    Label?: { tag: string }[];
}

interface PlexMediaContainer {
    MediaContainer: {
        Metadata?: PlexMetadata[];
    };
}

/**
 * Creates a rate-limited Plex client.
 * 
 * @param url - Plex server URL
 * @param token - Plex authentication token
 * @param limiter - The Bottleneck limiter to use (movie or TV)
 */
function createPlexClient(url: string, token: string, limiter: typeof plexMovieLimiter) {
    const baseAxios = Axios.create({
        baseURL: url,
        headers: {
            'X-Plex-Token': token,
            'Accept': 'application/json'
        },
        timeout: 30000
    });

    return createRateLimitedAxios(baseAxios, limiter, 'Plex');
}

type RateLimitedAxios = ReturnType<typeof createRateLimitedAxios>;

// Library cache - holds all items from Plex, indexed by TMDB ID
interface LibraryCache {
    movies: Map<string, PlexMetadata>;  // tmdbId -> metadata
    shows: Map<string, PlexMetadata>;   // tmdbId -> metadata
    byTitle: Map<string, PlexMetadata[]>; // lowercase title -> metadata[]
    fetchedAt: number;
}

let libraryCache: LibraryCache | null = null;
const LIBRARY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetches the entire Plex library and indexes it by TMDB ID for fast lookups.
 * Caches results for 5 minutes.
 */
async function getLibraryIndex(axios: RateLimitedAxios): Promise<LibraryCache> {
    // Return cached if still valid
    if (libraryCache && (Date.now() - libraryCache.fetchedAt) < LIBRARY_CACHE_TTL_MS) {
        logger.debug('Using cached Plex library index');
        return libraryCache;
    }

    logger.info('Fetching and indexing Plex library...');

    const movies = new Map<string, PlexMetadata>();
    const shows = new Map<string, PlexMetadata>();
    const byTitle = new Map<string, PlexMetadata[]>();

    try {
        // Fetch all library items with GUIDs included
        const response = await axios.get<PlexMediaContainer>('/library/all', {
            params: { includeGuids: 1 }
        });

        const items = response.data?.MediaContainer?.Metadata || [];

        for (const item of items) {
            // Index by title for fallback lookups
            const titleKey = item.title.toLowerCase();
            if (!byTitle.has(titleKey)) {
                byTitle.set(titleKey, []);
            }
            byTitle.get(titleKey)!.push(item);

            // Index by TMDB ID
            const guids = item.Guid || [];
            for (const g of guids) {
                // Extract TMDB ID from various formats
                let tmdbId: string | null = null;

                if (g.id.startsWith('tmdb://')) {
                    tmdbId = g.id.replace('tmdb://', '');
                } else if (g.id.includes('themoviedb://')) {
                    const match = g.id.match(/themoviedb:\/\/(\d+)/);
                    if (match) tmdbId = match[1];
                } else if (g.id.includes('plex://movie/tmdb/') || g.id.includes('plex://show/tmdb/')) {
                    const match = g.id.match(/tmdb\/(\d+)/);
                    if (match) tmdbId = match[1];
                }

                if (tmdbId) {
                    if (item.type === 'movie') {
                        movies.set(tmdbId, item);
                    } else if (item.type === 'show') {
                        shows.set(tmdbId, item);
                    }
                }
            }
        }

        logger.info(`Indexed Plex library: ${movies.size} movies, ${shows.size} shows`);

        libraryCache = {
            movies,
            shows,
            byTitle,
            fetchedAt: Date.now()
        };

        return libraryCache;

    } catch (error: any) {
        logger.error('Failed to fetch Plex library:', error.message);
        // Return empty cache on error
        return {
            movies: new Map(),
            shows: new Map(),
            byTitle: new Map(),
            fetchedAt: Date.now()
        };
    }
}

/**
 * Fast lookup by TMDB ID using the pre-fetched library index.
 */
export async function findItemByTmdbId(tmdbId: string, title?: string, year?: number, type?: 'movie' | 'show', config?: any): Promise<string | null> {
    if (!config) config = loadConfig();
    if (!config.plex) return null;

    // Check persistent cache first
    const cacheKey = `plex_resolution_${tmdbId}`;
    const cachedRatingKey = scrapeCache.get<string>(cacheKey);
    if (cachedRatingKey) {
        logger.debug(`[CACHE HIT] Plex: TMDB ${tmdbId} -> Key ${cachedRatingKey}`);
        return cachedRatingKey;
    }

    const { url, token } = config.plex;
    // Use movie limiter by default, TV limiter for shows
    const limiter = type === 'show' ? plexTvLimiter : plexMovieLimiter;
    const axios = createPlexClient(url, token, limiter);

    try {
        const library = await getLibraryIndex(axios);

        // 1. Direct TMDB lookup
        let item: PlexMetadata | undefined;

        if (!type || type === 'movie') {
            item = library.movies.get(tmdbId);
        }
        if (!item && (!type || type === 'show')) {
            item = library.shows.get(tmdbId);
        }

        if (item) {
            scrapeCache.set(cacheKey, item.ratingKey);
            return item.ratingKey;
        }

        // 2. Fallback: Title search in the index
        if (title) {
            const titleKey = title.toLowerCase();
            const candidates = library.byTitle.get(titleKey) || [];

            for (const candidate of candidates) {
                // Filter by type if specified
                if (type === 'movie' && candidate.type !== 'movie') continue;
                if (type === 'show' && candidate.type !== 'show') continue;

                // Check if any GUID matches the TMDB ID
                const guids = candidate.Guid || [];
                const hasMatch = guids.some((g: { id: string }) =>
                    g.id === `tmdb://${tmdbId}` ||
                    g.id.includes(`themoviedb://${tmdbId}`) ||
                    g.id.includes(`/tmdb/${tmdbId}`)
                );

                if (hasMatch) {
                    scrapeCache.set(cacheKey, candidate.ratingKey);
                    return candidate.ratingKey;
                }
            }
        }

        logger.debug(`Could not find in Plex: TMDB ${tmdbId}`);
        return null;

    } catch (error: any) {
        logger.error(`Error searching Plex for TMDB ID ${tmdbId}:`, error.message);
        return null;
    }
}

/**
 * Syncs labels for an item.
 */
export async function syncLabels(ratingKey: string, targetLabels: string[], managedTags: Set<string>, systemLabel: string, typeHint: 'movie' | 'show' | undefined, config?: any) {
    if (!config) config = loadConfig();
    if (!config.plex) return;
    const { url, token } = config.plex;
    const limiter = typeHint === 'show' ? plexTvLimiter : plexMovieLimiter;
    const axios = createPlexClient(url, token, limiter);

    try {
        await retryOperation(async () => {
            // Get existing metadata/labels
            const details = await axios.get<PlexMediaContainer>(`/library/metadata/${ratingKey}`);

            const metadata = details.data.MediaContainer.Metadata?.[0];
            if (!metadata) {
                throw new Error(`Item ${ratingKey} not found in Plex`);
            }

            const existingLabels = (metadata.Label || []).map((l: { tag: string }) => l.tag);
            const finalLabelsArg = calculateNextTags(existingLabels, managedTags, targetLabels, true);

            // Check if update needed
            const finalSet = new Set(finalLabelsArg.map(l => l.toLowerCase()));
            const existingSet = new Set(existingLabels.map(l => l.toLowerCase()));

            if (finalSet.size === existingSet.size && [...finalSet].every(l => existingSet.has(l))) {
                logger.debug(`Plex ${metadata.title} labels already up to date.`);
                return;
            }

            if (env.DRY_RUN) {
                logger.info(`[DRY RUN] Would update Plex labels for ${metadata.title}: [${existingLabels.join(', ')}] -> [${finalLabelsArg.join(', ')}]`);
                return;
            }

            logger.debug(`Updating Plex labels for ${metadata.title}`);

            // Construct query string for Plex API
            const queryParts = finalLabelsArg.map((l: string, i: number) => {
                return `label[${i}].tag.tag=${encodeURIComponent(l)}`;
            });

            if (typeHint === 'movie') queryParts.push('type=1');
            if (typeHint === 'show') queryParts.push('type=2');

            const queryString = queryParts.join('&');

            await axios.put(`/library/metadata/${ratingKey}?${queryString}`, null);
            logger.info(`Updated Plex labels for ${metadata.title}`);

        }, `sync plex labels for item ${ratingKey}`);

    } catch (error: any) {
        logger.error(`Error syncing labels to Plex item ${ratingKey}:`, error.message);
    }
}

/**
 * Syncs tags for a batch of items in parallel.
 * 
 * Uses movie or TV queues based on typeHint to ensure
 * movie and TV syncs don't interfere with each other.
 */
export async function syncPlexTags(items: ScrapedMedia[], globalTags: string[] = [], managedTags: Set<string>, typeHint?: 'movie' | 'show') {
    const config = loadConfig();
    if (!config.plex) return;

    logger.info(`Syncing Plex labels for ${items.length} items...`);

    const systemOwnerLabel = typeHint === 'movie' ? 'letterboxd' : 'serializd';

    // Select appropriate queue and limiter based on type
    const itemQueue = typeHint === 'show' ? tvItemQueue : movieItemQueue;
    const limiter = typeHint === 'show' ? plexTvLimiter : plexMovieLimiter;

    // Pre-fetch library index ONCE before processing items
    const { url, token } = config.plex;
    const axios = createPlexClient(url, token, limiter);
    await getLibraryIndex(axios);

    // Use appropriate queue for concurrency - HTTP calls already rate-limited
    await itemQueue.addAll(items.map(item => {
        return async () => {
            if (!item.tmdbId) return;

            const itemTags = item.tags || [];
            const allTags = [...new Set([...itemTags, ...globalTags])];

            if (allTags.length === 0) return;

            try {
                const year = (item as any).publishedYear || (item as any).year;
                const ratingKey = await findItemByTmdbId(item.tmdbId, item.name, year, typeHint, config);

                if (ratingKey) {
                    await syncLabels(ratingKey, allTags, managedTags, systemOwnerLabel, typeHint, config);
                }
            } catch (e: any) {
                logger.error(`Failed to sync Plex tags for ${item.name}: ${e.message}`);
            }
        };
    }));

    logger.info(`Finished syncing Plex labels.`);
}
