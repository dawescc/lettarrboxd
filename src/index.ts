require('dotenv').config();

import env from './util/env';
import config, { loadConfig } from './util/config';
import logger from './util/logger';
import { isListActive } from './util/schedule';
import { fetchMoviesFromUrl, ScrapedMedia, LetterboxdMovie, ScrapedSeries } from './scraper';
import { syncMovies } from './api/radarr';
import { SerializdScraper } from './scraper/serializd';
import { syncSeries } from './api/sonarr';
import * as plex from './api/plex';
import { startHealthServer, setAppStatus, updateComponentStatus } from './api/health';
import { TAG_LETTERBOXD, TAG_SERIALIZD } from './util/constants';
import { movieListQueue, tvListQueue } from './util/queues';

// Types for our generic processor
interface BaseListConfig {
    id?: string;
    url: string;
    tags: string[];
    activeFrom?: string;
    activeUntil?: string;
    filters?: {
        minRating?: number;
        minYear?: number;
        maxYear?: number;
    };
    takeAmount?: number;
    takeStrategy?: 'oldest' | 'newest';
    qualityProfile?: string;
}

function startScheduledMonitoring(): void {
    setAppStatus('syncing');
    run().catch(e => {
        logger.error('Fatal error in initial run:', e);
    }).finally(() => {
        setAppStatus('idle');
        scheduleNextRun();
    });

    logger.info(`Scheduled to run every ${env.CHECK_INTERVAL_MINUTES} minutes`);
}

function scheduleNextRun() {
    const intervalMs = env.CHECK_INTERVAL_MINUTES * 60 * 1000;
    setTimeout(() => {
        setAppStatus('syncing');
        run().catch(e => {
            logger.error('Fatal error in scheduled run:', e);
        }).finally(() => {
            setAppStatus('idle');
            scheduleNextRun();
        });
    }, intervalMs);

    const nextRun = new Date(Date.now() + intervalMs);
    logger.info(`Next run scheduled for: ${nextRun.toLocaleString()}`);
}

/**
 * Process Movie Lists (Letterboxd -> Radarr)
 */
