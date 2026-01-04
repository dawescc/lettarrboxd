require('dotenv').config();

import Bluebird from 'bluebird';
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
  // Run immediately on startup
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
 * Generic function to process a collection of lists (Movies or Series)
 */
export async function processLists<T extends ScrapedMedia>(
    lists: BaseListConfig[],
    componentName: string, // 'letterboxd' or 'serializd'
    fetchItemsFn: (list: BaseListConfig) => Promise<{ items: T[], hasErrors: boolean }>,
    syncItemsFn: (items: T[], managedTags: Set<string>, unsafeTags: Set<string>, abortCleanup: boolean) => Promise<void>,
    plexType: 'movie' | 'show',
    plexGlobalTags: string[]
) {
    if (lists.length === 0) {
        updateComponentStatus(componentName, 'disabled');
        return;
    }

    // Collect managed tags (safely)
    // If a list fails to fetch, we MUST NOT include its tags in 'managedTags'.
    // Furthermore, if a tag is shared between a successful list and a failed list, 
    // we must treat it as "unsafe to delete" because we don't know the status of items in the failed list.
    const potentialManagedTags = new Set<string>();
    const unsafeTags = new Set<string>();

    let hasError = false;
    let abortCleanup = false; // Safety Lock

    const allItems = new Map<string, T>(); // TMDB ID -> Item

    logger.info(`Processing ${lists.length} ${componentName} lists...`);


    await Bluebird.map(lists, async (list) => {
        if (!isListActive(list)) {
            logger.info(`Skipping inactive list: ${list.id || list.url}`);
            return;
        }

        try {
            logger.info(`Fetching list: ${list.url} (Tags: ${list.tags.join(', ')})`);
            const { items, hasErrors: listHasErrors } = await fetchItemsFn(list);
            
            if (listHasErrors) {
                logger.warn(`List ${list.url} reported partial errors. Marking associated tags as UNSAFE to prevent data loss.`);
                if (list.tags && list.tags.length > 0) {
                    list.tags.forEach(t => unsafeTags.add(t));
                } else {
                    // CRITICAL: If a list fails and has NO tags, we cannot know which items are safe to remove.
                    // We must abort the entire cleanup process for this component to prevent data loss.
                    logger.error(`List ${list.url} failed and has NO tags. Activating SAFETY LOCK: Cleanup will be aborted.`);
                    abortCleanup = true;
                }
                hasError = true;
            }


            if (list.tags) list.tags.forEach(t => potentialManagedTags.add(t));

            for (const item of items) {
                if (!item.tmdbId) {
                    logger.warn(`Item '${item.name}' in list ${list.url} is missing a TMDB ID. Marking list tags as unsafe.`);
                    // Mark tags as UNSAFE to prevent deletion of existing items with these tags
                    if (list.tags && list.tags.length > 0) {
                        list.tags.forEach(t => unsafeTags.add(t));
                    } else {
                         // Same logic: If items are missing IDs and list has no tags, we can't trust the state.
                         logger.error(`List ${list.url} has items without IDs and NO tags. Activating SAFETY LOCK.`);
                         abortCleanup = true;
                    }
                    continue;
                }


                if (allItems.has(item.tmdbId)) {
                    const existing = allItems.get(item.tmdbId)!;
                    const existingTags = existing.tags || [];
                    const newTags = list.tags || [];
                    existing.tags = [...new Set([...existingTags, ...newTags])];
                    
                    // Priority: Last list wins for quality profile (simplified logic)
                    if (list.qualityProfile) {
                        existing.qualityProfile = list.qualityProfile;
                    }
                } else {
                    item.tags = [...(list.tags || [])];
                    if (list.qualityProfile) {
                        item.qualityProfile = list.qualityProfile;
                    }
                    allItems.set(item.tmdbId, item);
                }
            }
            logger.info(`Fetched ${items.length} items from list (${list.url}).`);
        } catch (e: any) {
            logger.error(`Error fetching list ${list.url}:`, e);
            hasError = true;

            if (list.tags && list.tags.length > 0) {
                list.tags.forEach(t => unsafeTags.add(t));
            } else {
                logger.error(`List ${list.url} failed entirely and has NO tags. Activating SAFETY LOCK.`);
                abortCleanup = true;
            }
        }
    }, { concurrency: 5 });

    // Calculate final safe-to-manage tags
    // managedTags = potentialManagedTags - unsafeTags
    const managedTags = new Set<string>();
    potentialManagedTags.forEach(t => {
        if (!unsafeTags.has(t)) {
            managedTags.add(t);
        } else {
            logger.warn(`Tag '${t}' is present in a list with failures or missing IDs. It will be preserved on all items to ensure safety.`);
        }
    });

    const uniqueItems = Array.from(allItems.values());

    if (uniqueItems.length > 0) {
        const targetComponent = componentName === 'letterboxd' ? 'radarr' : 'sonarr';
        updateComponentStatus(componentName, hasError ? 'error' : 'ok', `Found ${uniqueItems.length} unique items`);
        logger.info(`Total unique items found across all ${componentName} lists: ${uniqueItems.length}`);
        
        try {

            await syncItemsFn(uniqueItems, managedTags, unsafeTags, abortCleanup);
            updateComponentStatus(targetComponent, 'ok');
            

            const allPlexTags = [...plexGlobalTags, componentName === 'letterboxd' ? TAG_LETTERBOXD : TAG_SERIALIZD];
            
            // Collect Managed Tags for Plex (Global + List Specific)
            const plexManagedTags = new Set([...managedTags, ...allPlexTags]);
            
            await plex.syncPlexTags(uniqueItems, allPlexTags, plexManagedTags, plexType);
        } catch (e: any) {
            updateComponentStatus(targetComponent, 'error', e.message);
            throw e; 
        }
    } else {
        if (hasError) {
             updateComponentStatus(componentName, 'error', 'Failed to fetch any items');
        } else {
             updateComponentStatus(componentName, 'ok', 'No items found in lists');
        }
    }
}

