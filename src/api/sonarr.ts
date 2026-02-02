import Axios from 'axios';
import env from '../util/env';
import { loadConfig } from '../util/config';
import logger from '../util/logger';
import { ScrapedSeries } from '../scraper';
import { retryOperation } from '../util/retry';
import { calculateNextTagIds } from '../util/tagLogic';
import { resolveTagsForItems } from '../util/tagHelper';
import { sonarrLimiter, itemQueue, createRateLimitedAxios } from '../util/queues';

// Types
export interface SonarrSeason {
    seasonNumber: number;
    monitored: boolean;
    statistics?: {
        episodeCount: number;
        totalEpisodeCount: number;
        sizeOnDisk: number;
        percentOfEpisodes: number;
    };
}

export interface SonarrSeriesResponse {
    id: number;
    title: string;
    tvdbId: number;
    tmdbId?: number;
    tags: number[];
    qualityProfileId: number;
    monitored: boolean;
    path: string;
    seasons: SonarrSeason[];
}

export interface SonarrSeries {
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

export interface SonarrProfile {
    id: number;
    name: string;
}

export interface SonarrRootFolder {
    id: number;
    path: string;
}

export interface SonarrTag {
    id: number;
    label: string;
}

interface SonarrLookupResult {
    title: string;
    tvdbId: number;
    seasons: SonarrSeason[];
    id?: number;
}

export interface SonarrEpisodeFile {
    id: number;
    seriesId: number;
    seasonNumber: number;
    path: string;
    size: number;
}

import { TAG_SERIALIZD as DEFAULT_TAG_NAME } from '../util/constants';

// Create base axios instance
const baseAxios = Axios.create({
    baseURL: env.SONARR_API_URL,
    headers: {
        'X-Api-Key': env.SONARR_API_KEY
    },
    timeout: 30000
});

// Create rate-limited axios - ALL calls go through Bottleneck
const axios = createRateLimitedAxios(baseAxios, sonarrLimiter, 'Sonarr');

// Helpers
export async function getAllQualityProfiles(): Promise<SonarrProfile[]> {
    try {
        return await retryOperation(async () => {
            const response = await axios.get<SonarrProfile[]>('/api/v3/qualityprofile');
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
            const response = await axios.get<SonarrRootFolder[]>('/api/v3/rootfolder');
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

export async function getRootFolderById(id: string): Promise<string | null> {
    try {
        const response = await axios.get<SonarrRootFolder>(`/api/v3/rootfolder/${id}`);
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

export async function getAllTags(): Promise<SonarrTag[]> {
    try {
        const response = await axios.get<SonarrTag[]>('/api/v3/tag');
        return response.data;
    } catch (error) {
        logger.error('Error getting all tags from Sonarr:', error as any);
        return [];
    }
}

export async function createTag(label: string): Promise<number | null> {
    try {
        logger.debug(`Creating new Sonarr tag: ${label}`);
        const response = await axios.post<SonarrTag>('/api/v3/tag', { label });
        return response.data.id;
    } catch (error) {
        logger.error(`Error creating Sonarr tag ${label}:`, error as any);
        return null;
    }
}

export async function getSeriesLookup(tmdbId: string): Promise<SonarrLookupResult | null> {
    try {
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

export async function getSeriesLookupByTitle(title: string): Promise<SonarrLookupResult[]> {
    try {
        const response = await axios.get<SonarrLookupResult[]>('/api/v3/series/lookup', {
            params: { term: title }
        });
        return response.data || [];
    } catch (error) {
        logger.error(`Error looking up series by title ${title}:`, error as any);
        return [];
    }
}

function configureSeasonMonitoring(
    availableSeasons: SonarrSeason[],
    targetSeasonNumbers?: number[]
): Array<{ seasonNumber: number; monitored: boolean }> {
    if (targetSeasonNumbers && targetSeasonNumbers.length > 0) {
        return availableSeasons.map(season => ({
            seasonNumber: season.seasonNumber,
            monitored: targetSeasonNumbers.includes(season.seasonNumber)
        }));
    }

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
                monitored = index === availableSeasons.length - 1;
                break;
            case 'future':
                monitored = season.statistics?.episodeCount === 0 || !season.statistics;
                break;
            case 'none':
                monitored = false;
                break;
        }

        return { seasonNumber, monitored };
    });
}

export async function getAllSeries(): Promise<SonarrSeriesResponse[]> {
    try {
        return await retryOperation(async () => {
            const response = await axios.get<SonarrSeriesResponse[]>('/api/v3/series');
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
            logger.info(`[DRY RUN] Would delete series: ${title} (ID: ${id})`);
            return;
        }

        logger.debug(`Deleting series: ${title} (${id})`);

        await retryOperation(async () => {
            await axios.delete(`/api/v3/series/${id}`, {
                params: {
                    deleteFiles: true,
                    addImportExclusion: false
                }
            });
        }, 'delete series');

        logger.info(`Deleted series: ${title}`);
    } catch (error) {
        logger.error(`Error deleting series ${title} (ID: ${id}):`, error as any);
    }
}

export async function getEpisodeFiles(seriesId: number): Promise<SonarrEpisodeFile[]> {
    try {
        logger.debug(`Getting episode files for series ${seriesId}`);
        const response = await axios.get<SonarrEpisodeFile[]>('/api/v3/episodefile', {
            params: { seriesId }
        });
        return response.data;
    } catch (error) {
        logger.error(`Error getting episode files for series ${seriesId}:`, error as any);
        return [];
    }
}

export async function deleteEpisodeFile(episodeFileId: number): Promise<void> {
    try {
        if (env.DRY_RUN) {
            logger.info(`[DRY RUN] Would delete episode file ID: ${episodeFileId}`);
            return;
        }
        logger.debug(`Deleting episode file ${episodeFileId}`);
        await axios.delete(`/api/v3/episodefile/${episodeFileId}`);
    } catch (error) {
        logger.error(`Error deleting episode file ${episodeFileId}:`, error as any);
    }
}

// ============================================================================
// SYNC LOGIC
// ============================================================================

interface SyncContext {
    globalProfileId: number;
    rootFolderPath: string;
    profileMap: Map<string, number>;
    tagMap: Map<string, number>;
    managedTagIds: Set<number>;
    systemTagIds: number[];
    serializdTagId?: number;
    tmdbToTvdbMap: Map<number, number>;
}

async function resolveSyncConfig(): Promise<{ globalProfileId: number; rootFolderPath: string; profileMap: Map<string, number> }> {
    const config = loadConfig();
    const sonarrConfig = config.sonarr;
    const globalQualityProfileName = sonarrConfig?.qualityProfile || env.SONARR_QUALITY_PROFILE;

    if (!globalQualityProfileName) {
        throw new Error('Sonarr global quality profile not configured');
    }

    const allProfiles = await getAllQualityProfiles();
    const profileMap = new Map<string, number>();
    allProfiles.forEach(p => profileMap.set(p.name, p.id));

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

    return { globalProfileId, rootFolderPath, profileMap };
}

async function resolveSyncTags(seriesList: ScrapedSeries[], managedTags: Set<string>): Promise<{
    tagMap: Map<string, number>;
    managedTagIds: Set<number>;
    systemTagIds: number[];
    serializdTagId?: number;
}> {
    const config = loadConfig();
    const sonarrConfig = config.sonarr;
    const envTags = (env.SONARR_TAGS || '').split(',').map(t => t.trim()).filter(t => t.length > 0);
    const configTags = sonarrConfig?.tags || [];
    const systemTagNames = [...new Set([DEFAULT_TAG_NAME, ...envTags, ...configTags])];

    const result = await resolveTagsForItems(
        seriesList.map(s => ({ tags: s.tags })),
        managedTags,
        systemTagNames,
        DEFAULT_TAG_NAME,
        {
            getAllTags: getAllTags,
            createTag: createTag
        }
    );

    return {
        tagMap: result.tagMap,
        managedTagIds: result.managedTagIds,
        systemTagIds: result.systemTagIds,
        serializdTagId: result.defaultTagId
    };
}

async function processSeriesSync(
    item: ScrapedSeries,
    ctx: SyncContext,
    existingSeries: SonarrSeriesResponse[],
    keepTvdbIds: Set<number>
): Promise<{ wasAdded: boolean; tvdbId: number } | null> {
    const seriesSpecificTagIds = (item.tags || [])
        .map(t => ctx.tagMap.get(t))
        .filter((id): id is number => id !== undefined);

    const finalTagIds = [...new Set([...ctx.systemTagIds, ...seriesSpecificTagIds])];

    const existingItem = existingSeries.find(s => s.tvdbId === ctx.tmdbToTvdbMap.get(parseInt(item.tmdbId || '0')) || s.tmdbId === parseInt(item.tmdbId || '0'));

    if (existingItem) {
        const tvdbId = existingItem.tvdbId;
        keepTvdbIds.add(tvdbId);

        let currentItemState = { ...existingItem };

        if ((ctx.serializdTagId && currentItemState.tags && currentItemState.tags.includes(ctx.serializdTagId)) || env.OVERRIDE_TAGS) {
            const currentTags = currentItemState.tags || [];
            const nextTags = calculateNextTagIds(currentTags, ctx.managedTagIds, finalTagIds);

            if (nextTags.length !== currentTags.length || !nextTags.every(t => currentTags.includes(t))) {
                await updateSeries(currentItemState, nextTags);
                currentItemState.tags = nextTags;
            }
        }

        if (item.seasons && item.seasons.length > 0) {
            await updateSeriesSeasonsRaw(currentItemState, item.seasons);
        }

        logger.debug(`Series ${item.name} already exists in Sonarr.`);
        return { tvdbId, wasAdded: false };
    }

    // Resolve Quality Profile
    let qualityProfileId = ctx.globalProfileId;
    if (item.qualityProfile) {
        const overrideId = ctx.profileMap.get(item.qualityProfile);
        if (overrideId) {
            qualityProfileId = overrideId;
        } else {
            logger.warn(`Quality profile override '${item.qualityProfile}' not found. Using default.`);
        }
    }

    return await addSeries(item, qualityProfileId, ctx.rootFolderPath, finalTagIds, existingSeries);
}


async function processLibraryCleanup(
    existingSeries: SonarrSeriesResponse[],
    keepTvdbIds: Set<number>,
    serializdTagId: number,
    unsafeTags: Set<string>
): Promise<void> {
    if (!env.REMOVE_MISSING_ITEMS) return;

    logger.info('Checking for series to remove...');

    const allSonarrTags = await getAllTags();
    const sonarrTagIdToLabel = new Map<number, string>();
    allSonarrTags.forEach(t => sonarrTagIdToLabel.set(t.id, t.label));

    const seriesToRemove = existingSeries.filter(s => {
        const hasTag = s.tags && s.tags.includes(serializdTagId);
        const notInWatchlist = !keepTvdbIds.has(s.tvdbId);

        const seriesTagIds: number[] = s.tags || [];
        const hasUnsafeTag = seriesTagIds.some(id => {
            const label = sonarrTagIdToLabel.get(id);
            return label && unsafeTags.has(label);
        });

        if (hasUnsafeTag) {
            logger.debug(`Skipping removal of ${s.title}: has unsafe tag.`);
            return false;
        }

        return hasTag && notInWatchlist;
    });

    if (seriesToRemove.length > 0) {
        logger.info(`Found ${seriesToRemove.length} series to remove.`);
        // Use itemQueue for concurrency - HTTP calls already rate-limited
        await itemQueue.addAll(seriesToRemove.map(s =>
            () => deleteSeries(s.id, s.title)
        ));
    } else {
        logger.info('No series to remove.');
    }
}

export async function syncSeries(seriesList: ScrapedSeries[], managedTags: Set<string>, unsafeTags: Set<string> = new Set(), abortCleanup: boolean = false): Promise<void> {

    const { globalProfileId, rootFolderPath, profileMap } = await resolveSyncConfig();
    const { tagMap, managedTagIds, systemTagIds, serializdTagId } = await resolveSyncTags(seriesList, managedTags);

    logger.info('Fetching existing series from Sonarr...');
    const existingSeries = await getAllSeries();
    logger.info(`Found ${existingSeries.length} existing series in Sonarr.`);

    const tmdbToTvdbMap = new Map<number, number>();
    existingSeries.forEach(s => {
        if (s.tmdbId) tmdbToTvdbMap.set(s.tmdbId, s.tvdbId);
    });

    const context: SyncContext = {
        globalProfileId,
        rootFolderPath,
        profileMap,
        tagMap,
        managedTagIds,
        systemTagIds,
        serializdTagId,
        tmdbToTvdbMap
    };

    const keepTvdbIds = new Set<number>();

    // Helper for timeout
    function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
        return Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                setTimeout(() => {
                    reject(new Error(`Timeout of ${ms}ms exceeded for ${label}`));
                }, ms);
            })
        ]);
    }

    logger.info(`Processing ${seriesList.length} series from Serializd...`);
    // Use itemQueue for concurrency - HTTP calls already rate-limited
    const results = await itemQueue.addAll(seriesList.map(item => {
        return async () => {
            try {
                const result = await withTimeout(
                    processSeriesSync(item, context, existingSeries, keepTvdbIds),
                    60000,
                    `Processing ${item.name}`
                );

                if (result) keepTvdbIds.add(result.tvdbId);
                return result;
            } catch (e: any) {
                logger.warn(`Failed to process ${item.name} (skipping): ${e.message}`);
                return null;
            }
        };
    }));

    const addedCount = results.filter(r => r && r.wasAdded).length;
    logger.info(`Finished processing series. Added ${addedCount} new series.`);

    if (abortCleanup) {
        logger.warn('Cleanup phase ABORTED due to safety lock.');
    } else if (serializdTagId) {
        await processLibraryCleanup(existingSeries, keepTvdbIds, serializdTagId, unsafeTags);
    }
}

export async function updateSeries(existingSeries: SonarrSeriesResponse, newTags: number[]): Promise<void> {
    try {
        if (env.DRY_RUN) {
            logger.info(`[DRY RUN] Would update tags for: ${existingSeries.title} -> [${newTags.join(', ')}]`);
            return;
        }

        logger.debug(`Updating tags for: ${existingSeries.title}`);
        const payload = {
            ...existingSeries,
            tags: newTags
        };

        await axios.put(`/api/v3/series/${existingSeries.id}`, payload);
        logger.info(`Updated tags for: ${existingSeries.title}`);
    } catch (e: any) {
        logger.error(`Error updating series ${existingSeries.title}:`, e as any);
    }
}

export async function addSeries(
    item: ScrapedSeries,
    qualityProfileId: number,
    rootFolderPath: string,
    tagIds: number[],
    existingSeriesCache: SonarrSeriesResponse[]
): Promise<{ tvdbId: number, wasAdded: boolean } | null> {
    try {
        let lookupResult: SonarrLookupResult | null = null;
        let usedMethod = 'tmdb';

        // 1. Try TMDB ID lookup
        if (item.tmdbId) {
            try {
                const res = await getSeriesLookup(item.tmdbId);
                if (res) {
                    lookupResult = res;
                    usedMethod = 'tmdb_id';
                }
            } catch (ignore) { }
        }

        // 2. Fallback: Search by Title
        if (!lookupResult) {
            logger.debug(`TMDB lookup failed for ${item.name}. Trying title search...`);
            const candidates = await getSeriesLookupByTitle(item.name);

            const normalizeTitle = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, '');
            const target = normalizeTitle(item.name);

            const match = candidates.find(c => normalizeTitle(c.title) === target);

            if (match) {
                lookupResult = match;
                usedMethod = 'title_match';
            } else {
                logger.warn(`Series not found in Sonarr: ${item.name}`);
                if (candidates.length > 0) {
                    logger.debug(`Potential mis-matches: ${candidates.map(c => c.title).join(', ')}`);
                }
            }
        }

        if (!lookupResult) {
            return null;
        }

        if (usedMethod === 'title_match') {
            logger.info(`Found ${item.name} via title: ${lookupResult.title} (TVDB: ${lookupResult.tvdbId})`);
        }

        const tvdbId = lookupResult.tvdbId;

        // Check if exists
        const existingItem = existingSeriesCache.find(s => s.tvdbId === tvdbId);

        if (existingItem) {
            logger.debug(`Series already exists (lookup match): ${lookupResult.title}`);
            if (item.seasons && item.seasons.length > 0) {
                await updateSeriesSeasonsRaw(existingItem, item.seasons);
            }
            return { tvdbId, wasAdded: false };
        }

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
            logger.info(`[DRY RUN] Would add series: ${payload.title}`);
            return { tvdbId, wasAdded: false };
        }

        logger.debug(`Adding series: ${payload.title}`);
        await axios.post('/api/v3/series', payload);
        logger.info(`Added series: ${payload.title}`);

        return { tvdbId, wasAdded: true };

    } catch (e: any) {
        logger.error(`Error adding series ${item.name}:`, e.message);
        return null;
    }
}