export async function syncMoviesFromLists(
    lists: BaseListConfig[],
    plexGlobalTags: string[]
) {
    if (lists.length === 0) {
        updateComponentStatus('letterboxd', 'disabled');
        return;
    }

    const potentialManagedTags = new Set<string>();
    const unsafeTags = new Set<string>();
    let hasError = false;
    let abortCleanup = false;

    const allItems = new Map<string, LetterboxdMovie>();

    logger.info(`Processing ${lists.length} Letterboxd lists...`);

    // Use movieListQueue for list processing (separate from TV)
    await movieListQueue.addAll(lists.map(list => async () => {
        if (!isListActive(list)) {
            logger.info(`Skipping inactive list: ${list.id || list.url}`);
            return;
        }

        try {
            logger.info(`Fetching list: ${list.url} (Tags: ${list.tags.join(', ')})`);

            const { items: movies, hasErrors: listHasErrors } = await fetchMoviesFromUrl(list.url, list.takeAmount, list.takeStrategy);

            // Apply Filters
            let filteredMovies = movies;
            if (list.filters) {
                const initialCount = movies.length;
                filteredMovies = movies.filter(movie => {
                    const { minRating, minYear, maxYear } = list.filters!;

                    if (minRating !== undefined && (movie.rating === undefined || movie.rating === null || movie.rating < minRating)) return false;
                    if (minYear !== undefined && (movie.publishedYear === undefined || movie.publishedYear === null || movie.publishedYear < minYear)) return false;
                    if (maxYear !== undefined && (movie.publishedYear === undefined || movie.publishedYear === null || movie.publishedYear > maxYear)) return false;

                    return true;
                });

                const excludedCount = initialCount - filteredMovies.length;
                if (excludedCount > 0) {
                    logger.info(`Filtered ${excludedCount} items from list based on configuration.`);
                }
            }

            if (listHasErrors) {
                logger.warn(`List ${list.url} reported partial errors. Marking tags as UNSAFE.`);
                if (list.tags && list.tags.length > 0) {
                    list.tags.forEach(t => unsafeTags.add(t));
                } else {
                    logger.error(`List ${list.url} failed and has NO tags. Activating SAFETY LOCK.`);
                    abortCleanup = true;
                }
                hasError = true;
            }

            if (list.tags) list.tags.forEach(t => potentialManagedTags.add(t));

            for (const movie of filteredMovies) {
                if (!movie.tmdbId) {
                    logger.warn(`Movie '${movie.name}' missing TMDB ID. Marking tags unsafe.`);
                    if (list.tags && list.tags.length > 0) {
                        list.tags.forEach(t => unsafeTags.add(t));
                    } else {
                        logger.error(`List has items without IDs and NO tags. Activating SAFETY LOCK.`);
                        abortCleanup = true;
                    }
                    continue;
                }

                if (allItems.has(movie.tmdbId)) {
                    const existing = allItems.get(movie.tmdbId)!;
                    const existingTags = existing.tags || [];
                    const newTags = list.tags || [];
                    existing.tags = [...new Set([...existingTags, ...newTags])];

                    if (list.qualityProfile) {
                        existing.qualityProfile = list.qualityProfile;
                    }
                } else {
                    movie.tags = [...(list.tags || [])];
                    if (list.qualityProfile) {
                        movie.qualityProfile = list.qualityProfile;
                    }
                    allItems.set(movie.tmdbId, movie);
                }
            }
            logger.info(`Fetched ${filteredMovies.length} movies from list.`);

        } catch (e: any) {
            logger.error(`Error fetching list ${list.url}:`, e);
            hasError = true;
            if (list.tags && list.tags.length > 0) {
                list.tags.forEach(t => unsafeTags.add(t));
            } else {
                logger.error(`List failed entirely and has NO tags. Activating SAFETY LOCK.`);
                abortCleanup = true;
            }
        }
    }));

    // Calculate Managed Tags
    const managedTags = new Set<string>();
    potentialManagedTags.forEach(t => {
        if (!unsafeTags.has(t)) {
            managedTags.add(t);
        } else {
            logger.warn(`Tag '${t}' is present in a failed list. Protected from cleanup.`);
        }
    });

    const uniqueMovies = Array.from(allItems.values());

    if (uniqueMovies.length > 0) {
        const statusMsg = hasError
            ? `Found ${uniqueMovies.length} unique movies (some list errors)`
            : `Found ${uniqueMovies.length} unique movies`;

        updateComponentStatus('letterboxd', 'ok', statusMsg);
        logger.info(`Total unique movies found: ${uniqueMovies.length}`);

        try {
            await syncMovies(uniqueMovies, managedTags, unsafeTags, abortCleanup);
            updateComponentStatus('radarr', 'ok');

            const allPlexTags = [...plexGlobalTags, TAG_LETTERBOXD];
            const plexManagedTags = new Set([...managedTags, ...allPlexTags]);

            await plex.syncPlexTags(uniqueMovies, allPlexTags, plexManagedTags, 'movie');
        } catch (e: any) {
            updateComponentStatus('radarr', 'error', e.message);
            throw e;
        }
    } else {
        if (hasError) {
            updateComponentStatus('letterboxd', 'error', 'Failed to fetch any movies');
        } else {
            updateComponentStatus('letterboxd', 'ok', 'No movies found in lists');
        }
    }
}

/**
 * Process TV Show Lists (Serializd -> Sonarr)
 */
