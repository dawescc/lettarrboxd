import Axios, { AxiosInstance } from 'axios';
import { loadConfig } from '../util/config';
import { plexLimiter } from '../util/queues';
import { ScrapedMedia } from '../scraper';
import logger from '../util/logger';
import { retryOperation } from '../util/retry';
import { calculateNextTags } from '../util/tagLogic';
import env from '../util/env';

let plexClient: AxiosInstance | null = null;

function getPlexClient(): AxiosInstance {
    if (!plexClient) {
        plexClient = Axios.create({
            timeout: 30000
        });
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
export async function findItemByTmdbId(tmdbId: string, title?: string, year?: number, type?: 'movie' | 'show', config?: any): Promise<string | null> {
    if (!config) config = loadConfig();
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
    if (env.GRANULAR_LOGGING) logger.info(`[GRANULAR] Starting Plex title search for: ${title} (TMDB: ${tmdbId})`);
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
 * Syncs labels for an item.
 * Merges with existing labels to prevent overwriting USER labels, 
 * but removes managed labels that are no longer applicable.
 * 
 * @param ratingKey The internal Plex ID of the item
 * @param targetLabels Array of labels that should be present from our sync
 * @param managedTags Set of all tags we manage (candidates for removal)
 * @param systemLabel The ownership label (e.g. 'lettarrboxd')
 */
export async function syncLabels(ratingKey: string, targetLabels: string[], managedTags: Set<string>, systemLabel: string, typeHint: 'movie' | 'show' | undefined, config?: any) {
    if (!config) config = loadConfig();
    if (!config.plex) return;
    const { url, token } = config.plex;



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
            
            // OWNERSHIP CHECK
            // We only touch items that have our system label (or if we are about to ADD the system label for the first time, effectively claimed)
            const hasOwnership = existingLabels.some(l => l.toLowerCase() === systemLabel.toLowerCase());
            
            const finalLabelsArg = calculateNextTags(existingLabels, managedTags, targetLabels, true);

            // Verify if update is needed
            const finalSet = new Set(finalLabelsArg.map(l => l.toLowerCase()));
            const existingSet = new Set(existingLabels.map(l => l.toLowerCase()));
            
            if (finalSet.size === existingSet.size && [...finalSet].every(l => existingSet.has(l))) {
                 if (env.GRANULAR_LOGGING) logger.debug(`[GRANULAR] Plex item ${metadata.title} labels already up to date.`);
                 logger.debug(`[DEBUG] Plex item ${metadata.title} labels already up to date.`);
                 return;
            }
            
            if (env.DRY_RUN) {
                logger.info(`[DRY RUN] Would update Plex labels for ${metadata.title}: [${existingLabels.join(', ')}] -> [${finalLabelsArg.join(', ')}]`);
                return;
            }

            logger.info(`Updating Plex labels for ${metadata.title}: [${existingLabels.join(', ')}] -> [${finalLabelsArg.join(', ')}]`);

            // Construct query string for Plex API
            const queryParts = finalLabelsArg.map((l: string, i: number) => {
                return `label[${i}].tag.tag=${encodeURIComponent(l)}`;
            });
            
            if (typeHint === 'movie') queryParts.push('type=1');
            if (typeHint === 'show') queryParts.push('type=2');
            
            const queryString = queryParts.join('&');
            const fullUrl = `${url}/library/metadata/${ratingKey}?${queryString}`;
            
            await getPlexClient().put(fullUrl, null, {
                headers: { 'X-Plex-Token': token, 'Accept': 'application/json' }
            });

        }, `sync plex labels for item ${ratingKey}`);

    } catch (error: any) {
        logger.error(`Error syncing labels to Plex item ${ratingKey}:`, error.message);
    }
}

/**
 * Syncs tags for a batch of items in parallel.
 * 
 * @param items List of scraped items (movies or series)
 * @param globalTags Tags to apply to every item (e.g. ['letterboxd', 'radarr'])
 * @param managedTags All tags managed by the application (candidates for removal)
 * @param typeHint 'movie' or 'show' (optional, improves lookup speed)
 */
export async function syncPlexTags(items: ScrapedMedia[], globalTags: string[] = [], managedTags: Set<string>, typeHint?: 'movie' | 'show') {
    const config = loadConfig();
    if (!config.plex) return;

    logger.info(`Syncing Plex metadata for ${items.length} items (Concurrency: 5)...`);
    
    // Determine system label for ownership check
    // If working on Movies -> letterboxd (RADARR_DEFAULT_TAG) is likely the owner tag
    // If working on Shows -> serializd (SONARR_DEFAULT_TAG)
    // We can infer this from context or pass it in. globalTags usually contains it.
    // For safety, let's assume the FIRST global tag is the system owner, or explicit check.
    // Actually, in `index.ts` we pass `allPlexTags` where the LAST one is the component default tag.
    // Let's rely on checking for 'letterboxd' or 'serializd' explicitly? 
    // Or better: The `systemLabel` is the one defining ownership. In index.ts:
    // const allPlexTags = [...plexGlobalTags, componentName === 'letterboxd' ? RADARR_DEFAULT_TAG : SONARR_DEFAULT_TAG];
    // So the system label is indeed in globalTags. However, `managedTags` contains EVERYTHING. 
    
    // Let's assume the 'system ownership' label is indeed the default tag (letterboxd/serializd).
    // We can find it by checking if it's 'letterboxd' or 'serializd'.
    // Or we update the signature to accept `systemOwnerLabel`.
    // Let's assume 'letterboxd' for movies and 'serializd' for shows based on typeHint.
    
    const systemOwnerLabel = typeHint === 'movie' ? 'letterboxd' : 'serializd'; 

    await Promise.all(items.map(item => 
        plexLimiter.schedule(async () => {
            if (!item.tmdbId) return;

            const itemTags = item.tags || [];
            // Combine all tags: Item Specific + Global Config + Extra (passed in arg)
            const allTags = [...new Set([...itemTags, ...globalTags])];

            if (allTags.length === 0) return;

            try {
                // Pass title, year (if available), and type hint for fallback search
                const year = (item as any).publishedYear || (item as any).year;
                
                const ratingKey = await findItemByTmdbId(item.tmdbId, item.name, year, typeHint, config);

                if (ratingKey) {
                    // Atomic update
                    await syncLabels(ratingKey, allTags, managedTags, systemOwnerLabel, typeHint, config);
                }
            } catch (e: any) {
                logger.error(`Failed to sync Plex tags for ${item.name}: ${e.message}`);
            }
        })
    ));
}
