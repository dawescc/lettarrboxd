import Axios, { AxiosInstance } from 'axios';
import { loadConfig } from '../util/config';
import { plexLimiter, itemQueue, createRateLimitedAxios } from '../util/queues';
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

// Create rate-limited Plex client factory
function createPlexClient(url: string, token: string) {
    const baseAxios = Axios.create({
        baseURL: url,
        headers: {
            'X-Plex-Token': token,
            'Accept': 'application/json'
        },
        timeout: 30000
    });

    return createRateLimitedAxios(baseAxios, plexLimiter, 'Plex');
}

/**
 * Searches Plex for an item by its TMDB ID.
 * Uses the global search by GUID to find items across all libraries.
 */
export async function findItemByTmdbId(tmdbId: string, title?: string, year?: number, type?: 'movie' | 'show', config?: any): Promise<string | null> {
    if (!config) config = loadConfig();
    if (!config.plex) return null;

    const { url, token } = config.plex;
    const axios = createPlexClient(url, token);

    try {
        // Check Cache
        const cacheKey = `plex_resolution_${tmdbId}`;
        const cachedRatingKey = scrapeCache.get<string>(cacheKey);
        if (cachedRatingKey) {
            logger.debug(`[CACHE HIT] Plex: TMDB ${tmdbId} -> Key ${cachedRatingKey}`);
            return cachedRatingKey;
        }

        // 1. Try Legacy Agent format first
        const legacyGuid = `com.plexapp.agents.themoviedb://${tmdbId}?lang=en`;
        let ratingKey = await searchByGuid(axios, legacyGuid);
        if (ratingKey) {
            scrapeCache.set(cacheKey, ratingKey);
            return ratingKey;
        }

        // 2. Try Modern Agent format
        if (!type || type === 'movie') {
            const movieGuid = `plex://movie/tmdb/${tmdbId}`;
            ratingKey = await searchByGuid(axios, movieGuid);
            if (ratingKey) {
                scrapeCache.set(cacheKey, ratingKey);
                return ratingKey;
            }
        }

        if (!type || type === 'show') {
            const showGuid = `plex://show/tmdb/${tmdbId}`;
            ratingKey = await searchByGuid(axios, showGuid);
            if (ratingKey) {
                scrapeCache.set(cacheKey, ratingKey);
                return ratingKey;
            }
        }

        // 3. Last Resort: Search by Title
        if (title) {
            logger.debug(`GUID lookup failed for TMDB ${tmdbId}. Trying title search: "${title}"`);
            ratingKey = await searchByTitleAndId(axios, title, tmdbId, year, type);
            if (ratingKey) {
                logger.debug(`Found by title fallback: ${title} (Key: ${ratingKey})`);
                scrapeCache.set(cacheKey, ratingKey);
                return ratingKey;
            }
        }

        logger.debug(`Could not find in Plex: TMDB ${tmdbId}`);
        return null;

    } catch (error: any) {
        logger.error(`Error searching Plex for TMDB ID ${tmdbId}:`, error.message);
        return null;
    }
}

type RateLimitedAxios = ReturnType<typeof createRateLimitedAxios>;

async function searchByGuid(axios: RateLimitedAxios, guid: string): Promise<string | null> {
    try {
        const response = await axios.get<PlexMediaContainer>('/library/all', {
            params: { guid }
        });

        if (response.data?.MediaContainer?.Metadata?.length && response.data.MediaContainer.Metadata.length > 0) {
            const item = response.data.MediaContainer.Metadata[0];
            return item.ratingKey;
        }
    } catch (e) {
        // Ignore 404s or empty results
    }
    return null;
}

async function searchByTitleAndId(
    axios: RateLimitedAxios,
    title: string,
    tmdbId: string,
    year?: number,
    type?: 'movie' | 'show'
): Promise<string | null> {
    logger.debug(`Plex title search: ${title} (TMDB: ${tmdbId})`);
    try {
        const params: Record<string, any> = {
            title,
            includeGuids: 1
        };

        if (type === 'movie') params.type = 1;
        if (type === 'show') params.type = 2;
        if (year) params.year = year;

        const response = await axios.get<PlexMediaContainer>('/library/all', { params });

        const results = response.data?.MediaContainer?.Metadata || [];

        for (const item of results) {
            if (type === 'movie' && item.type !== 'movie') continue;
            if (type === 'show' && item.type !== 'show') continue;

            const guids = item.Guid || [];
            const hasMatch = guids.some((g: { id: string }) =>
                g.id === `tmdb://${tmdbId}` ||
                g.id.includes(`//${tmdbId}?`) ||
                g.id.includes(`//${tmdbId}`)
            );

            if (hasMatch) {
                return item.ratingKey;
            }
        }

    } catch (e: any) {
        logger.debug(`Error searching by title "${title}": ${e.message}`);
    }
    return null;
}

/**
 * Syncs labels for an item.
 */
export async function syncLabels(ratingKey: string, targetLabels: string[], managedTags: Set<string>, systemLabel: string, typeHint: 'movie' | 'show' | undefined, config?: any) {
    if (!config) config = loadConfig();
    if (!config.plex) return;
    const { url, token } = config.plex;
    const axios = createPlexClient(url, token);

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
 */
export async function syncPlexTags(items: ScrapedMedia[], globalTags: string[] = [], managedTags: Set<string>, typeHint?: 'movie' | 'show') {
    const config = loadConfig();
    if (!config.plex) return;

    logger.info(`Syncing Plex labels for ${items.length} items...`);

    const systemOwnerLabel = typeHint === 'movie' ? 'letterboxd' : 'serializd';

    // Use itemQueue for concurrency - HTTP calls already rate-limited
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
