import PQueue from 'p-queue';
import Bottleneck from 'bottleneck';
import Axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import logger from './logger';

// ============================================================================
// P-QUEUE: Job Concurrency Control
// ============================================================================

/**
 * Master Queue - Top level job orchestration
 * Controls parallel execution of major sync jobs (movies, shows)
 */
export const masterQueue = new PQueue({ concurrency: 2 });

/**
 * List Processing Queue
 * Limits how many lists are fetched/processed in parallel.
 */
export const listQueue = new PQueue({ concurrency: 2 });

/**
 * Item Processing Queue
 * Limits how many items (movies/shows) are processed concurrently system-wide.
 * Prevents memory bloat from thousands of pending promises.
 */
export const itemQueue = new PQueue({ concurrency: 20 });

// ============================================================================
// BOTTLENECK: HTTP Rate Limiting
// ============================================================================

/**
 * Radarr Rate Limiter
 * Max 3 concurrent requests, min 100ms between requests.
 */
export const radarrLimiter = new Bottleneck({
    maxConcurrent: 3,
    minTime: 100
});

/**
 * Sonarr Rate Limiter
 * Max 3 concurrent requests, min 100ms between requests.
 */
export const sonarrLimiter = new Bottleneck({
    maxConcurrent: 3,
    minTime: 100
});

/**
 * Scraper Rate Limiter
 * Min 200ms between requests (approx 5 req/sec).
 */
export const scraperLimiter = new Bottleneck({
    minTime: 200
});

/**
 * Plex Rate Limiter
 * Max 5 concurrent, min 100ms between.
 */
export const plexLimiter = new Bottleneck({
    maxConcurrent: 5,
    minTime: 100
});

// ============================================================================
// RATE-LIMITED AXIOS FACTORIES
// ============================================================================

type AxiosMethod = 'get' | 'post' | 'put' | 'delete';

interface RateLimitedAxios {
    get: <T = any>(url: string, config?: AxiosRequestConfig) => Promise<AxiosResponse<T>>;
    post: <T = any>(url: string, data?: any, config?: AxiosRequestConfig) => Promise<AxiosResponse<T>>;
    put: <T = any>(url: string, data?: any, config?: AxiosRequestConfig) => Promise<AxiosResponse<T>>;
    delete: <T = any>(url: string, config?: AxiosRequestConfig) => Promise<AxiosResponse<T>>;
}

/**
 * Creates a rate-limited axios instance using the provided limiter.
 * All HTTP calls through this instance will be queued through Bottleneck.
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
 * Creates a rate-limited fetch function for scrapers.
 * All fetch calls through this will be queued through Bottleneck.
 */
export function createRateLimitedFetch(limiter: Bottleneck, serviceName: string) {
    return (url: string, options?: RequestInit): Promise<Response> => {
        logger.debug(`[${serviceName}] Scheduling fetch ${url}`);
        return limiter.schedule(() => fetch(url, options));
    };
}

// Pre-configured for scrapers (used in movie.ts, scraper.base.ts)
export const rateLimitedFetch = createRateLimitedFetch(scraperLimiter, 'Scraper');