export async function syncShowsFromLists(
    lists: BaseListConfig[],
    plexGlobalTags: string[]
) {
    if (lists.length === 0) {
        updateComponentStatus('serializd', 'disabled');
        return;
    }

    const potentialManagedTags = new Set<string>();
    const unsafeTags = new Set<string>();
    let hasError = false;
    let abortCleanup = false;

    const allItems = new Map<string, ScrapedSeries>();

    logger.info(`Processing ${lists.length} Serializd lists...`);

    // Use tvListQueue for list processing (separate from movies)
    await tvListQueue.addAll(lists.map(list => async () => {
        if (!isListActive(list)) {
            logger.info(`Skipping inactive list: ${list.id || list.url}`);
            return;
        }

        try {
            logger.info(`Fetching list: ${list.url} (Tags: ${list.tags.join(', ')})`);

            const scraper = new SerializdScraper(list.url);
            const { items: shows, hasErrors: listHasErrors } = await scraper.getSeries();

            if (listHasErrors) {
                logger.warn(`List ${list.url} reported partial errors. Marking tags UNSAFE.`);
                if (list.tags && list.tags.length > 0) {
                    list.tags.forEach(t => unsafeTags.add(t));
                } else {
                    logger.error(`List ${list.url} failed and has NO tags. Activating SAFETY LOCK.`);
                    abortCleanup = true;
                }
                hasError = true;
            }

            if (list.tags) list.tags.forEach(t => potentialManagedTags.add(t));

            for (const show of shows) {
                const key = show.tmdbId || show.id.toString();

                if (allItems.has(key)) {
                    const existing = allItems.get(key)!;
                    const existingTags = existing.tags || [];
                    const newTags = list.tags || [];
                    existing.tags = [...new Set([...existingTags, ...newTags])];

                    if (list.qualityProfile) {
                        existing.qualityProfile = list.qualityProfile;
                    }
                } else {
                    show.tags = [...(list.tags || [])];
                    if (list.qualityProfile) {
                        show.qualityProfile = list.qualityProfile;
                    }
                    allItems.set(key, show);
                }
            }
            logger.info(`Fetched ${shows.length} shows from list.`);

        } catch (e: any) {
            logger.error(`Error fetching list ${list.url}:`, e);
            hasError = true;
            if (list.tags && list.tags.length > 0) {
                list.tags.forEach(t => unsafeTags.add(t));
            } else {
                logger.error(`List failed entirely and has NO tags. Activating SAFETY LOCK.`);
                abortCleanup = true;
            }
        }
    }));

    const managedTags = new Set<string>();
    potentialManagedTags.forEach(t => {
        if (!unsafeTags.has(t)) {
            managedTags.add(t);
        } else {
            logger.warn(`Tag '${t}' is present in a failed list. Protected.`);
        }
    });

    const uniqueShows = Array.from(allItems.values());

    if (uniqueShows.length > 0) {
        const statusMsg = hasError
            ? `Found ${uniqueShows.length} unique shows (some list errors)`
            : `Found ${uniqueShows.length} unique shows`;

        updateComponentStatus('serializd', 'ok', statusMsg);
        logger.info(`Total unique shows found: ${uniqueShows.length}`);

        try {
            await syncSeries(uniqueShows, managedTags, unsafeTags, abortCleanup);
            updateComponentStatus('sonarr', 'ok');

            const allPlexTags = [...plexGlobalTags, TAG_SERIALIZD];
            const plexManagedTags = new Set([...managedTags, ...allPlexTags]);

            await plex.syncPlexTags(uniqueShows, allPlexTags, plexManagedTags, 'show');
        } catch (e: any) {
            updateComponentStatus('sonarr', 'error', e.message);
            throw e;
        }
    } else {
        if (hasError) {
            updateComponentStatus('serializd', 'error', 'Failed to fetch any shows');
        } else {
            updateComponentStatus('serializd', 'ok', 'No shows found in lists');
        }
    }
}

export async function run() {
    const currentConfig = loadConfig();

    logger.info('Starting sync...');

    // Run movies and shows as completely separate parallel operations
    // Each uses its own queues, so they cannot interfere with each other
    await Promise.all([
        syncMoviesFromLists(
            currentConfig.letterboxd,
            currentConfig.radarr?.tags || []
        ),
        syncShowsFromLists(
            currentConfig.serializd,
            currentConfig.sonarr?.tags || []
        )
    ]);

    logger.info('Sync complete.');
}

export async function main() {
    startHealthServer(3000);
    startScheduledMonitoring();
    logger.info('Application started successfully.');
}

export { startScheduledMonitoring };

if (require.main === module) {
    main().catch((e) => logger.error(e));
}