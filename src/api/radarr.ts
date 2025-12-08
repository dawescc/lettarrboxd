import Axios from 'axios';
import env from '../util/env';
import config from '../util/config';
import logger from '../util/logger';
import { LetterboxdMovie } from '../scraper';
import Bluebird from 'bluebird';

interface RadarrMovie {
    title: string;
    qualityProfileId: number;
    rootFolderPath: string;
    tmdbId: number;
    minimumAvailability: string;
    monitored: boolean;
    tags: number[];
    addOptions: {
        searchForMovie: boolean;
    }
}

export const DEFAULT_TAG_NAME = 'letterboxd';

const axios = Axios.create({
    baseURL: env.RADARR_API_URL,
    headers: {
        'X-Api-Key': env.RADARR_API_KEY
    }
});

import { retryOperation } from '../util/retry';

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
        logger.error('Error getting quality profiles:', error as any);
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
                logger.debug(`Using root folder: ${rootFolder}`);
                return rootFolder;
            } else {
                logger.error('No root folders found in Radarr');
                return null;
            }
        }, 'get root folder');
    } catch (error) {
        logger.error('Error getting root folders:', error as any);
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
        logger.error(`Error getting root folder by id: ${id}`);
        return null;
    }
}

export async function getOrCreateTag(tagName: string): Promise<number | null> {
    try {
        logger.debug(`Getting or creating tag: ${tagName}`);

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

    if (env.RADARR_TAGS) {
        const userTags = env.RADARR_TAGS
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

export async function getAllMovies(): Promise<any[]> {
    try {
        return await retryOperation(async () => {
            const response = await axios.get('/api/v3/movie');
            return response.data;
        }, 'get all movies');
    } catch (error) {
        logger.error('Error getting all movies from Radarr:', error as any);
        return [];
    }
}

export async function deleteMovie(id: number, title: string): Promise<void> {
    try {
        if (env.DRY_RUN) {
            logger.info(`[DRY RUN] Would delete movie from Radarr: ${title} (ID: ${id})`);
            return;
        }

        await retryOperation(async () => {
            await axios.delete(`/api/v3/movie/${id}`, {
                params: {
                    deleteFiles: true, // Delete files from disk
                    addImportExclusion: false // Allow re-adding later
                }
            });
        }, 'delete movie');
        
        logger.info(`Successfully deleted movie: ${title}`);
    } catch (error) {
        logger.error(`Error deleting movie ${title} (ID: ${id}):`, error as any);
    }
}

export async function syncMovies(movies: LetterboxdMovie[]): Promise<void> {
    const radarrConfig = config.radarr;
    // Fallback to ENV if config absent
    const qualityProfileName = radarrConfig?.qualityProfile || env.RADARR_QUALITY_PROFILE;
    
    if (!qualityProfileName) {
        throw new Error('Radarr quality profile not configured');
    }
    const qualityProfileId = await getQualityProfileId(qualityProfileName);

    if (!qualityProfileId) {
        throw new Error('Could not get quality profile ID.');
    }

    const rootFolderConfig = radarrConfig?.rootFolder || env.RADARR_ROOT_FOLDER_ID;
    const rootFolderPath = !rootFolderConfig ? await getRootFolder() : 
                           (rootFolderConfig.startsWith('/') ? rootFolderConfig : await getRootFolderById(rootFolderConfig));

    if (!rootFolderPath) {
        throw new Error('Could not get root folder');
    }

    // --- Tag Resolution ---

    // 1. Resolve System Tags (Config + Global Env)
    // We combine env.RADARR_TAGS and config.radarr.tags
    const envTags = (env.RADARR_TAGS || '').split(',').map(t => t.trim()).filter(t => t.length > 0);
    const configTags = radarrConfig?.tags || [];
    const systemTagNames = [...new Set([DEFAULT_TAG_NAME, ...envTags, ...configTags])];

    // 2. Resolve Per-Movie Tags
    const movieTagNames = new Set<string>();
    movies.forEach(m => {
        if (m.tags) {
            m.tags.forEach(t => movieTagNames.add(t));
        }
    });

    // 3. Create IDs for ALL unique tags found
    const allUniqueTags = new Set([...systemTagNames, ...movieTagNames]);
    const tagMap = new Map<string, number>();

    logger.info(`Resolving ${allUniqueTags.size} tags...`);
    for (const tagName of allUniqueTags) {
        const id = await getOrCreateTag(tagName);
        if (id) {
            tagMap.set(tagName, id);
        }
    }

    const startSystemTagIds = systemTagNames.map(name => tagMap.get(name)).filter((id): id is number => id !== undefined);
    const letterboxdTagId = tagMap.get(DEFAULT_TAG_NAME);

    // --- Sync Logic ---

    // 1. Fetch all existing movies from Radarr
    logger.info('Fetching existing movies from Radarr...');
    const existingMovies = await getAllMovies();
    const existingMoviesMap = new Map(existingMovies.map((m: any) => [m.tmdbId, m]));
    
    logger.info(`Found ${existingMovies.length} existing movies in Radarr.`);

    // 2. Add new movies
    logger.info(`Processing ${movies.length} movies from Letterboxd...`);
    const results = await Bluebird.map(movies, movie => {
        // Calculate tags for this specific movie
        const movieSpecificTagIds = (movie.tags || [])
            .map(t => tagMap.get(t))
            .filter((id): id is number => id !== undefined);
        
        // Merge system tags + movie tags
        const finalTagIds = [...new Set([...startSystemTagIds, ...movieSpecificTagIds])];

        return addMovie(movie, qualityProfileId, rootFolderPath, finalTagIds, env.RADARR_MINIMUM_AVAILABILITY, existingMoviesMap);
    }, { concurrency: 3 });

    const addedCount = results.filter(r => r !== undefined).length;
    logger.info(`Finished processing movies. Added ${addedCount} new movies.`);

    // 3. Remove missing movies (if enabled)
    if (env.REMOVE_MISSING_ITEMS && letterboxdTagId) {
        logger.info('Checking for items to remove...');
        
        // Create a set of TMDB IDs from the watchlist for fast lookup
        const watchlistTmdbIds = new Set(movies.map(m => m.tmdbId ? parseInt(m.tmdbId) : null).filter(id => id !== null));

        const moviesToRemove = existingMovies.filter((m: any) => {
            // Check if movie has the 'letterboxd' tag
            const hasTag = m.tags && m.tags.includes(letterboxdTagId);
            
            // Check if movie is NOT in the current watchlist
            const notInWatchlist = !watchlistTmdbIds.has(m.tmdbId);

            return hasTag && notInWatchlist;
        });

        if (moviesToRemove.length > 0) {
            logger.info(`Found ${moviesToRemove.length} movies to remove.`);
            await Bluebird.map(moviesToRemove, (movie: any) => {
                return deleteMovie(movie.id, movie.title);
            }, { concurrency: 3 });
        } else {
            logger.info('No movies to remove.');
        }
    }
}

export async function addMovie(movie: LetterboxdMovie, qualityProfileId: number, rootFolderPath: string, tagIds: number[], minimumAvailability: string, existingMoviesMap?: Map<number, any>): Promise<void> {
    try {
        if (!movie.tmdbId) {
            logger.info(`Could not add movie ${movie.name} because no tmdb id was found. Is this a TV show?`);
            return;
        }

        const tmdbId = parseInt(movie.tmdbId);

        // Check local cache first if available
        if (existingMoviesMap && existingMoviesMap.has(tmdbId)) {
            logger.debug(`Movie ${movie.name} already exists in Radarr (cached), skipping`);
            return;
        }

        logger.debug(`Adding movie to Radarr: ${movie.name}`);

        const payload: RadarrMovie = {
            title: movie.name,
            qualityProfileId,
            rootFolderPath,
            tmdbId: tmdbId,
            minimumAvailability,
            monitored: !env.RADARR_ADD_UNMONITORED,
            tags: tagIds,
            addOptions: {
                searchForMovie: true
            }
        }

        if (env.DRY_RUN) {
            logger.info(payload, `[DRY RUN] Would add movie to Radarr: ${payload.title} (TMDB: ${payload.tmdbId})`);
            return;
        }

        const response = await axios.post('/api/v3/movie', payload);

        logger.info(`Successfully added movie: ${payload.title}`, response.data);
        return response.data;
    } catch (e: any) {
        if (e.response?.status === 400 && (JSON.stringify(e.response?.data)).includes('This movie has already been added')) {
            logger.debug(`Movie ${movie.name} already exists in Radarr (API check), skipping`);
            return;
        }
        logger.error(`Error adding movie ${movie.name} (TMDB: ${movie.tmdbId}):`, e as any);
    }
}
