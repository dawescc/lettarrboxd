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
export async function findItemByTmdbId(tmdbId: string): Promise<string | null> {
    if (!config.plex) return null;

    const { url, token } = config.plex;

    try {
        // Try Legacy Agent format first (common)
        // Format: com.plexapp.agents.themoviedb://{id}?lang=en
        const legacyGuid = `com.plexapp.agents.themoviedb://${tmdbId}?lang=en`;
        
        let ratingKey = await searchByGuid(url, token, legacyGuid);
        if (ratingKey) return ratingKey;

        // Try Modern Agent format
        // Format: plex://movie/tmdb/{id} or plex://show/tmdb/{id}
        // Since we don't strictly know if it's a movie or show here easily without passing type,
        // we can try both or just rely on legacy for now. 
        // Most Plex servers still index legacy GUIDs or can map them.
        
        // TODO: Add robust modern GUID support if legacy fails often.
        
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
            logger.debug(`Found Plex item for GUID ${guid}: ${item.title} (Key: ${item.ratingKey})`);
            return item.ratingKey;
        }
    } catch (e) {
        // Ignore 404s or empty results, just return null
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
export async function addLabel(ratingKey: string, label: string): Promise<void> {
    if (!config.plex) return;
    const { url, token } = config.plex;

    try {
        await retryOperation(async () => {
            // 1. Get existing metadata to find current labels
            const details = await axios.get(`${url}/library/metadata/${ratingKey}`, {
                headers: { 'X-Plex-Token': token, 'Accept': 'application/json' }
            });

            const metadata = details.data.MediaContainer.Metadata[0];
            const existingLabels = (metadata.Label || []).map((l: any) => l.tag);

            if (existingLabels.includes(label)) {
                logger.debug(`Plex item ${ratingKey} already has label '${label}'. Skipping.`);
                return;
            }

            // 2. Add new label
            const newLabels = [...existingLabels, label];
            
            // Construct query params for update
            // Plex PUT requires: label[0].tag.value=X&label[1].tag.value=Y
            const params = new URLSearchParams();
            newLabels.forEach((l: string, i: number) => {
                params.append(`label[${i}].tag.value`, l);
            });

            await axios.put(`${url}/library/metadata/${ratingKey}`, null, {
                headers: { 'X-Plex-Token': token },
                params: params
            });

            logger.info(`Added label '${label}' to Plex item ${metadata.title}`);

        }, 'add plex label');
    } catch (error: any) {
        logger.error(`Error adding label '${label}' to Plex item ${ratingKey}:`, error.message);
    }
}
