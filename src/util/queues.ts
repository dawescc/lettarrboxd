import PQueue from 'p-queue';
import Bottleneck from 'bottleneck';

/**
 * List Processing Queue
 * Limits how many lists are fetched/processed in parallel.
 * Using P-Queue for task concurrency.
 * Limit: 2 concurrent lists.
 */
export const listQueue = new PQueue({ concurrency: 2 });

/**
 * Radarr Rate Limiter
 * Limits API requests to Radarr to prevent overload.
 * Using Bottleneck for rate limiting.
 * Limit: Max 3 concurrent requests, min 100ms between requests.
 */
export const radarrLimiter = new Bottleneck({
    maxConcurrent: 3,
    minTime: 100
});

/**
 * Sonarr Rate Limiter
 * Limits API requests to Sonarr to prevent overload.
 * Using Bottleneck for rate limiting.
 * Limit: Max 3 concurrent requests, min 100ms between requests.
 */
export const sonarrLimiter = new Bottleneck({
    maxConcurrent: 3,
    minTime: 100
});

/**
 * Scraper Rate Limiter
 * Limits requests to Letterboxd/Serializd (if needed).
 * Shared limiter for external scraping.
 * Limit: Max 5 concurrent, min 200ms between requests.
 */
export const scraperLimiter = new Bottleneck({
    maxConcurrent: 5,
    minTime: 200
});

/**
 * Plex Rate Limiter
 * Limits requests to Plex.
 * Limit: Max 5 concurrent.
 */
export const plexLimiter = new Bottleneck({
    maxConcurrent: 5,
    minTime: 100
});
