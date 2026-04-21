import Bottleneck from 'bottleneck';
import Axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import logger from './logger';

export const letterboxdLimiter = new Bottleneck({ maxConcurrent: 1, minTime: 1500 });
export const serializdLimiter = new Bottleneck({ maxConcurrent: 1, minTime: 500 });
export const radarrLimiter = new Bottleneck({ maxConcurrent: 3, minTime: 100 });
export const sonarrLimiter = new Bottleneck({ maxConcurrent: 3, minTime: 100 });
export const plexLimiter = new Bottleneck({ maxConcurrent: 5, minTime: 100 });

const limiters: Record<string, Bottleneck> = {
    Letterboxd: letterboxdLimiter,
    Serializd: serializdLimiter,
    Radarr: radarrLimiter,
    Sonarr: sonarrLimiter,
    Plex: plexLimiter
};

for (const [name, limiter] of Object.entries(limiters)) {
    limiter.on('error', (err) => logger.error(`[${name} Limiter] Unhandled error:`, err));
    limiter.on('failed', (err) => {
        logger.warn(`[${name}] Job failed: ${err.message}`);
        return null;
    });
}

interface RateLimitedAxios {
    get: <T = any>(url: string, config?: AxiosRequestConfig) => Promise<AxiosResponse<T>>;
    post: <T = any>(url: string, data?: any, config?: AxiosRequestConfig) => Promise<AxiosResponse<T>>;
    put: <T = any>(url: string, data?: any, config?: AxiosRequestConfig) => Promise<AxiosResponse<T>>;
    delete: <T = any>(url: string, config?: AxiosRequestConfig) => Promise<AxiosResponse<T>>;
}

export function createRateLimitedAxios(
    baseAxios: ReturnType<typeof Axios.create>,
    limiter: Bottleneck,
    serviceName: string,
    timeoutMs = 30_000
): RateLimitedAxios {
    function schedule<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
        return limiter.schedule(() => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            return fn(controller.signal).finally(() => clearTimeout(timer));
        });
    }

    return {
        get: (url, config) => {
            logger.debug(`[${serviceName}] Scheduling GET ${url}`);
            return schedule(signal => baseAxios.get(url, { ...config, signal }));
        },
        post: (url, data, config) => {
            logger.debug(`[${serviceName}] Scheduling POST ${url}`);
            return schedule(signal => baseAxios.post(url, data, { ...config, signal }));
        },
        put: (url, data, config) => {
            logger.debug(`[${serviceName}] Scheduling PUT ${url}`);
            return schedule(signal => baseAxios.put(url, data, { ...config, signal }));
        },
        delete: (url, config) => {
            logger.debug(`[${serviceName}] Scheduling DELETE ${url}`);
            return schedule(signal => baseAxios.delete(url, { ...config, signal }));
        },
    };
}

