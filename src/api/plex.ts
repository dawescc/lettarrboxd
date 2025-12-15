import Axios, { AxiosInstance } from 'axios';
import { loadConfig } from '../util/config';
import logger from '../util/logger';
import { retryOperation } from '../util/retry';

let plexClient: AxiosInstance | null = null;

function getPlexClient(): AxiosInstance {
    if (!plexClient) {
        plexClient = Axios.create();
    }
    return plexClient;
}

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
 * Searches Plex for an item by its TMDB ID.
 * Uses the global search by GUID to find items across all libraries.
 * 
 * @param tmdbId The TMDB ID to search for
 * @returns The ratingKey (internal ID) of the item, or null if not found
 */
export async function findItemByTmdbId(tmdbId: string, title?: string, year?: number, type?: 'movie' | 'show'): Promise<string | null> {
    const config = loadConfig();
    if (!config.plex) return null;

    const { url, token } = config.plex;

    try {
        // 1. Try Legacy Agent format first (common)
        // Format: com.plexapp.agents.themoviedb://{id}?lang=en
        const legacyGuid = `com.plexapp.agents.themoviedb://${tmdbId}?lang=en`;
        
        let ratingKey = await searchByGuid(url, token, legacyGuid);
        if (ratingKey) return ratingKey;

        // 2. Try Modern Agent format
        // Use type hint if available to save requests
        if (!type || type === 'movie') {
            const movieGuid = `plex://movie/tmdb/${tmdbId}`;
            ratingKey = await searchByGuid(url, token, movieGuid);
            if (ratingKey) return ratingKey;
        }

        if (!type || type === 'show') {
            const showGuid = `plex://show/tmdb/${tmdbId}`;
            ratingKey = await searchByGuid(url, token, showGuid);
            if (ratingKey) return ratingKey;
        }
        
        // 3. Last Resort: Search by Title and filter by TMDB ID
        // This handles cases where the primary agent is NOT TMDB (e.g. Plex Movie, TVDB)
        if (title) {
            logger.debug(`Direct GUID lookup failed for TMDB ${tmdbId}. Falling back to title search: "${title}"`);
            ratingKey = await searchByTitleAndId(url, token, title, tmdbId, year, type);
            if (ratingKey) {
                 logger.debug(`Found item by title fallback: ${title} (Key: ${ratingKey})`);
                 return ratingKey;
            }
        }
        
        logger.debug(`Could not find item in Plex with TMDB ID ${tmdbId} (Checked Legacy, Modern, and Title agents)`);
        return null;

    } catch (error: any) {
        logger.error(`Error searching Plex for TMDB ID ${tmdbId}:`, error.message);
        return null;
    }
}

