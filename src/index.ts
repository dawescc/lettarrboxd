require('dotenv').config();


import env from './util/env';
import logger from './util/logger';
import { fetchMoviesFromUrl } from './scraper';
import { syncMovies } from './api/radarr';
import { SerializdScraper } from './scraper/serializd';
import { syncSeries } from './api/sonarr';

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
  if (env.LETTERBOXD_URL) {
    try {
      logger.info('Starting Letterboxd sync...');
      const movies = await fetchMoviesFromUrl(env.LETTERBOXD_URL);
      updateComponentStatus('letterboxd', 'ok', `Found ${movies.length} movies`);
      logger.info(`Found ${movies.length} movies in Letterboxd list`);
      
      try {
        await syncMovies(movies);
        updateComponentStatus('radarr', 'ok');
      } catch (e: any) {
        updateComponentStatus('radarr', 'error', e.message);
        throw e; // Re-throw to be caught by outer catch
      }
    } catch (e) {
      logger.error('Error in Letterboxd sync:', e as any);
      updateComponentStatus('letterboxd', 'error', (e as any).message);
    }
  } else {
      updateComponentStatus('letterboxd', 'disabled');
      updateComponentStatus('radarr', 'disabled');
  }

  // Serializd -> Sonarr
  if (env.SERIALIZD_URL) {
    try {
      logger.info('Starting Serializd sync...');
      const scraper = new SerializdScraper(env.SERIALIZD_URL);
      const series = await scraper.getSeries();
      updateComponentStatus('serializd', 'ok', `Found ${series.length} series`);
      logger.info(`Found ${series.length} series in Serializd watchlist`);
      
      try {
        await syncSeries(series);
        updateComponentStatus('sonarr', 'ok');
      } catch (e: any) {
        updateComponentStatus('sonarr', 'error', e.message);
        throw e;
      }
    } catch (e) {
      logger.error('Error in Serializd sync:', e as any);
      updateComponentStatus('serializd', 'error', (e as any).message);
    }
  } else {
    updateComponentStatus('serializd', 'disabled');
    updateComponentStatus('sonarr', 'disabled');
  }
  
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