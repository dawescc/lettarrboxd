import PQueue from 'p-queue';
import Bottleneck from 'bottleneck';
import Axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import logger from './logger';

/**
 * Movie List Queue
 * 
 * Controls concurrent processing of Letterboxd lists.
 * Each list fetch runs as a separate task in this queue.
 */
export const movieListQueue = new PQueue({ concurrency: 2 });

/**
 * Movie Item Queue
 * 
 * Controls concurrent processing of individual movies.
 * Used for scraping movie details, Radarr sync operations, and Plex movie label sync.
 */
export const movieItemQueue = new PQueue({ concurrency: 20 });

/**
 * TV List Queue
 * 
 * Controls concurrent processing of Serializd lists.
 * Completely separate from movie queues to prevent interference.
 */
export const tvListQueue = new PQueue({ concurrency: 2 });

/**
 * TV Item Queue
 * 
 * Controls concurrent processing of individual TV shows.
 * Used for scraping show details, Sonarr sync operations, and Plex show label sync.
 */
export const tvItemQueue = new PQueue({ concurrency: 20 });

/**
 * Letterboxd HTTP Rate Limiter
 * 
 * Limits requests to Letterboxd to avoid being blocked.
 * - maxConcurrent: 5 simultaneous requests
 * - minTime: 200ms between request starts
 */
export const letterboxdLimiter = new Bottleneck({
    maxConcurrent: 5,
    minTime: 200
});

/**
 * Radarr HTTP Rate Limiter
 * 
 * Limits requests to Radarr API.
 * - maxConcurrent: 3 simultaneous requests
 * - minTime: 100ms between request starts
 */
export const radarrLimiter = new Bottleneck({
    maxConcurrent: 3,
    minTime: 100
});

/**
 * Plex Movie HTTP Rate Limiter
 * 
 * Limits requests to Plex for movie-related operations.
 * Separate from TV to prevent movies blocking shows.
 */
export const plexMovieLimiter = new Bottleneck({
    maxConcurrent: 5,
    minTime: 100
});

/**
 * Serializd HTTP Rate Limiter
 * 
 * Limits requests to Serializd API.
 * - maxConcurrent: 5 simultaneous requests
 * - minTime: 200ms between request starts
 */
export const serializdLimiter = new Bottleneck({
    maxConcurrent: 5,
    minTime: 200
});

/**
 * Sonarr HTTP Rate Limiter
 * 
 * Limits requests to Sonarr API.
 * - maxConcurrent: 3 simultaneous requests
 * - minTime: 100ms between request starts
 */
export const sonarrLimiter = new Bottleneck({
    maxConcurrent: 3,
    minTime: 100
});

/**
 * Plex TV HTTP Rate Limiter
 * 
 * Limits requests to Plex for TV-related operations.
 * Separate from movies to prevent shows blocking movies.
 */
export const plexTvLimiter = new Bottleneck({
    maxConcurrent: 5,
    minTime: 100
});

// Error handlers to prevent silent failures
letterboxdLimiter.on('error', (err) => {
    logger.error('[Letterboxd Limiter] Unhandled error:', err);
});

radarrLimiter.on('error', (err) => {
    logger.error('[Radarr Limiter] Unhandled error:', err);
});

plexMovieLimiter.on('error', (err) => {
    logger.error('[Plex Movie Limiter] Unhandled error:', err);
});

serializdLimiter.on('error', (err) => {
    logger.error('[Serializd Limiter] Unhandled error:', err);
});

sonarrLimiter.on('error', (err) => {
    logger.error('[Sonarr Limiter] Unhandled error:', err);
});

plexTvLimiter.on('error', (err) => {
    logger.error('[Plex TV Limiter] Unhandled error:', err);
});

// Failed job handlers for debugging
letterboxdLimiter.on('failed', (err) => {
    logger.warn(`[Letterboxd] Job failed: ${err.message}`);
    return null;
});

radarrLimiter.on('failed', (err) => {
    logger.warn(`[Radarr] Job failed: ${err.message}`);
    return null;
});

plexMovieLimiter.on('failed', (err) => {
    logger.warn(`[Plex Movie] Job failed: ${err.message}`);
    return null;
});

serializdLimiter.on('failed', (err) => {
    logger.warn(`[Serializd] Job failed: ${err.message}`);
    return null;
});

sonarrLimiter.on('failed', (err) => {
    logger.warn(`[Sonarr] Job failed: ${err.message}`);
    return null;
});

plexTvLimiter.on('failed', (err) => {
    logger.warn(`[Plex TV] Job failed: ${err.message}`);
    return null;
});

type AxiosMethod = 'get' | 'post' | 'put' | 'delete';

interface RateLimitedAxios {
    get: <T = any>(url: string, config?: AxiosRequestConfig) => Promise<AxiosResponse<T>>;
    post: <T = any>(url: string, data?: any, config?: AxiosRequestConfig) => Promise<AxiosResponse<T>>;
    put: <T = any>(url: string, data?: any, config?: AxiosRequestConfig) => Promise<AxiosResponse<T>>;
    delete: <T = any>(url: string, config?: AxiosRequestConfig) => Promise<AxiosResponse<T>>;
}

/**
 * Creates a rate-limited axios instance.
 * 
 * All HTTP calls through this instance are queued through the provided
 * Bottleneck limiter, ensuring rate limits are respected.
 * 
 * @param baseAxios - The base axios instance with baseURL and headers configured
 * @param limiter - The Bottleneck limiter to use for rate limiting
 * @param serviceName - Name for logging purposes
 * @returns A rate-limited axios-like object
 */
export function createRateLimitedAxios(
    baseAxios: ReturnType<typeof Axios.create>,
    limiter: Bottleneck,
    serviceName: string
): RateLimitedAxios {
    return {
        get: <T = any>(url: string, config?: AxiosRequestConfig) => {
            logger.debug(`[${serviceName}] Scheduling GET ${url}`);
            return limiter.schedule(() => baseAxios.get<T>(url, config));
        },
        post: <T = any>(url: string, data?: any, config?: AxiosRequestConfig) => {
            logger.debug(`[${serviceName}] Scheduling POST ${url}`);
            return limiter.schedule(() => baseAxios.post<T>(url, data, config));
        },
        put: <T = any>(url: string, data?: any, config?: AxiosRequestConfig) => {
            logger.debug(`[${serviceName}] Scheduling PUT ${url}`);
            return limiter.schedule(() => baseAxios.put<T>(url, data, config));
        },
        delete: <T = any>(url: string, config?: AxiosRequestConfig) => {
            logger.debug(`[${serviceName}] Scheduling DELETE ${url}`);
            return limiter.schedule(() => baseAxios.delete<T>(url, config));
        },
    };
}

/**
 * Creates a rate-limited fetch function.
 * 
 * All fetch calls through this function are queued through the provided
 * Bottleneck limiter.
 * 
 * @param limiter - The Bottleneck limiter to use
 * @param serviceName - Name for logging purposes
 * @returns A rate-limited fetch function
 */
export function createRateLimitedFetch(limiter: Bottleneck, serviceName: string) {
    return (url: string, options?: RequestInit): Promise<Response> => {
        logger.debug(`[${serviceName}] Scheduling fetch ${url}`);
        return limiter.schedule(() => fetch(url, options));
    };
}

/**
 * Pre-configured rate-limited fetch for Letterboxd scraping.
 */
export const letterboxdFetch = createRateLimitedFetch(letterboxdLimiter, 'Letterboxd');

/**
 * Pre-configured rate-limited fetch for Serializd scraping.
 */
export const serializdFetch = createRateLimitedFetch(serializdLimiter, 'Serializd');
