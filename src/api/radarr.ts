import Axios from 'axios';
import env from '../util/env';
import { loadConfig } from '../util/config';
import logger from '../util/logger';
import { LetterboxdMovie } from '../scraper';
// import { mapConcurrency } from '../util/concurrency';
import { retryOperation } from '../util/retry';
import { calculateNextTagIds } from '../util/tagLogic';
import { radarrLimiter } from '../util/queues';

import { resolveTagsForItems } from '../util/tagHelper';

// Types
export interface RadarrMovie {
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

export interface RadarrMovieResponse {
    id: number;
    title: string;
    tmdbId: number;
    tags: number[];
    qualityProfileId: number;
    monitored: boolean;
    rootFolderPath?: string;
}

export interface RadarrProfile {
    id: number;
    name: string;
}

export interface RadarrTag {
    id: number;
    label: string;
}

interface RadarrRootFolder {
    id: number;
    path: string;
}

import { TAG_LETTERBOXD as DEFAULT_TAG_NAME } from '../util/constants';

const axios = Axios.create({
    baseURL: env.RADARR_API_URL,
    headers: {
        'X-Api-Key': env.RADARR_API_KEY
    },
    timeout: 30000 // 30 second timeout
});

// Helpers
export async function getAllQualityProfiles(): Promise<RadarrProfile[]> {
    try {
        return await retryOperation(async () => {
            const response = await axios.get<RadarrProfile[]>('/api/v3/qualityprofile');
            return response.data;
        }, 'get all quality profiles');
    } catch (error) {
        logger.error('Error getting all quality profiles:', error as any);
        return [];
    }
}

export async function getRootFolder(): Promise<string | null> {
    try {
        return await retryOperation(async () => {
            const response = await axios.get<RadarrRootFolder[]>('/api/v3/rootfolder');
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

export async function getRootFolderById(id: string): Promise<string | null> {
    try {
        const response = await axios.get<RadarrRootFolder>(`/api/v3/rootfolder/${id}`);
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

export async function getAllTags(): Promise<RadarrTag[]> {
    try {
        const response = await axios.get<RadarrTag[]>('/api/v3/tag');
        return response.data;
    } catch (error) {
        logger.error('Error getting all tags:', error as any);
        return [];
    }
}

export async function createTag(label: string): Promise<number | null> {
    try {
        logger.debug(`Creating new tag: ${label}`);
        const response = await axios.post<RadarrTag>('/api/v3/tag', { label });
        return response.data.id;
    } catch (error) {
        logger.error(`Error creating tag ${label}:`, error as any);
        return null;
    }
}

export async function getAllMovies(): Promise<RadarrMovieResponse[]> {
    try {
        return await retryOperation(async () => {
            const response = await axios.get<RadarrMovieResponse[]>('/api/v3/movie');
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

        if (env.GRANULAR_LOGGING) logger.info(`[GRANULAR] Starting deleteMovie for ${title} (${id})`);
        
        await retryOperation(async () => {
            await axios.delete(`/api/v3/movie/${id}`, {
                params: {
                    deleteFiles: true, // Delete files from disk
                    addImportExclusion: false // Allow re-adding later
                }
            });
        }, 'delete movie');
        
        if (env.GRANULAR_LOGGING) logger.info(`[GRANULAR] Finished deleteMovie for ${title} (${id})`);

        logger.info(`Successfully deleted movie: ${title}`);
    } catch (error) {
        logger.error(`Error deleting movie ${title} (ID: ${id}):`, error as any);
    }
}



interface SyncContext {
    globalProfileId: number;
    rootFolderPath: string;
    profileMap: Map<string, number>;
    tagMap: Map<string, number>;
    managedTagIds: Set<number>;
    systemTagIds: number[];
    letterboxdTagId?: number;
}

async function resolveSyncConfig(): Promise<{ globalProfileId: number; rootFolderPath: string; profileMap: Map<string, number> }> {
    const config = loadConfig();
    const radarrConfig = config.radarr;
    const globalQualityProfileName = radarrConfig?.qualityProfile || env.RADARR_QUALITY_PROFILE;
    
    if (!globalQualityProfileName) {
        throw new Error('Radarr global quality profile not configured');
    }

    const allProfiles = await getAllQualityProfiles();
    const profileMap = new Map<string, number>();
    allProfiles.forEach(p => profileMap.set(p.name, p.id));

    const globalProfileId = profileMap.get(globalQualityProfileName);
    if (!globalProfileId) {
        throw new Error(`Could not find global quality profile ID for: ${globalQualityProfileName}`);
    }

    const rootFolderConfig = radarrConfig?.rootFolder || env.RADARR_ROOT_FOLDER_ID;
    const rootFolderPath = !rootFolderConfig ? await getRootFolder() : 
                           (rootFolderConfig.startsWith('/') ? rootFolderConfig : await getRootFolderById(rootFolderConfig));

    if (!rootFolderPath) {
        throw new Error('Could not get root folder');
    }

    return { globalProfileId, rootFolderPath, profileMap };
}

async function resolveSyncTags(movies: LetterboxdMovie[], managedTags: Set<string>): Promise<{
    tagMap: Map<string, number>;
    managedTagIds: Set<number>;
    systemTagIds: number[];
    letterboxdTagId?: number;
}> {
    const config = loadConfig();
    const radarrConfig = config.radarr;
    const envTags = (env.RADARR_TAGS || '').split(',').map(t => t.trim()).filter(t => t.length > 0);
    const configTags = radarrConfig?.tags || [];
    const systemTagNames = [...new Set([DEFAULT_TAG_NAME, ...envTags, ...configTags])];

    const result = await resolveTagsForItems(
        movies.map(m => ({ tags: m.tags })),
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
        letterboxdTagId: result.defaultTagId
    };
}

async function processMovieSync(
    movie: LetterboxdMovie,
    ctx: SyncContext,
    existingMoviesMap: Map<number, RadarrMovieResponse>
): Promise<void> {
    const movieSpecificTagIds = (movie.tags || [])
        .map(t => ctx.tagMap.get(t))
        .filter((id): id is number => id !== undefined);
    
    // Merge system tags + movie tags
    const finalTagIds = [...new Set([...ctx.systemTagIds, ...movieSpecificTagIds])];

    // Resolve Quality Profile
    let qualityProfileId = ctx.globalProfileId;
    if (movie.qualityProfile) {
        const overrideId = ctx.profileMap.get(movie.qualityProfile);
        if (overrideId) {
            qualityProfileId = overrideId;
        } else {
            logger.warn(`Quality profile override '${movie.qualityProfile}' not found in Radarr. Using global default.`);
        }
    }

    const tmdbId = parseInt(movie.tmdbId || '0');
    if (tmdbId === 0) return;

    if (existingMoviesMap.has(tmdbId)) {
         const existingMovie = existingMoviesMap.get(tmdbId)!;
         

         if ((ctx.letterboxdTagId && existingMovie.tags && existingMovie.tags.includes(ctx.letterboxdTagId)) || env.OVERRIDE_TAGS) {
             const currentTags = existingMovie.tags || [];
             const nextTags = calculateNextTagIds(currentTags, ctx.managedTagIds, finalTagIds);

             const currentSet = new Set(currentTags);
             if (nextTags.length !== currentSet.size || !nextTags.every((t: any) => currentSet.has(t))) {
                 await updateMovie(existingMovie, nextTags);
             } else {
                 if (env.GRANULAR_LOGGING) logger.debug(`[GRANULAR] Movie ${movie.name} tags already up to date.`);
                 logger.debug(`Movie ${movie.name} tags already up to date.`);
             }
         } else {
             if (env.GRANULAR_LOGGING) logger.debug(`[GRANULAR] Skipping update for ${movie.name}: Missing ownership tag.`);
             logger.debug(`Skipping update for ${movie.name}: Missing ownership tag.`);
         }
         return;
    }

    await addMovie(movie, qualityProfileId, ctx.rootFolderPath, finalTagIds, env.RADARR_MINIMUM_AVAILABILITY, existingMoviesMap);
}

async function processLibraryCleanup(
    existingMovies: any[], 
    watchlistTmdbIds: Set<number>, 
    letterboxdTagId: number, 
    unsafeTags: Set<string>
): Promise<void> {
    if (!env.REMOVE_MISSING_ITEMS) return;

    logger.info('Checking for items to remove...');
    
    // Fetch all tags for unsafe check
    const allRadarrTags = await getAllTags();
    const radarrTagIdToLabel = new Map<number, string>();
    allRadarrTags.forEach(t => radarrTagIdToLabel.set(t.id, t.label));

    const moviesToRemove = existingMovies.filter((m: any) => {
        const hasTag = m.tags && m.tags.includes(letterboxdTagId);
        const notInWatchlist = !watchlistTmdbIds.has(m.tmdbId);


        const movieTagIds: number[] = m.tags || [];
        const hasUnsafeTag = movieTagIds.some(id => {
            const label = radarrTagIdToLabel.get(id);
            return label && unsafeTags.has(label);
        });

        if (hasUnsafeTag) {
            logger.debug(`Skipping removal of ${m.title} because it has an unsafe tag (from a failed list).`);
            return false;
        }

        return hasTag && notInWatchlist;
    });

    if (moviesToRemove.length > 0) {
        logger.info(`Found ${moviesToRemove.length} movies to remove.`);
        if (env.GRANULAR_LOGGING) logger.info(`[GRANULAR] Processing removal for ${moviesToRemove.length} movies...`);
        await Promise.all(moviesToRemove.map(movie => 
            radarrLimiter.schedule(async () => {
                if (env.GRANULAR_LOGGING) logger.info(`[GRANULAR] Creating delete task for ${movie.title}`);
                await deleteMovie(movie.id, movie.title);
            })
        ));
    } else {
        logger.info('No movies to remove.');
    }
}

export async function syncMovies(movies: LetterboxdMovie[], managedTags: Set<string>, unsafeTags: Set<string> = new Set(), abortCleanup: boolean = false): Promise<void> {

    const { globalProfileId, rootFolderPath, profileMap } = await resolveSyncConfig();
    const { tagMap, managedTagIds, systemTagIds, letterboxdTagId } = await resolveSyncTags(movies, managedTags);

    const context: SyncContext = {
        globalProfileId,
        rootFolderPath,
        profileMap,
        tagMap,
        managedTagIds,
        systemTagIds,
        letterboxdTagId
    };


    logger.info('Fetching existing movies from Radarr...');
    const existingMovies = await getAllMovies();
    const existingMoviesMap = new Map(existingMovies.map((m: any) => [m.tmdbId, m]));
    logger.info(`Found ${existingMovies.length} existing movies in Radarr.`);


    logger.info(`Processing ${movies.length} movies from Letterboxd...`);
    const results = await Promise.all(movies.map(movie => 
        radarrLimiter.schedule(() => processMovieSync(movie, context, existingMoviesMap))
    ));
    logger.info(`Finished processing movies.`);


    if (abortCleanup) {
        logger.warn('Cleanup phase ABORTED due to safety lock. A list without tags failed to scrape, so we cannot safely remove items.');
    } else if (letterboxdTagId) {
        const watchlistTmdbIds = new Set(movies.map(m => m.tmdbId ? parseInt(m.tmdbId) : null).filter(id => id !== null));
        await processLibraryCleanup(existingMovies, watchlistTmdbIds as Set<number>, letterboxdTagId, unsafeTags);
    }
}

export async function addMovie(movie: LetterboxdMovie, qualityProfileId: number, rootFolderPath: string, tagIds: number[], minimumAvailability: string, existingMoviesMap?: Map<number, any>): Promise<void> {
    try {
        if (!movie.tmdbId) {
            logger.info(`Could not add movie ${movie.name} because no tmdb id was found. Is this a TV show?`);
            return;
        }

        const tmdbId = parseInt(movie.tmdbId);

        if (existingMoviesMap && existingMoviesMap.has(tmdbId)) {
            if (env.GRANULAR_LOGGING) logger.debug(`[GRANULAR] Movie ${movie.name} already in Radarr (cached)`);
            logger.debug(`Movie ${movie.name} already exists in Radarr (cached), skipping`);
            return;
        }

        if (env.GRANULAR_LOGGING) logger.info(`[GRANULAR] Adding movie to Radarr: ${movie.name}`);
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
        if (env.GRANULAR_LOGGING) logger.info(`[GRANULAR] Successfully added movie: ${payload.title}`);
        logger.info(`Successfully added movie: ${payload.title}`, response.data);
    } catch (e: any) {
        const isExistsError = e.response?.data && Array.isArray(e.response.data) && e.response.data.some((err: any) => 
            err.errorCode === 'MovieExistsValidator' || 
            (err.propertyName === 'TmdbId' && err.errorMessage?.includes('already been added'))
        );

        if (isExistsError) {
             logger.debug(`Movie ${movie.name} already exists in Radarr (API check), skipping`);
             return;
        }
        
        // Fallback to legacy string check just in case
        if (e.response?.status === 400 && (JSON.stringify(e.response?.data)).includes('already been added')) {
            logger.debug(`Movie ${movie.name} already exists in Radarr (legacy check), skipping`);
            return;
        }

        logger.error(`Error adding movie ${movie.name} (TMDB: ${movie.tmdbId}):`, e as any);
    }
}

export async function updateMovie(existingMovie: any, newTags: number[]): Promise<void> {
    try {
        if (env.DRY_RUN) {
            logger.info(`[DRY RUN] Would update tags for movie: ${existingMovie.title} -> [${newTags.join(', ')}]`);
            return;
        }

        if (env.GRANULAR_LOGGING) logger.info(`[GRANULAR] Updating tags for movie: ${existingMovie.title}`);
        logger.info(`Updating tags for movie: ${existingMovie.title}`);
        const payload = {
            ...existingMovie,
            tags: newTags
        };

        await axios.put(`/api/v3/movie/${existingMovie.id}`, payload);
        if (env.GRANULAR_LOGGING) logger.info(`[GRANULAR] Finished updating tags for movie: ${existingMovie.title}`);
    } catch (e: any) {
        logger.error(`Error updating movie ${existingMovie.title}:`, e as any);
    }
}
