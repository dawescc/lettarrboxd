/**
 * Plex label sync.
 * Indexes the Plex library by TMDB id, then for each item stamps the
 * appropriate labels. Runs after both arr syncs complete.
 */
import Axios from 'axios';
import { loadConfig } from './util/config';
import { plexLimiter, createRateLimitedAxios } from './util/limiters';
import { retryOperation, withTimeout } from './util/retry';
import { calculateNextTags } from './util/tagLogic';
import { scrapeCache } from './util/cache';
import logger from './util/logger';
import env from './util/env';
import type { MediaItem, ScrapeResult } from './types';

const ITEM_TIMEOUT_MS = 30_000;
const LIBRARY_TIMEOUT_MS = 45_000;

function createClient(url: string, token: string) {
    return createRateLimitedAxios(
        Axios.create({
            baseURL: url,
            headers: { 'X-Plex-Token': token, 'Accept': 'application/json' },
            timeout: 30_000,
        }),
        plexLimiter,
        'Plex'
    );
}

type PlexClient = ReturnType<typeof createClient>;

// ── Library index ─────────────────────────────────────────────────────────────

interface LibraryIndex {
    movies: Map<string, any>;  // tmdbId → metadata
    shows: Map<string, any>;   // tmdbId → metadata
    byTitle: Map<string, any[]>;
    fetchedAt: number;
}

let libraryCache: LibraryIndex | null = null;
const CACHE_TTL = 5 * 60 * 1000;

async function getLibrary(client: PlexClient): Promise<LibraryIndex> {
    if (libraryCache && Date.now() - libraryCache.fetchedAt < CACHE_TTL) {
        logger.debug('Using cached Plex library index.');
        return libraryCache;
    }

    logger.info('Indexing Plex library...');

    const movies = new Map<string, any>();
    const shows = new Map<string, any>();
    const byTitle = new Map<string, any[]>();

    try {
        const res = await withTimeout(
            client.get('/library/all', { params: { includeGuids: 1 } }),
            LIBRARY_TIMEOUT_MS,
            'Plex /library/all'
        );

        for (const item of res.data?.MediaContainer?.Metadata ?? []) {
            const titleKey = item.title?.toLowerCase();
            if (titleKey) {
                if (!byTitle.has(titleKey)) byTitle.set(titleKey, []);
                byTitle.get(titleKey)!.push(item);
            }

            for (const g of (item.Guid ?? [])) {
                const tmdbId = extractTmdbId(g.id);
                if (!tmdbId) continue;
                if (item.type === 'movie') movies.set(tmdbId, item);
                else if (item.type === 'show') shows.set(tmdbId, item);
            }
        }

        logger.info(`Plex index: ${movies.size} movies, ${shows.size} shows.`);
        libraryCache = { movies, shows, byTitle, fetchedAt: Date.now() };
    } catch (e: any) {
        logger.error(`Failed to index Plex library: ${e.message}`);
        return { movies, shows, byTitle, fetchedAt: 0 };
    }

    return libraryCache;
}

function extractTmdbId(guid: string): string | null {
    if (guid.startsWith('tmdb://')) return guid.slice(7);
    const m = guid.match(/themoviedb:\/\/(\d+)/) ?? guid.match(/tmdb\/(\d+)/);
    return m ? m[1] : null;
}

async function findRatingKey(client: PlexClient, item: MediaItem, type: 'movie' | 'show'): Promise<string | null> {
    const cacheKey = `plex_rk_${item.tmdbId}`;
    const cached = scrapeCache.get<string>(cacheKey);
    if (cached) return cached;

    const library = await getLibrary(client);
    const map = type === 'movie' ? library.movies : library.shows;
    const found = map.get(item.tmdbId);

    if (found) {
        scrapeCache.set(cacheKey, found.ratingKey);
        return found.ratingKey;
    }

    // Title fallback
    if (item.title) {
        for (const candidate of library.byTitle.get(item.title.toLowerCase()) ?? []) {
            if (type === 'movie' && candidate.type !== 'movie') continue;
            if (type === 'show' && candidate.type !== 'show') continue;
            const hasMatch = (candidate.Guid ?? []).some((g: any) => extractTmdbId(g.id) === item.tmdbId);
            if (hasMatch) {
                scrapeCache.set(cacheKey, candidate.ratingKey);
                return candidate.ratingKey;
            }
        }
    }

    return null;
}

// ── Label sync ────────────────────────────────────────────────────────────────

