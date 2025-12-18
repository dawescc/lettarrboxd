import Axios from 'axios';
import env from '../util/env';
import { loadConfig } from '../util/config';
import logger from '../util/logger';
import { ScrapedSeries } from '../scraper';
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

export const DEFAULT_TAG_NAME = 'serializd';

const axios = Axios.create({
    baseURL: env.SONARR_API_URL,
    headers: {
        'X-Api-Key': env.SONARR_API_KEY
    }
});

import { retryOperation } from '../util/retry';
import { calculateNextTagIds } from '../util/tagLogic';

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



export async function getAllQualityProfiles(): Promise<any[]> {
    try {
        return await retryOperation(async () => {
            const response = await axios.get('/api/v3/qualityprofile');
            return response.data;
        }, 'get all quality profiles');
    } catch (error) {
        logger.error('Error getting all quality profiles from Sonarr:', error as any);
        return [];
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

export async function getAllTags(): Promise<Array<{ id: number, label: string }>> {
    try {
        const response = await axios.get('/api/v3/tag');
        return response.data;
    } catch (error) {
        logger.error('Error getting all tags from Sonarr:', error as any);
        return [];
    }
}

export async function createTag(label: string): Promise<number | null> {
    try {
        logger.debug(`Creating new Sonarr tag: ${label}`);
        const response = await axios.post('/api/v3/tag', { label });
        return response.data.id;
    } catch (error) {
        logger.error(`Error creating Sonarr tag ${label}:`, error as any);
        return null;
    }
}

export async function ensureTagsAreAvailable(requiredTags: string[]): Promise<Map<string, number>> {
    const tagMap = new Map<string, number>();
    const distinctTags = [...new Set(requiredTags)];
    
    if (distinctTags.length === 0) return tagMap;

    // 1. Fetch all existing tags ONCE
    const existingTags = await getAllTags();
    existingTags.forEach(t => tagMap.set(t.label, t.id));

    // 2. Find which ones are missing
    const missingTags = distinctTags.filter(t => !tagMap.has(t));

    if (missingTags.length > 0) {
        logger.info(`Creating ${missingTags.length} new tags in Sonarr...`);
        for (const tagLabel of missingTags) {
            const newId = await createTag(tagLabel);
            if (newId) {
                tagMap.set(tagLabel, newId);
            }
        }
    }

    return tagMap;
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

function configureSeasonMonitoring(
    availableSeasons: SonarrSeason[], 
    targetSeasonNumbers?: number[]
): Array<{ seasonNumber: number; monitored: boolean }> {
    // If we have specific target seasons (from Serializd), use them
    if (targetSeasonNumbers && targetSeasonNumbers.length > 0) {
        return availableSeasons.map(season => ({
            seasonNumber: season.seasonNumber,
            monitored: targetSeasonNumbers.includes(season.seasonNumber)
        }));
    }

    // Otherwise fall back to the global strategy
    const strategy = env.SONARR_SEASON_MONITORING;
    
    return availableSeasons.map((season: SonarrSeason, index: number) => {
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
                monitored = index === availableSeasons.length - 1;
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
                    deleteFiles: true,
                    addImportExclusion: false
                }
            });
        }, 'delete series');
        
        logger.info(`Successfully deleted series: ${title}`);
    } catch (error) {
        logger.error(`Error deleting series ${title} (ID: ${id}):`, error as any);
    }
}

