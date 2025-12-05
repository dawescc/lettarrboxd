import Axios from 'axios';
import env from '../util/env';
import logger from '../util/logger';
import { LetterboxdMovie } from '../scraper';
import Bluebird from 'bluebird';

interface SonarrSeries {
    title: string;
    qualityProfileId: number;
    rootFolderPath: string;
    tvdbId: number;
    monitored: boolean;
    tags: number[];
    seasons: Array<{
        seasonNumber: number;
        monitored: boolean;
    }>;
    addOptions: {
        searchForMissingEpisodes: boolean;
    }
}

const DEFAULT_TAG_NAME = 'serializd';

const axios = Axios.create({
    baseURL: env.SONARR_API_URL,
    headers: {
        'X-Api-Key': env.SONARR_API_KEY
    }
});

import { retryOperation } from '../util/retry';

interface SonarrSeason {
    seasonNumber: number;
    monitored: boolean;
    statistics?: {
        episodeCount: number;
        totalEpisodeCount: number;
        sizeOnDisk: number;
        percentOfEpisodes: number;
    };
}

interface SonarrLookupResult {
    title: string;
    tvdbId: number;
    seasons: SonarrSeason[];
    id?: number;
}

export async function getQualityProfileId(profileName: string): Promise<number | null> {
    try {
        return await retryOperation(async () => {
            logger.debug(`Getting quality profile ID for: ${profileName}`);

            const response = await axios.get('/api/v3/qualityprofile');
            const profiles = response.data;

            const profile = profiles.find((p: any) => p.name === profileName);
            if (profile) {
                logger.debug(`Found quality profile: ${profileName} (ID: ${profile.id})`);
                return profile.id;
            } else {
                logger.error(`Quality profile not found: ${profileName}`);
                logger.debug('Available profiles:', profiles.map((p: any) => p.name));
                return null;
            }
        }, 'get quality profile');
    } catch (error) {
        logger.error('Error getting Sonarr quality profiles:', error as any);
        return null;
    }
}

export async function getRootFolder(): Promise<string | null> {
    try {
        return await retryOperation(async () => {
            const response = await axios.get('/api/v3/rootfolder');
            const rootFolders = response.data;

            if (rootFolders.length > 0) {
                const rootFolder = rootFolders[0].path;
                logger.debug(`Using Sonarr root folder: ${rootFolder}`);
                return rootFolder;
            } else {
                logger.error('No root folders found in Sonarr');
                return null;
            }
        }, 'get root folder');
    } catch (error) {
        logger.error('Error getting Sonarr root folders:', error as any);
        return null;
    }
}

export async function getRootFolderById(id: string) {
    try {
        const response = await axios.get(`/api/v3/rootfolder/${id}`);
        const { data } = response;
        if (data) {
            return data.path;
        } else {
            return null;
        }
    } catch (e) {
        logger.error(`Error getting Sonarr root folder by id: ${id}`);
        return null;
    }
}

export async function getOrCreateTag(tagName: string): Promise<number | null> {
    try {
        logger.debug(`Getting or creating Sonarr tag: ${tagName}`);

        const response = await axios.get('/api/v3/tag');
        const tags = response.data;

        const existingTag = tags.find((tag: any) => tag.label === tagName);
        if (existingTag) {
            logger.debug(`Tag already exists: ${tagName} (ID: ${existingTag.id})`);
            return existingTag.id;
        }

        logger.debug(`Creating new tag: ${tagName}`);
        const createResponse = await axios.post('/api/v3/tag', {
            label: tagName
        });

        logger.info(`Created tag: ${tagName} (ID: ${createResponse.data.id})`);
        return createResponse.data.id;
    } catch (error) {
        logger.error(`Error getting or creating tag ${tagName}:`, error as any);
        return null;
    }
}

function parseConfiguredTags(): string[] {
    const tags = [DEFAULT_TAG_NAME];

    if (env.SONARR_TAGS) {
        const userTags = env.SONARR_TAGS
            .split(',')
            .map(tag => tag.trim())
            .filter(tag => tag.length > 0);
        tags.push(...userTags);
    }

    return [...new Set(tags)];
}