async function syncLabels(
    client: PlexClient,
    ratingKey: string,
    targetLabels: string[],
    managedTags: Set<string>,
    type: 'movie' | 'show'
): Promise<void> {
    await retryOperation(async () => {
        const res = await client.get(`/library/metadata/${ratingKey}`);
        const metadata = res.data?.MediaContainer?.Metadata?.[0];
        if (!metadata) throw new Error(`Item ${ratingKey} not found in Plex`);

        const existing = (metadata.Label ?? []).map((l: any) => l.tag);
        const final = calculateNextTags(existing, managedTags, targetLabels, true);

        const existingSet = new Set(existing.map((l: string) => l.toLowerCase()));
        const finalSet = new Set(final.map((l: string) => l.toLowerCase()));
        if (finalSet.size === existingSet.size && [...finalSet].every(l => existingSet.has(l))) {
            logger.debug(`Plex ${metadata.title} labels up to date.`);
            return;
        }

        if (env.DRY_RUN) {
            logger.info(`[DRY RUN] Would update Plex labels for ${metadata.title}: [${existing}] → [${final}]`);
            return;
        }

        const typeParam = type === 'movie' ? 'type=1' : 'type=2';
        const labelParams = final.map((l, i) => `label[${i}].tag.tag=${encodeURIComponent(l)}`).join('&');
        await client.put(`/library/metadata/${ratingKey}?${labelParams}&${typeParam}`, null);
        logger.info(`Updated Plex labels for ${metadata.title}`);
    }, `sync Plex labels for ${ratingKey}`, { attemptTimeoutMs: 20_000 });
}

async function syncItem(
    client: PlexClient,
    item: MediaItem,
    allTags: string[],
    managedTags: Set<string>,
    type: 'movie' | 'show'
): Promise<void> {
    if (!item.tmdbId || !allTags.length) return;

    const ratingKey = await findRatingKey(client, item, type);
    if (!ratingKey) return;

    if (type === 'show') {
        if (item.episodes?.length) {
            const keys = await findEpisodeKeys(client, ratingKey, item.episodes);
            for (const k of keys) await syncLabels(client, k, allTags, managedTags, type);
            if (keys.length) return;
        }
        if (item.seasons?.length) {
            const keys = await findSeasonKeys(client, ratingKey, item.seasons);
            for (const k of keys) await syncLabels(client, k, allTags, managedTags, type);
            if (keys.length) return;
        }
    }

    await syncLabels(client, ratingKey, allTags, managedTags, type);
}

async function findEpisodeKeys(client: PlexClient, seriesKey: string, episodes: { season: number; episode: number }[]): Promise<string[]> {
    try {
        const res = await client.get(`/library/metadata/${seriesKey}/allLeaves`);
        return (res.data?.MediaContainer?.Metadata ?? [])
            .filter((l: any) => episodes.some(ep => ep.season === l.parentIndex && ep.episode === l.index))
            .map((l: any) => l.ratingKey);
    } catch (e: any) {
        logger.error(`Failed to fetch episodes for ${seriesKey}: ${e.message}`);
        return [];
    }
}

async function findSeasonKeys(client: PlexClient, seriesKey: string, seasons: number[]): Promise<string[]> {
    try {
        const res = await client.get(`/library/metadata/${seriesKey}/children`);
        return (res.data?.MediaContainer?.Metadata ?? [])
            .filter((c: any) => seasons.includes(c.index))
            .map((c: any) => c.ratingKey);
    } catch (e: any) {
        logger.error(`Failed to fetch seasons for ${seriesKey}: ${e.message}`);
        return [];
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Kick off the library index fetch in the background. Call early so it's
 *  ready (or nearly ready) by the time syncTags runs. Safe to call multiple times. */
export function prefetchLibrary(): void {
    const config = loadConfig();
    if (!config.plex) return;
    const client = createClient(config.plex.url, config.plex.token);
    getLibrary(client).catch(e => logger.debug(`Plex library prefetch error: ${e.message}`));
}

export async function syncTags(
    items: MediaItem[],
    globalTags: string[],
    managedTags: Set<string>,
    type: 'movie' | 'show'
): Promise<void> {
    const config = loadConfig();
    if (!config.plex) return;

    const client = createClient(config.plex.url, config.plex.token);
    await getLibrary(client);

    logger.info(`Syncing Plex labels for ${items.length} ${type}s...`);

    const results = await Promise.allSettled(items.map(item =>
        withTimeout(
            syncItem(client, item, [...new Set([...(item.tags ?? []), ...globalTags])], managedTags, type),
            ITEM_TIMEOUT_MS,
            `Plex sync for ${item.title}`
        ).catch((e: any) => logger.error(`Failed Plex sync for ${item.title}: ${e.message}`))
    ));

    const failed = results.filter(r => r.status === 'rejected').length;
    if (failed) logger.warn(`${failed}/${items.length} Plex items failed.`);
    logger.info(`Plex label sync complete.`);
}
