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
import { DEFAULT_TAG_NAME as RADARR_DEFAULT_TAG } from './api/radarr';
import { DEFAULT_TAG_NAME as SONARR_DEFAULT_TAG } from './api/sonarr';

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
  run().finally(() => {
    setAppStatus('idle');
    scheduleNextRun();
  });
  
  logger.info(`Scheduled to run every ${env.CHECK_INTERVAL_MINUTES} minutes`);
}

function scheduleNextRun() {
  const intervalMs = env.CHECK_INTERVAL_MINUTES * 60 * 1000;
  setTimeout(() => {
    setAppStatus('syncing');
    run().finally(() => {
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
async function processLists<T extends ScrapedMedia>(
    lists: BaseListConfig[],
    componentName: string, // 'letterboxd' or 'serializd'
    fetchItemsFn: (list: BaseListConfig) => Promise<T[]>,
    syncItemsFn: (items: T[]) => Promise<void>,
    plexType: 'movie' | 'show',
    plexGlobalTags: string[]
) {
    if (lists.length === 0) {
        updateComponentStatus(componentName, 'disabled');
        return;
    }

    let hasError = false;
    const allItems = new Map<string, T>(); // TMDB ID -> Item

    logger.info(`Processing ${lists.length} ${componentName} lists...`);

    // Parallel processing with concurrency limit
    await Bluebird.map(lists, async (list) => {
        if (!isListActive(list)) {
            logger.info(`Skipping inactive list: ${list.id || list.url}`);
            return;
        }

        try {
            logger.info(`Fetching list: ${list.url} (Tags: ${list.tags.join(', ')})`);
            const items = await fetchItemsFn(list);

            for (const item of items) {
                if (!item.tmdbId) continue;

                // Merge Logic (Thread-safe within the Map context since JS is single threaded event loop)
                if (allItems.has(item.tmdbId)) {
                    const existing = allItems.get(item.tmdbId)!;
                    const existingTags = existing.tags || [];
                    const newTags = list.tags || [];
                    existing.tags = [...new Set([...existingTags, ...newTags])];
                    // If the new list has a quality profile, it overrides the existing one (last wins)
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
        }
    }, { concurrency: 5 });

    const uniqueItems = Array.from(allItems.values());

    if (uniqueItems.length > 0) {
        const targetComponent = componentName === 'letterboxd' ? 'radarr' : 'sonarr';
        updateComponentStatus(componentName, hasError ? 'error' : 'ok', `Found ${uniqueItems.length} unique items`);
        logger.info(`Total unique items found across all ${componentName} lists: ${uniqueItems.length}`);
        
        try {
            // Sync to Radarr/Sonarr
            await syncItemsFn(uniqueItems);
            updateComponentStatus(targetComponent, 'ok');
            
            // Sync Plex
            // We pass the component specific default tag (e.g. 'letterboxd') + any global tags from config
            const allPlexTags = [...plexGlobalTags, componentName === 'letterboxd' ? RADARR_DEFAULT_TAG : SONARR_DEFAULT_TAG];
            await plex.syncPlexTags(uniqueItems, allPlexTags, plexType);
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

    // 1. Process Letterboxd Lists
    await processLists<LetterboxdMovie>(
        currentConfig.letterboxd,
        'letterboxd',
        async (list) => {
            // Letterboxd Fetcher + Filter
            const movies = await fetchMoviesFromUrl(list.url, list.takeAmount, list.takeStrategy);
            
            // Apply Filters
            if (list.filters) {
                return movies.filter(movie => {
                    const { minRating, minYear, maxYear } = list.filters!;
                    
                    if (minRating !== undefined && (movie.rating === undefined || movie.rating === null || movie.rating < minRating)) return false;
                    if (minYear !== undefined && (movie.publishedYear === undefined || movie.publishedYear === null || movie.publishedYear < minYear)) return false;
                    if (maxYear !== undefined && (movie.publishedYear === undefined || movie.publishedYear === null || movie.publishedYear > maxYear)) return false;
                    
                    return true;
                });
            }
            return movies;
        },
        syncMovies,
        'movie',
        currentConfig.radarr?.tags || []
    );

    // 2. Process Serializd Lists
    await processLists<ScrapedSeries>(
        currentConfig.serializd,
        'serializd',
        async (list) => {
            // Serializd Fetcher
            const scraper = new SerializdScraper(list.url);
            return await scraper.getSeries();
        },
        syncSeries,
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