async function searchByGuid(baseUrl: string, token: string, guid: string): Promise<string | null> {
    try {
        const response = await getPlexClient().get<PlexMediaContainer>(`${baseUrl}/library/all`, {
            headers: { 'X-Plex-Token': token, 'Accept': 'application/json' },
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
    baseUrl: string, 
    token: string, 
    title: string, 
    tmdbId: string, 
    year?: number,
    type?: 'movie' | 'show'
): Promise<string | null> {
    try {
        // Prepare params
        const params: Record<string, any> = {
            title,
            includeGuids: 1
        };
        
        if (type === 'movie') params.type = 1;
        if (type === 'show') params.type = 2;
        if (year) params.year = year;
        
        const response = await getPlexClient().get<PlexMediaContainer>(`${baseUrl}/library/all`, {
            headers: { 'X-Plex-Token': token, 'Accept': 'application/json' },
            params
        });
        
        const results = response.data?.MediaContainer?.Metadata || [];
        
        for (const item of results) {
            // 1. Double check type if we didn't filter by it
            if (type === 'movie' && item.type !== 'movie') continue;
            if (type === 'show' && item.type !== 'show') continue;

            // 2. Check Guids array
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
 * Adds multiple labels to an item in a single atomic update.
 * Merges with existing labels to prevent overwriting.
 * 
 * @param ratingKey The internal Plex ID of the item
 * @param labels Array of labels to add
 * @param typeHint 'movie' or 'show' (optional, but recommended for API compliance)
 */
export async function addLabels(ratingKey: string, labels: string[], typeHint?: 'movie' | 'show') {
    // Remove 'config' property access since this is a standalone function, use global config
    const config = loadConfig();
    if (!config.plex) return;
    const { url, token } = config.plex;

    process.stdout.write(`\r      Syncing Plex metadata...`);

    try {
        await retryOperation(async () => {
            // 1. Get existing metadata/labels
            const details = await getPlexClient().get<PlexMediaContainer>(`${url}/library/metadata/${ratingKey}`, {
                headers: { 'X-Plex-Token': token, 'Accept': 'application/json' }
            });

            const metadata = details.data.MediaContainer.Metadata?.[0];
            if (!metadata) {
                throw new Error(`Item ${ratingKey} not found in Plex`);
            }

            const existingLabels = (metadata.Label || []).map((l: { tag: string }) => l.tag);
            
            logger.info(`[DEBUG] Item ${ratingKey} Existing Labels: ${JSON.stringify(existingLabels)}`);

            // 2. Merge existing + new labels (deduplicated case-insensitively)
            const normalizedExisting = new Map(existingLabels.map((l: string) => [l.toLowerCase(), l]));
            
            // Add new labels if their lower-case version doesn't exist
            labels.forEach(l => {
                if (!normalizedExisting.has(l.toLowerCase())) {
                    normalizedExisting.set(l.toLowerCase(), l);
                }
            });

            const finalLabels = Array.from(normalizedExisting.values());

            // Verify if update is needed
            if (finalLabels.length === existingLabels.length && 
                existingLabels.every((l: string) => normalizedExisting.has(l.toLowerCase()))) {
                logger.info(`[DEBUG] Plex item ${ratingKey} tags are already in sync. Skipping update.`);
                return;
            }
            
            // Construct query string for Plex API (requires literal brackets for array items)
            const queryParts = finalLabels.map((l: string, i: number) => {
                return `label[${i}].tag.tag=${encodeURIComponent(l)}`;
            });
            
            if (typeHint === 'movie') queryParts.push('type=1');
            if (typeHint === 'show') queryParts.push('type=2');
            
            const queryString = queryParts.join('&');
            const fullUrl = `${url}/library/metadata/${ratingKey}?${queryString}`;
            
            logger.info(`[DEBUG] PUT URL (Batch): ${fullUrl}`);

            const response = await getPlexClient().put(fullUrl, null, {
                headers: { 'X-Plex-Token': token, 'Accept': 'application/json' }
            });
            
            logger.info(`[DEBUG] Plex Response: ${response.status} ${JSON.stringify(response.data)}`);

            logger.info(`Synced labels [${finalLabels.join(', ')}] to Plex item ${metadata.title}`);
        }, 'add plex labels');

    } catch (error: any) {
        logger.error(`Error adding labels to Plex item ${ratingKey}:`, error.message);
    }
}

import Bluebird from 'bluebird';
import { ScrapedMedia } from '../scraper';

/**
 * Syncs tags for a batch of items in parallel.
 * 
 * @param items List of scraped items (movies or series)
 * @param globalTags Tags to apply to every item (e.g. ['letterboxd', 'radarr'])
 * @param typeHint 'movie' or 'show' (optional, improves lookup speed)
 */
export async function syncPlexTags(items: ScrapedMedia[], globalTags: string[] = [], typeHint?: 'movie' | 'show') {
    const config = loadConfig();
    if (!config.plex) return;

    logger.info(`Syncing Plex metadata for ${items.length} items (Concurrency: 5)...`);

    await Bluebird.map(items, async (item) => {
        if (!item.tmdbId) return;

        const itemTags = item.tags || [];
        // Combine all tags: Item Specific + Global Config + Extra (passed in arg)
        const allTags = [...new Set([...itemTags, ...globalTags])];

        if (allTags.length === 0) return;

        try {
            // Pass title, year (if available), and type hint for fallback search
            // We need to cast to any to safely access optional properties that might exist on LetterboxdMovie
            const year = (item as any).publishedYear || (item as any).year;
            
            const ratingKey = await findItemByTmdbId(item.tmdbId, item.name, year, typeHint);

            if (ratingKey) {
                // Atomic update
                await addLabels(ratingKey, allTags, typeHint);
            }
        } catch (e: any) {
            logger.error(`Failed to sync Plex tags for ${item.name}: ${e.message}`);
        }
    }, { concurrency: 5 });
}