async function updateSeriesSeasonsRaw(existingSeries: SonarrSeriesResponse, targetSeasons: number[]): Promise<void> {
    try {
        if (!existingSeries || !existingSeries.seasons) return;

        let needsUpdate = false;
        const newSeasons = existingSeries.seasons.map((season) => {
            const shouldBeMonitored = targetSeasons.includes(season.seasonNumber);

            if (season.monitored !== shouldBeMonitored) {
                needsUpdate = true;
                return { ...season, monitored: shouldBeMonitored };
            }
            return season;
        });

        if (needsUpdate) {
            if (env.DRY_RUN) {
                logger.info(`[DRY RUN] Would update seasons for ${existingSeries.title}: ${targetSeasons.join(', ')}`);
            } else {
                logger.debug(`Updating seasons for ${existingSeries.title}: ${targetSeasons.join(', ')}`);
                const updatePayload = {
                    ...existingSeries,
                    seasons: newSeasons
                };

                await axios.put(`/api/v3/series/${existingSeries.id}`, updatePayload);
                logger.info(`Updated seasons for ${existingSeries.title}`);
            }
        }

        // Cleanup files for unmonitored seasons
        if (env.REMOVE_MISSING_ITEMS) {
            const seasonsToCleanup = existingSeries.seasons
                .filter(s => !targetSeasons.includes(s.seasonNumber))
                .map(s => s.seasonNumber);

            if (seasonsToCleanup.length > 0) {
                logger.debug(`Checking cleanup for ${existingSeries.title}: seasons ${seasonsToCleanup.join(', ')}`);

                const episodeFiles = await getEpisodeFiles(existingSeries.id);
                const filesToDelete = episodeFiles.filter(f => seasonsToCleanup.includes(f.seasonNumber));

                if (filesToDelete.length > 0) {
                    logger.info(`Deleting ${filesToDelete.length} files for ${existingSeries.title}`);

                    for (const file of filesToDelete) {
                        try {
                            await deleteEpisodeFile(file.id);
                        } catch (err) {
                            logger.error(err as any, `Failed to delete file ${file.id}`);
                        }
                    }
                }
            }
        }

    } catch (e: any) {
        logger.error(`Error updating seasons for ${existingSeries.title}:`, e.message);
    }
}
