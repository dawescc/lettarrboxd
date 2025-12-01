require('dotenv').config();


import env from './util/env';
import logger from './util/logger';
import { fetchMoviesFromUrl } from './scraper';
import { upsertMovies } from './api/radarr';
import { SerializdScraper } from './scraper/serializd';
import { upsertSeries } from './api/sonarr';

function startScheduledMonitoring(): void {
  // Run immediately on startup
  run().finally(() => {
    scheduleNextRun();
  });
  
  logger.info(`Scheduled to run every ${env.CHECK_INTERVAL_MINUTES} minutes`);
}

function scheduleNextRun() {
  const intervalMs = env.CHECK_INTERVAL_MINUTES * 60 * 1000;
  setTimeout(() => {
    run().finally(() => {
      scheduleNextRun();
    });
  }, intervalMs);
}

async function run() {
  // Letterboxd -> Radarr
  if (env.LETTERBOXD_URL) {
    try {
      logger.info('Starting Letterboxd sync...');
      const movies = await fetchMoviesFromUrl(env.LETTERBOXD_URL);
      logger.info(`Found ${movies.length} movies in Letterboxd list`);
      await upsertMovies(movies);
    } catch (e) {
      logger.error('Error in Letterboxd sync:', e);
    }
  }

  // Serializd -> Sonarr
  if (env.SERIALIZD_URL) {
    try {
      logger.info('Starting Serializd sync...');
      const scraper = new SerializdScraper(env.SERIALIZD_URL);
      const series = await scraper.getSeries();
      logger.info(`Found ${series.length} series in Serializd watchlist`);
      await upsertSeries(series);
    } catch (e) {
      logger.error('Error in Serializd sync:', e);
    }
  }
}

export async function main() {
  startScheduledMonitoring();
  
  // Keep the process alive
  logger.info('Application started successfully. Monitoring for changes...');
}

export { startScheduledMonitoring };

if (require.main === module) {
  main().catch(logger.error);
}