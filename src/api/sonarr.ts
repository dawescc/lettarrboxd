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
        logger.error('Error getting Sonarr quality profiles:', error);
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
        logger.error('Error getting Sonarr root folders:', error);
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
        logger.error(`Error getting or creating tag ${tagName}:`, error);
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
        logger.error(`Error looking up series with TMDB ID ${tmdbId}:`, error);
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

export async function upsertSeries(seriesList: LetterboxdMovie[]): Promise<void> {
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

    await Bluebird.map(seriesList, series => {
        return addSeries(series, qualityProfileId, rootFolderPath, tagIds);
    }, { concurrency: 1 });
}

async function addSeries(item: LetterboxdMovie, qualityProfileId: number, rootFolderPath: string, tagIds: number[]): Promise<void> {
    try {
        if (!item.tmdbId) {
            logger.warn(`Skipping ${item.name}: No TMDB ID`);
            return;
        }

        const lookupResult = await getSeriesLookup(item.tmdbId);
        if (!lookupResult) {
            logger.warn(`Could not find series in Sonarr lookup: ${item.name} (TMDB: ${item.tmdbId})`);
            return;
        }

        if (lookupResult.id) {
            logger.debug(`Series already exists in Sonarr: ${lookupResult.title}`);
            return;
        }

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
            logger.info(`[DRY RUN] Would add series to Sonarr: ${payload.title}`, payload);
            return;
        }

        const response = await axios.post('/api/v3/series', payload);
        logger.info(`Successfully added series: ${payload.title}`, response.data);

    } catch (e: any) {
        logger.error(`Error adding series ${item.name}:`, e.message);
    }
}
