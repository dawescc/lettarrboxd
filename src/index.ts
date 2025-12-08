require('dotenv').config();


import env from './util/env';
import config from './util/config';
import logger from './util/logger';
import { isListActive } from './util/schedule';
import { fetchMoviesFromUrl } from './scraper';
import { syncMovies } from './api/radarr';
import { SerializdScraper } from './scraper/serializd';
import { syncSeries } from './api/sonarr';
import * as plex from './api/plex';

import { startHealthServer, setAppStatus, updateComponentStatus } from './api/health';

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

async function run() {
  // Letterboxd -> Radarr
  // Letterboxd -> Radarr
  if (config.letterboxd.length > 0) {
    let hasError = false;
    const allMovies = new Map<string, any>(); // TMDB ID -> Movie

    logger.info(`Processing ${config.letterboxd.length} Letterboxd lists...`);

    for (const list of config.letterboxd) {
      if (!isListActive(list)) {
        logger.info(`Skipping inactive list: ${list.id || list.url}`);
        continue;
      }

      try {
        logger.info(`Fetching list: ${list.url} (Tags: ${list.tags.join(', ')})`);
        const movies = await fetchMoviesFromUrl(list.url, list.takeAmount, list.takeStrategy);
        
        for (const movie of movies) {
          // Client-side filtering
          if (list.filters) {
              const { minRating, minYear, maxYear } = list.filters;
              
              if (minRating !== undefined) {
                  // If movie has no rating, we exclude it if a minRating is requested (strict)
                  if (movie.rating === undefined || movie.rating === null || movie.rating < minRating) {
                      continue;
                  }
              }

              if (minYear !== undefined) {
                  if (movie.publishedYear === undefined || movie.publishedYear === null || movie.publishedYear < minYear) {
                      continue;
                  }
              }

              if (maxYear !== undefined) {
                  if (movie.publishedYear === undefined || movie.publishedYear === null || movie.publishedYear > maxYear) {
                      continue;
                  }
              }
          }

          if (!movie.tmdbId) continue;

          // Merge Logic
          if (allMovies.has(movie.tmdbId)) {
            const existing = allMovies.get(movie.tmdbId);
            const existingTags = existing.tags || [];
            const newTags = list.tags || [];
            existing.tags = [...new Set([...existingTags, ...newTags])];
          } else {
            movie.tags = [...(list.tags || [])];
            allMovies.set(movie.tmdbId, movie);
          }
        }
        logger.info(`Fetched ${movies.length} movies from list.`);
      } catch (e: any) {
        logger.error(`Error fetching list ${list.url}:`, e);
        hasError = true;
      }
    }

    const uniqueMovies = Array.from(allMovies.values());

    if (uniqueMovies.length > 0) {
        updateComponentStatus('letterboxd', hasError ? 'error' : 'ok', `Found ${uniqueMovies.length} unique movies`);
        logger.info(`Total unique movies found across all lists: ${uniqueMovies.length}`);
        
        try {
            await syncMovies(uniqueMovies);
            updateComponentStatus('radarr', 'ok');
            
            // Sync Plex
            await syncPlexMetadata(uniqueMovies);
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
  } else {
      updateComponentStatus('letterboxd', 'disabled');
      updateComponentStatus('radarr', 'disabled');
  }

  // Serializd -> Sonarr
  if (config.serializd.length > 0) {
    let hasError = false;
    const allSeries = new Map<string, any>(); // TMDB ID -> Series

    logger.info(`Processing ${config.serializd.length} Serializd lists...`);

    for (const list of config.serializd) {
      if (!isListActive(list)) {
        logger.info(`Skipping inactive Serializd list: ${list.id || list.url}`);
        continue;
      }
      try {
        logger.info(`Fetching Serializd list: ${list.url} (Tags: ${list.tags.join(', ')})`);
        const scraper = new SerializdScraper(list.url);
        const series = await scraper.getSeries();
        
        for (const item of series) {
          if (!item.tmdbId) continue;

          // Merge Logic
          if (allSeries.has(item.tmdbId)) {
            const existing = allSeries.get(item.tmdbId);
            const existingTags = existing.tags || [];
            const newTags = list.tags || [];
            existing.tags = [...new Set([...existingTags, ...newTags])];
          } else {
            item.tags = [...(list.tags || [])];
            allSeries.set(item.tmdbId, item);
          }
        }
        logger.info(`Fetched ${series.length} series from list.`);
      } catch (e: any) {
        logger.error(`Error fetching Serializd list ${list.url}:`, e);
        hasError = true;
      }
    }

    const uniqueSeries = Array.from(allSeries.values());

    if (uniqueSeries.length > 0) {
        updateComponentStatus('serializd', hasError ? 'error' : 'ok', `Found ${uniqueSeries.length} unique series`);
        logger.info(`Total unique series found across all lists: ${uniqueSeries.length}`);
        
        try {
            await syncSeries(uniqueSeries);
            updateComponentStatus('sonarr', 'ok');

            // Sync Plex
            await syncPlexMetadata(uniqueSeries);
        } catch (e: any) {
            updateComponentStatus('sonarr', 'error', e.message);
            throw e; 
        }
    } else {
        if (hasError) {
             updateComponentStatus('serializd', 'error', 'Failed to fetch any series');
        } else {
             updateComponentStatus('serializd', 'ok', 'No series found in lists');
        }
    }
  } else {
    updateComponentStatus('serializd', 'disabled');
    updateComponentStatus('sonarr', 'disabled');
  }
  
  logger.info('Sync complete.');
}

async function syncPlexMetadata(items: any[]) {
  if (!config.plex) return;
  
  logger.info(`Syncing Plex metadata for ${items.length} items...`);
  
  for (const item of items) {
      if (!item.tmdbId) continue;
      
      const itemTags = item.tags || [];
      const globalPlexTags = config.plex.tags || [];
      const allTags = [...new Set([...itemTags, ...globalPlexTags])];
      
      if (allTags.length === 0) continue;
      
      // We don't want to spam logs if not found, debug inside findItemByTmdbId handles it
      const ratingKey = await plex.findItemByTmdbId(item.tmdbId);
      if (ratingKey) {
          for (const tag of allTags) {
              await plex.addLabel(ratingKey, tag);
          }
      }
  }
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