export async function syncSeries(seriesList: ScrapedSeries[], managedTags: Set<string>): Promise<void> {
    const config = loadConfig();
    const sonarrConfig = config.sonarr;
    // Fallback to ENV if config absent
    // Fallback to ENV if config absent
    const globalQualityProfileName = sonarrConfig?.qualityProfile || env.SONARR_QUALITY_PROFILE;

    if (!globalQualityProfileName) {
        throw new Error('Sonarr global quality profile not configured');
    }

    // Cache all profiles
    const allProfiles = await getAllQualityProfiles();
    const profileMap = new Map<string, number>();
    allProfiles.forEach((p: any) => profileMap.set(p.name, p.id));

    const globalProfileId = profileMap.get(globalQualityProfileName);
    if (!globalProfileId) {
        throw new Error(`Could not find Sonarr global quality profile: ${globalQualityProfileName}`);
    }

    const rootFolderConfig = sonarrConfig?.rootFolder || env.SONARR_ROOT_FOLDER_ID;
    const rootFolderPath = !rootFolderConfig ? await getRootFolder() : 
                           (rootFolderConfig.startsWith('/') ? rootFolderConfig : await getRootFolderById(rootFolderConfig));

    if (!rootFolderPath) {
        throw new Error('Could not get Sonarr root folder');
    }

    // --- Tag Resolution ---

    // 1. Collect ALL required tags
    const envTags = (env.SONARR_TAGS || '').split(',').map(t => t.trim()).filter(t => t.length > 0);
    const configTags = sonarrConfig?.tags || [];
    const systemTagNames = [...new Set([DEFAULT_TAG_NAME, ...envTags, ...configTags])];

    const seriesTagNames = new Set<string>();
    seriesList.forEach(s => {
        if (s.tags) {
            s.tags.forEach(t => seriesTagNames.add(t));
        }
    });

    const allRequiredTags = [...new Set([...systemTagNames, ...seriesTagNames, ...managedTags])];

    // 2. Resolve IDs (Batch operation)
    logger.info(`Resolving ${allRequiredTags.length} tags for Sonarr...`);
    const tagMap = await ensureTagsAreAvailable(allRequiredTags);

    // Map managed tags (strings) to IDs for cleaning
    const managedTagIds = new Set<number>();
    managedTags.forEach(t => {
        const id = tagMap.get(t);
        if (id) managedTagIds.add(id);
    });
    // Add system tags to managed list
    systemTagNames.forEach(t => {
        const id = tagMap.get(t);
        if (id) managedTagIds.add(id);
    });

    const startSystemTagIds = systemTagNames
        .map(name => tagMap.get(name))
        .filter((id): id is number => id !== undefined);
        
    const serializdTagId = tagMap.get(DEFAULT_TAG_NAME);

    // --- Sync Logic ---

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

        if (s.tmdbId) tmdbToTvdbMap.set(s.tmdbId, s.tvdbId);
    });

    const keepTvdbIds = new Set<number>();

    // 3. Process Watchlist Items (Add/Update list of "Keep" IDs)
    logger.info(`Processing ${seriesList.length} series from Serializd...`);
    const results = await Bluebird.map(seriesList, async (item) => {
        if (!item.tmdbId) return;
        const tmdbId = parseInt(item.tmdbId);

        // Calculate tags for this specific series
        const seriesSpecificTagIds = (item.tags || [])
            .map(t => tagMap.get(t))
            .filter((id): id is number => id !== undefined);
        
        // Merge system tags + series tags
        const finalTagIds = [...new Set([...startSystemTagIds, ...seriesSpecificTagIds])];

        const existingItem = existingSeries.find((s: any) => s.tvdbId === tmdbToTvdbMap.get(tmdbId) || s.tmdbId === tmdbId);

        if (existingItem) {
             const tvdbId = existingItem.tvdbId;
             keepTvdbIds.add(tvdbId);

             // Clone string item so we can mutate it locally between updates
             let currentItemState = { ...existingItem };

             // OWNERSHIP CHECK
             if ((serializdTagId && currentItemState.tags && currentItemState.tags.includes(serializdTagId)) || env.OVERRIDE_TAGS) {
                 // Smart Tag Sync
                 const currentTags = currentItemState.tags || [];
                 const nextTags = calculateNextTagIds(currentTags, managedTagIds, finalTagIds);

                 if (nextTags.length !== currentTags.length || !nextTags.every(t => currentTags.includes(t))) {
                     // Perform update
                     await updateSeries(currentItemState, nextTags);
                     
                     // Update local state so next operation uses new tags
                     currentItemState.tags = nextTags;
                 }
             }

             // Check seasons
             if (item.seasons && item.seasons.length > 0) {
                 await updateSeriesSeasonsRaw(currentItemState, item.seasons);
             }
             
             logger.debug(`Series ${item.name} already exists in Sonarr.`);
             return { tvdbId, wasAdded: false };
        }

        // Optimization: If we already know the TVDB ID from our local map, use it
        if (tmdbToTvdbMap.has(tmdbId)) {
            // Already handled in block above if found in existingSeries, but just in case of race condition logic
            // Skipping redundant logic here as existingItem check covers it
        }

        // If not in map, we might still have it (if tmdbId wasn't in the Sonarr object), 
        // OR we need to add it. In either case, 'addSeries' handles the lookup and existence check.
        // We need 'addSeries' to return the TVDB ID so we can mark it as "Keep".
        // Resolve Quality Profile
        let qualityProfileId = globalProfileId;
        if (item.qualityProfile) {
            const overrideId = profileMap.get(item.qualityProfile);
            if (overrideId) {
                qualityProfileId = overrideId;
            } else {
                logger.warn(`Quality profile override '${item.qualityProfile}' not found in Sonarr. Using global default.`);
            }
        }

        const result = await addSeries(item, qualityProfileId, rootFolderPath, finalTagIds, existingTvdbIds, existingSeries);
        if (result) {
            keepTvdbIds.add(result.tvdbId);
            return result;
        }
        return null;
    }, { concurrency: 3 });

    const addedCount = results.filter(r => r && r.wasAdded).length;
    logger.info(`Finished processing series. Added ${addedCount} new series.`);

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

