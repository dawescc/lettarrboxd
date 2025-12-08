import Axios from 'axios';
import config from '../util/config';
import logger from '../util/logger';
import { retryOperation } from '../util/retry';

const axios = Axios.create();

/**
 * Searches Plex for an item by its TMDB ID.
 * Uses the global search by GUID to find items across all libraries.
 * 
 * @param tmdbId The TMDB ID to search for
 * @returns The ratingKey (internal ID) of the item, or null if not found
 */
const MAX_TITLE_SEARCH_RESULTS = 10;

export async function findItemByTmdbId(tmdbId: string, title?: string, year?: number, type?: 'movie' | 'show'): Promise<string | null> {
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
        const response = await axios.get(`${baseUrl}/library/all`, {
            headers: { 'X-Plex-Token': token, 'Accept': 'application/json' },
            params: { guid }
        });

        if (response.data?.MediaContainer?.Metadata?.length > 0) {
            const item = response.data.MediaContainer.Metadata[0];
            // logger.debug(`Found Plex item for GUID ${guid}: ${item.title} (Key: ${item.ratingKey})`);
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
        // type: 1 = Movie, 2 = Show (if we know it)
        const params: any = {
            title,
            includeGuids: 1
        };
        
        if (type === 'movie') params.type = 1;
        if (type === 'show') params.type = 2;
        if (year) params.year = year;
        
        // Don't filter by year strictly in the query as it might fuzzy match, 
        // better to filter in memory if needed or trust the ID check.

        const response = await axios.get(`${baseUrl}/library/all`, {
            headers: { 'X-Plex-Token': token, 'Accept': 'application/json' },
            params
        });
        
        const results = response.data?.MediaContainer?.Metadata || [];
        
        for (const item of results) {
            // 1. Double check type if we didn't filter by it
            if (type === 'movie' && item.type !== 'movie') continue;
            if (type === 'show' && item.type !== 'show') continue;

            // 2. Check Guids array
            // Format: id="tmdb://12345" or "com.plexapp.agents.themoviedb://12345"
            const guids = item.Guid || [];
            const hasMatch = guids.some((g: any) => 
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
 * Adds a label to a Plex item.
 * Preserves existing labels.
 * 
 * @param ratingKey The internal Plex ID of the item
 * @param label The label to add
 */
    /**
     * Adds multiple labels to an item in a single atomic update.
     * Merges with existing labels to prevent overwriting.
     */
    export async function addLabels(ratingKey: string, labels: string[], typeHint?: 'movie' | 'show') {
         // Keep UI responsive
        process.stdout.write(`\r      Syncing Plex metadata...`);
        
        // Remove 'config' property access since this is a standalone function, use global config
        if (!config.plex) return;
        const { url, token } = config.plex;

        try {
            // 1. Get existing metadata/labels
            const details = await axios.get(`${url}/library/metadata/${ratingKey}`, {
                headers: { 'X-Plex-Token': token, 'Accept': 'application/json' }
            });

            const metadata = details.data.MediaContainer.Metadata[0];
            const existingLabels = (metadata.Label || []).map((l: any) => l.tag);
            
            logger.info(`[DEBUG] Item ${ratingKey} Existing Labels: ${JSON.stringify(existingLabels)}`);

            // 2. Merge existing + new labels (deduplicated)
            const missingLabels = labels.filter(l => !existingLabels.includes(l));
            
            if (missingLabels.length === 0) {
                logger.info(`[DEBUG] Plex item ${ratingKey} already has all tags. Skipping update.`);
                return;
            }
            
            const finalLabels = [...new Set([...existingLabels, ...labels])];

            // Construct manual query string for literal brackets
            // XML attribute is 'tag', so parameter should be label[i].tag.tag
            // Previous attempt used .value which is likely why it was ignored
            const queryParts = finalLabels.map((l: string, i: number) => {
                return `label[${i}].tag.tag=${encodeURIComponent(l)}`;
            });
            
            if (typeHint === 'movie') queryParts.push('type=1');
            if (typeHint === 'show') queryParts.push('type=2');
            
            const queryString = queryParts.join('&');
            const fullUrl = `${url}/library/metadata/${ratingKey}?${queryString}`;
            
            logger.info(`[DEBUG] PUT URL (Batch): ${fullUrl}`);

            const response = await axios.put(fullUrl, null, {
                headers: { 'X-Plex-Token': token, 'Accept': 'application/json' }
            });
            
            logger.info(`[DEBUG] Plex Response: ${response.status} ${JSON.stringify(response.data)}`);

            logger.info(`Added labels [${missingLabels.join(', ')}] to Plex item ${metadata.title}`);

        } catch (error: any) {
            logger.error(`Error adding labels to Plex item ${ratingKey}:`, error.message);
        }
    }
