import Axios from 'axios';
import env from '../util/env';
import { loadConfig } from '../util/config';
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
import { calculateNextTagIds } from '../util/tagLogic';



export async function getAllQualityProfiles(): Promise<any[]> {
    try {
        return await retryOperation(async () => {
            const response = await axios.get('/api/v3/qualityprofile');
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

export async function getAllTags(): Promise<Array<{ id: number, label: string }>> {
    try {
        const response = await axios.get('/api/v3/tag');
        return response.data;
    } catch (error) {
        logger.error('Error getting all tags:', error as any);
        return [];
    }
}

export async function createTag(label: string): Promise<number | null> {
    try {
        logger.debug(`Creating new tag: ${label}`);
        const response = await axios.post('/api/v3/tag', { label });
        return response.data.id;
    } catch (error) {
        logger.error(`Error creating tag ${label}:`, error as any);
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
        logger.info(`Creating ${missingTags.length} new tags in Radarr...`);
        // Create them sequentially to avoid race conditions or rate limits, 
        // but we assume they don't exist because we just checked the fresh list.
        for (const tagLabel of missingTags) {
            const newId = await createTag(tagLabel);
            if (newId) {
                tagMap.set(tagLabel, newId);
            }
        }
    }

    return tagMap;
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

export async function syncMovies(movies: LetterboxdMovie[], managedTags: Set<string>, unsafeTags: Set<string> = new Set()): Promise<void> {
    const config = loadConfig();
    const radarrConfig = config.radarr;
    // Fallback to ENV if config absent
    // Fallback to ENV if config absent
    const globalQualityProfileName = radarrConfig?.qualityProfile || env.RADARR_QUALITY_PROFILE;
    
    if (!globalQualityProfileName) {
        throw new Error('Radarr global quality profile not configured');
    }

    // Cache all profiles to avoid repeated lookups
    const allProfiles = await getAllQualityProfiles();
    const profileMap = new Map<string, number>();
    allProfiles.forEach((p: any) => profileMap.set(p.name, p.id));

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

    // --- Tag Resolution ---

    // 1. Collect ALL required tags (System + Movies)
    const envTags = (env.RADARR_TAGS || '').split(',').map(t => t.trim()).filter(t => t.length > 0);
    const configTags = radarrConfig?.tags || [];
    const systemTagNames = [...new Set([DEFAULT_TAG_NAME, ...envTags, ...configTags])];

    const movieTagNames = new Set<string>();
    movies.forEach(m => {
        if (m.tags) {
            m.tags.forEach(t => movieTagNames.add(t));
        }
    });

    const allRequiredTags = [...new Set([...systemTagNames, ...movieTagNames, ...managedTags])];

    // 2. Resolve IDs (Batch operation)
    logger.info(`Resolving ${allRequiredTags.length} tags...`);
    const tagMap = await ensureTagsAreAvailable(allRequiredTags);

    // Map managed tags (strings) to IDs for cleaning
    const managedTagIds = new Set<number>();
    managedTags.forEach(t => {
        const id = tagMap.get(t);
        if (id) managedTagIds.add(id);
    });
    // Add system tags to managed list so we can clean them if needed (though unlikely we'd remove system tags unless config changes)
    systemTagNames.forEach(t => {
        const id = tagMap.get(t);
        if (id) managedTagIds.add(id);
    });

    const startSystemTagIds = systemTagNames
        .map(name => tagMap.get(name))
        .filter((id): id is number => id !== undefined);
        
    const letterboxdTagId = tagMap.get(DEFAULT_TAG_NAME);

    // --- Sync Logic ---

    // 1. Fetch all existing movies from Radarr
    logger.info('Fetching existing movies from Radarr...');
    const existingMovies = await getAllMovies();
    const existingMoviesMap = new Map(existingMovies.map((m: any) => [m.tmdbId, m]));
    
    logger.info(`Found ${existingMovies.length} existing movies in Radarr.`);

    // 2. Add/Update movies
    logger.info(`Processing ${movies.length} movies from Letterboxd...`);
    const results = await Bluebird.map(movies, async (movie) => {
        // Calculate tags for this specific movie
        const movieSpecificTagIds = (movie.tags || [])
            .map(t => tagMap.get(t))
            .filter((id): id is number => id !== undefined);
        
        // Merge system tags + movie tags
        const finalTagIds = [...new Set([...startSystemTagIds, ...movieSpecificTagIds])];

        // Resolve Quality Profile
        let qualityProfileId = globalProfileId;
        if (movie.qualityProfile) {
            const overrideId = profileMap.get(movie.qualityProfile);
            if (overrideId) {
                qualityProfileId = overrideId;
            } else {
                logger.warn(`Quality profile override '${movie.qualityProfile}' not found in Radarr. Using global default.`);
            }
        }

        const tmdbId = parseInt(movie.tmdbId || '0');
        if (tmdbId === 0) return;

        // Check if exists
        if (existingMoviesMap.has(tmdbId)) {
             const existingMovie = existingMoviesMap.get(tmdbId)!;
             
             // OWNERSHIP CHECK: Only touch if it has the 'letterboxd' tag OR override mode is on
             if ((letterboxdTagId && existingMovie.tags && existingMovie.tags.includes(letterboxdTagId)) || env.OVERRIDE_TAGS) {
                 // Smart Tag Sync
                 const currentTags = existingMovie.tags || [];
                 const nextTags = calculateNextTagIds(currentTags, managedTagIds, finalTagIds);

                 // 3. Check for change
                 const currentSet = new Set(currentTags);
                 if (nextTags.length !== currentSet.size || !nextTags.every(t => currentSet.has(t))) {
                     await updateMovie(existingMovie, nextTags);
                 } else {
                     logger.debug(`Movie ${movie.name} tags already up to date.`);
                 }
             } else {
                 logger.debug(`Skipping update for ${movie.name}: Missing ownership tag.`);
             }
             return;
        }

        return addMovie(movie, qualityProfileId, rootFolderPath, finalTagIds, env.RADARR_MINIMUM_AVAILABILITY, existingMoviesMap);
    }, { concurrency: 3 });

    const addedCount = results.filter(r => r !== undefined).length;
    logger.info(`Finished processing movies.`);

    // 3. Remove missing movies (if enabled)
    if (env.REMOVE_MISSING_ITEMS && letterboxdTagId) {
        logger.info('Checking for items to remove...');
        
        // Create a set of TMDB IDs from the watchlist for fast lookup
        const watchlistTmdbIds = new Set(movies.map(m => m.tmdbId ? parseInt(m.tmdbId) : null).filter(id => id !== null));

        // Create a Set of unsafe tag IDs for fast lookup
        // Note: We might not have IDs for all unsafe tags if they didn't exist in Radarr yet,
        // but if they didn't exist, no movie can have them, so it's fine.
        // We only care about checking tags that ARE in Radarr.
        const unsafeTagIds = new Set<number>();
        unsafeTags.forEach(t => {
            // We need to look up the ID again as it might not be in managedTags
            // But ensureTagsAreAvailable was called with allRequiredTags which includes managedTags.
            // If an unsafe tag was part of a FAILED list, it might NOT be in managedTags.
            // So we rely on tagMap having it? 
            // `tagMap` only contains IDs for tags we asked for in `allRequiredTags`.
            // `allRequiredTags` includes `managedTags` but `processLists` REMOVED unsafe tags from managedTags!
            // So `tagMap` might MISS the unsafe tags if they aren't used by any other successful list.
            
            // However, we can try to look it up in tagMap results just in case, 
            // OR we iterate `existingTags` (which we fetched inside ensureTagsAreAvailable but didn't expose).
            // Actually, we called `getAllTags` inside `ensureTagsAreAvailable` but returned a map of only requested tags.
            
            // Strategy: We need to map unsafeTags (names) to IDs.
            // Since we can't trust tagMap to have them (we excluded them from the 'required' list passed to it),
            // we should be careful. 
            // BUT, if a movie in Radarr *has* the tag, the tag MUST exist in Radarr.
            // So we can map the movie's tag IDs back to Names? Or map unsafe names to IDs?
            // Let's assume we can fetch all tags again? Or just be robust.
            
            // To be safe/correct: We should fetch all tags map AGAIN or cache it better.
            // But `ensureTagsAreAvailable` did the heavy lifting.
            // Let's just assume we might miss some IDs if we don't fetch them.
            // Hack/Optimization: Filter `moviesToRemove` by checking if any of their tags MATCH an unsafe tag name.
            // This requires fetching all tags to map ID -> Name.
        });

        // Better approach: fetch all tags to get a full ID->Name map.
        const allRadarrTags = await getAllTags();
        const radarrTagIdToLabel = new Map<number, string>();
        allRadarrTags.forEach(t => radarrTagIdToLabel.set(t.id, t.label));

        const moviesToRemove = existingMovies.filter((m: any) => {
            // Check if movie has the 'letterboxd' tag
            const hasTag = m.tags && m.tags.includes(letterboxdTagId);
            
            // Check if movie is NOT in the current watchlist
            const notInWatchlist = !watchlistTmdbIds.has(m.tmdbId);

            // FAILURE PROTECTION: Check if movie has any "Unsafe" tags (tags from failed lists)
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

export async function updateMovie(existingMovie: any, newTags: number[]): Promise<void> {
    try {
        if (env.DRY_RUN) {
            logger.info(`[DRY RUN] Would update tags for movie: ${existingMovie.title} -> [${newTags.join(', ')}]`);
            return;
        }

        logger.info(`Updating tags for movie: ${existingMovie.title}`);
        const payload = {
            ...existingMovie,
            tags: newTags
        };

        await axios.put(`/api/v3/movie/${existingMovie.id}`, payload);
    } catch (e: any) {
        logger.error(`Error updating movie ${existingMovie.title}:`, e as any);
    }
}
