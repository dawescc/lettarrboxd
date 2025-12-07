import Axios from 'axios';
import env from '../util/env';
import config from '../util/config';
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

export async function syncSeries(seriesList: ScrapedSeries[]): Promise<void> {
    const sonarrConfig = config.sonarr;
    // Fallback to ENV if config absent
    const qualityProfileName = sonarrConfig?.qualityProfile || env.SONARR_QUALITY_PROFILE;

    if (!qualityProfileName) {
        throw new Error('Sonarr quality profile not configured');
    }

    const qualityProfileId = await getQualityProfileId(qualityProfileName);
    if (!qualityProfileId) {
        throw new Error(`Could not find Sonarr quality profile: ${qualityProfileName}`);
    }

    const rootFolderConfig = sonarrConfig?.rootFolder || env.SONARR_ROOT_FOLDER_ID;
    const rootFolderPath = !rootFolderConfig ? await getRootFolder() : 
                           (rootFolderConfig.startsWith('/') ? rootFolderConfig : await getRootFolderById(rootFolderConfig));

    if (!rootFolderPath) {
        throw new Error('Could not get Sonarr root folder');
    }

    // --- Tag Resolution ---

    // 1. Resolve System Tags (Config + Global Env)
    // We combine env.SONARR_TAGS and config.sonarr.tags
    const envTags = (env.SONARR_TAGS || '').split(',').map(t => t.trim()).filter(t => t.length > 0);
    const configTags = sonarrConfig?.tags || [];
    const systemTagNames = [...new Set([DEFAULT_TAG_NAME, ...envTags, ...configTags])];

    // 2. Resolve Per-Series Tags
    const seriesTagNames = new Set<string>();
    seriesList.forEach(s => {
        if (s.tags) {
            s.tags.forEach(t => seriesTagNames.add(t));
        }
    });

    // 3. Create IDs for ALL unique tags found
    const allUniqueTags = new Set([...systemTagNames, ...seriesTagNames]);
    const tagMap = new Map<string, number>();

    logger.info(`Resolving ${allUniqueTags.size} tags for Sonarr...`);
    for (const tagName of allUniqueTags) {
        const id = await getOrCreateTag(tagName);
        if (id) {
            tagMap.set(tagName, id);
        }
    }

    const startSystemTagIds = systemTagNames.map(name => tagMap.get(name)).filter((id): id is number => id !== undefined);
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
        // Note: s.tmdbId might not always be present, but we use it if it is to save lookups
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

        // Optimization: If we already know the TVDB ID from our local map, use it
        if (tmdbToTvdbMap.has(tmdbId)) {
            const tvdbId = tmdbToTvdbMap.get(tmdbId)!;
            keepTvdbIds.add(tvdbId);
            
            // Check if we need to update seasons
            if (item.seasons && item.seasons.length > 0) {
                const existingItem = existingSeries.find((s: any) => s.tvdbId === tvdbId);
                if (existingItem) {
                    await updateSeriesSeasonsRaw(existingItem, item.seasons);
                }
            }
            
            logger.debug(`Series ${item.name} already exists in Sonarr (cached match), checked/updated seasons.`);
            return { tvdbId, wasAdded: false };
        }

        // If not in map, we might still have it (if tmdbId wasn't in the Sonarr object), 
        // OR we need to add it. In either case, 'addSeries' handles the lookup and existence check.
        // We need 'addSeries' to return the TVDB ID so we can mark it as "Keep".
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