export async function getAllRequiredTagIds(): Promise<number[]> {
    const tagNames = parseConfiguredTags();
    const tagIdPromises = tagNames.map(tagName => getOrCreateTag(tagName));
    const tagIdsRaw = await Promise.all(tagIdPromises);
    const tagIds = tagIdsRaw.filter((tagId): tagId is number => tagId !== null);

    // Log warnings for any failed tag creations
    tagNames.forEach((tagName, index) => {
        if (tagIdsRaw[index] === null) {
            logger.warn(`Failed to create or retrieve tag: ${tagName}`);
        }
    });

    return tagIds;
}

export async function getSeriesLookup(tmdbId: string): Promise<SonarrLookupResult | null> {
    try {
        // Sonarr allows looking up by "tmdb:12345"
        const response = await axios.get<SonarrLookupResult[]>('/api/v3/series/lookup', {
            params: { term: `tmdb:${tmdbId}` }
        });
        
        if (response.data && response.data.length > 0) {
            return response.data[0];
        }
        return null;
    } catch (error) {
        logger.error(`Error looking up series with TMDB ID ${tmdbId}:`, error as any);
        return null;
    }
}

function configureSeasonMonitoring(seasons: SonarrSeason[]): Array<{ seasonNumber: number; monitored: boolean }> {
    const strategy = env.SONARR_SEASON_MONITORING;
    
    return seasons.map((season: SonarrSeason, index: number) => {
        const seasonNumber = season.seasonNumber;
        let monitored = false;

        switch (strategy) {
            case 'all':
                monitored = true;
                break;
            case 'first':
                monitored = seasonNumber === 1;
                break;
            case 'latest':
                // Monitor the last season (highest season number)
                monitored = index === seasons.length - 1;
                break;
            case 'future':
                // Monitor only seasons that haven't aired yet
                monitored = season.statistics?.episodeCount === 0 || !season.statistics;
                break;
            case 'none':
                monitored = false;
                break;
        }

        return {
            seasonNumber,
            monitored
        };
    });
}

export async function getAllSeries(): Promise<any[]> {
    try {
        return await retryOperation(async () => {
            const response = await axios.get('/api/v3/series');
            return response.data;
        }, 'get all series');
    } catch (error) {
        logger.error('Error getting all series from Sonarr:', error as any);
        return [];
    }
}

export async function deleteSeries(id: number, title: string): Promise<void> {
    try {
        if (env.DRY_RUN) {
            logger.info(`[DRY RUN] Would delete series from Sonarr: ${title} (ID: ${id})`);
            return;
        }

        await retryOperation(async () => {
            await axios.delete(`/api/v3/series/${id}`, {
                params: {
                    deleteFiles: false,
                    addImportExclusion: false
                }
            });
        }, 'delete series');
        
        logger.info(`Successfully deleted series: ${title}`);
    } catch (error) {
        logger.error(`Error deleting series ${title} (ID: ${id}):`, error as any);
    }
}