export async function updateSeries(existingSeries: any, newTags: number[]): Promise<void> {
    try {
        if (env.DRY_RUN) {
            logger.info(`[DRY RUN] Would update tags for series: ${existingSeries.title} -> [${newTags.join(', ')}]`);
            return;
        }

        logger.info(`Updating tags for series: ${existingSeries.title}`);
        const payload = {
            ...existingSeries,
            tags: newTags
        };

        await axios.put(`/api/v3/series/${existingSeries.id}`, payload);
    } catch (e: any) {
        logger.error(`Error updating series ${existingSeries.title}:`, e as any);
    }
}

async function addSeries(
    item: ScrapedSeries, 
    qualityProfileId: number, 
    rootFolderPath: string, 
    tagIds: number[], 
    existingTvdbIds: Set<number>,
    allExistingSeries: any[]
): Promise<{ tvdbId: number, wasAdded: boolean } | null> {
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
            // If seasons are provided, we should check/update them here too (edge case where tmdb map missed it but it exists)
            if (item.seasons && item.seasons.length > 0) {
                 const existingItem = allExistingSeries.find((s: any) => s.tvdbId === tvdbId);
                 if (existingItem) {
                     await updateSeriesSeasonsRaw(existingItem, item.seasons);
                 }
            }
            return { tvdbId, wasAdded: false };
        }

        // If we are here, it's new. Add it.
        const seasons = configureSeasonMonitoring(lookupResult.seasons || [], item.seasons);

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
            return { tvdbId, wasAdded: false }; // Treat dry run as not added for counting purposes, or maybe true? usually dry run logs say "would add". Let's say false to avoid confusion in "Added X series" log.
        }

        const response = await axios.post('/api/v3/series', payload);
        logger.info(`Successfully added series: ${payload.title}`, response.data);
        
        return { tvdbId, wasAdded: true };

    } catch (e: any) {
        logger.error(`Error adding series ${item.name}:`, e.message);
        return null;
    }
}

async function updateSeriesSeasonsRaw(existingSeries: any, targetSeasons: number[]): Promise<void> {
    try {
        if (!existingSeries || !existingSeries.seasons) return;

        let needsUpdate = false;
        const newSeasons = existingSeries.seasons.map((season: any) => {
            const shouldBeMonitored = targetSeasons.includes(season.seasonNumber);
            
            if (season.monitored !== shouldBeMonitored) {
                needsUpdate = true;
                return { ...season, monitored: shouldBeMonitored };
            }
            return season;
        });

        if (needsUpdate) {
            if (env.DRY_RUN) {
                logger.info(`[DRY RUN] Would update seasons for ${existingSeries.title} to: ${targetSeasons.join(', ')}`);
                return;
            }

            logger.info(`Updating seasons for ${existingSeries.title}. Monitoring: ${targetSeasons.join(', ')}`);
            // Update the series in Sonarr
            // We need to send the full series object back, but with updated seasons
            const updatePayload = {
                ...existingSeries,
                seasons: newSeasons
            };

            await axios.put(`/api/v3/series/${existingSeries.id}`, updatePayload);
        }
    } catch (e: any) {
        logger.error(`Error updating seasons for ${existingSeries.title}:`, e.message);
    }
}