export async function run() {
    // Reload config on every run to support dynamic updates (e.g. adding new lists)
    const currentConfig = loadConfig();


    await processLists<LetterboxdMovie>(
        currentConfig.letterboxd,
        'letterboxd',
        async (list) => {
            // Letterboxd Fetcher + Filter
            const { items: movies, hasErrors } = await fetchMoviesFromUrl(list.url, list.takeAmount, list.takeStrategy);
            
            // Apply Filters
            if (list.filters) {
                const initialCount = movies.length;
                const filteredMovies = movies.filter(movie => {
                    const { minRating, minYear, maxYear } = list.filters!;
                    
                    if (minRating !== undefined && (movie.rating === undefined || movie.rating === null || movie.rating < minRating)) return false;
                    if (minYear !== undefined && (movie.publishedYear === undefined || movie.publishedYear === null || movie.publishedYear < minYear)) return false;
                    if (maxYear !== undefined && (movie.publishedYear === undefined || movie.publishedYear === null || movie.publishedYear > maxYear)) return false;
                    
                    return true;
                });
                
                const excludedCount = initialCount - filteredMovies.length;
                if (excludedCount > 0) {
                    logger.info(`Filtered ${excludedCount} items from list ${list.url} based on configuration.`);
                }
                
                return { items: filteredMovies, hasErrors }; // Propagate errors even if filtering happened
            }
            return { items: movies, hasErrors };
        },
        (items, managedTags, unsafeTags, abortCleanup) => syncMovies(items, managedTags, unsafeTags, abortCleanup),
        'movie',
        currentConfig.radarr?.tags || []
    );


    await processLists<ScrapedSeries>(
        currentConfig.serializd,
        'serializd',
        async (list) => {
            // Serializd Fetcher
            const scraper = new SerializdScraper(list.url);
            return await scraper.getSeries();
        },
        (items, managedTags, unsafeTags, abortCleanup) => syncSeries(items, managedTags, unsafeTags, abortCleanup), 
        'show',
        currentConfig.sonarr?.tags || []
    );
  
  logger.info('Sync complete.');
}

export async function main() {
  // Start health check server
  startHealthServer(3000);

  startScheduledMonitoring();
  
  // Keep the process alive
  logger.info('Application started successfully. Monitoring for changes...');
}

export { startScheduledMonitoring };

if (require.main === module) {
  main().catch((e) => logger.error(e));
}