export async function syncSeries(seriesList: LetterboxdMovie[]): Promise<void> {
    if (!env.SONARR_QUALITY_PROFILE) {
        throw new Error('Sonarr quality profile not configured');
    }

    const qualityProfileId = await getQualityProfileId(env.SONARR_QUALITY_PROFILE);
    if (!qualityProfileId) {
        throw new Error(`Could not find Sonarr quality profile: ${env.SONARR_QUALITY_PROFILE}`);
    }

    const rootFolderPath = !env.SONARR_ROOT_FOLDER_ID ? await getRootFolder() : await getRootFolderById(env.SONARR_ROOT_FOLDER_ID);
    if (!rootFolderPath) {
        throw new Error('Could not get Sonarr root folder');
    }

    const tagIds = await getAllRequiredTagIds();
    const serializdTagId = await getOrCreateTag(DEFAULT_TAG_NAME);

    // 1. Fetch all existing series
    logger.info('Fetching existing series from Sonarr...');
    const existingSeries = await getAllSeries();
    logger.info(`Found ${existingSeries.length} existing series in Sonarr.`);

    // 2. Build Maps for efficient lookup
    // Map TMDB ID -> TVDB ID (if available in Sonarr data)
    // Sonarr v3 series objects often have 'tvdbId' and sometimes 'tmdbId' (or we might need to rely on lookup)
    const tmdbToTvdbMap = new Map<number, number>();
    const existingTvdbIds = new Set<number>();

    existingSeries.forEach((s: any) => {
        if (s.tvdbId) existingTvdbIds.add(s.tvdbId);
        // Note: s.tmdbId might not always be present, but we use it if it is to save lookups
        if (s.tmdbId) tmdbToTvdbMap.set(s.tmdbId, s.tvdbId);
    });

    const keepTvdbIds = new Set<number>();

    // 3. Process Watchlist Items (Add/Update list of "Keep" IDs)
    await Bluebird.map(seriesList, async (item) => {
        if (!item.tmdbId) return;
        const tmdbId = parseInt(item.tmdbId);

        // Optimization: If we already know the TVDB ID from our local map, use it
        if (tmdbToTvdbMap.has(tmdbId)) {
            const tvdbId = tmdbToTvdbMap.get(tmdbId)!;
            keepTvdbIds.add(tvdbId);
            logger.debug(`Series ${item.name} already exists in Sonarr (cached match), skipping add.`);
            return;
        }

        // If not in map, we might still have it (if tmdbId wasn't in the Sonarr object), 
        // OR we need to add it. In either case, 'addSeries' handles the lookup and existence check.
        // We need 'addSeries' to return the TVDB ID so we can mark it as "Keep".
        const tvdbId = await addSeries(item, qualityProfileId, rootFolderPath, tagIds, existingTvdbIds);
        if (tvdbId) {
            keepTvdbIds.add(tvdbId);
        }
    }, { concurrency: 3 });

    // 4. Remove missing series (if enabled)
    if (env.REMOVE_MISSING_ITEMS && serializdTagId) {
        logger.info('Checking for series to remove...');

        const seriesToRemove = existingSeries.filter((s: any) => {
            const hasTag = s.tags && s.tags.includes(serializdTagId);
            const notInWatchlist = !keepTvdbIds.has(s.tvdbId);
            return hasTag && notInWatchlist;
        });

        if (seriesToRemove.length > 0) {
            logger.info(`Found ${seriesToRemove.length} series to remove.`);
            await Bluebird.map(seriesToRemove, (s: any) => {
                return deleteSeries(s.id, s.title);
            }, { concurrency: 3 });
        } else {
            logger.info('No series to remove.');
        }
    }
}

async function addSeries(item: LetterboxdMovie, qualityProfileId: number, rootFolderPath: string, tagIds: number[], existingTvdbIds: Set<number>): Promise<number | null> {
    try {
        if (!item.tmdbId) {
            logger.warn(`Skipping ${item.name}: No TMDB ID`);
            return null;
        }

        // We have to lookup to get the TVDB ID and Title
        const lookupResult = await getSeriesLookup(item.tmdbId);
        if (!lookupResult) {
            logger.warn(`Could not find series in Sonarr lookup: ${item.name} (TMDB: ${item.tmdbId})`);
            return null;
        }

        const tvdbId = lookupResult.tvdbId;

        // Check if it already exists (using the TVDB ID we just found)
        if (existingTvdbIds.has(tvdbId)) {
            logger.debug(`Series already exists in Sonarr (lookup match): ${lookupResult.title}`);
            return tvdbId;
        }

        // If we are here, it's new. Add it.
        const seasons = configureSeasonMonitoring(lookupResult.seasons || []);

        const payload: SonarrSeries = {
            title: lookupResult.title,
            qualityProfileId,
            rootFolderPath,
            tvdbId: lookupResult.tvdbId,
            monitored: !env.SONARR_ADD_UNMONITORED,
            tags: tagIds,
            seasons,
            addOptions: {
                searchForMissingEpisodes: true
            }
        };

        if (env.DRY_RUN) {
            logger.info(payload, `[DRY RUN] Would add series to Sonarr: ${payload.title}`);
            return tvdbId; // Return ID even in dry run so we don't try to delete it if we were simulating
        }

        const response = await axios.post('/api/v3/series', payload);
        logger.info(`Successfully added series: ${payload.title}`, response.data);
        
        return tvdbId;

    } catch (e: any) {
        logger.error(`Error adding series ${item.name}:`, e.message);
        return null;
    }
}
