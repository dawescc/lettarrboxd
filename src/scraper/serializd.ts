/**
 * Serializd scraper.
 * Fetches one or more lists from the Serializd API, resolves season IDs
 * to season numbers, deduplicates across lists, and returns a ScrapeResult.
 *
 * Supported URL formats:
 *   /user/{username}/watchlist          → personal watchlist (paginated)
 *   /user/{username}/lists/{slug}       → user's named list
 *   /list/{slug-with-numeric-id}        → public list (ID extracted from slug tail)
 *
 * Note: Serializd's `showId` is assumed to equal the TMDB series id — this
 * has held true historically and is how downstream Sonarr/Plex lookups work.
 */
import Axios from 'axios';
import { serializdLimiter, createRateLimitedAxios } from '../util/limiters';
import { retryOperation } from '../util/retry';
import { scrapeCache } from '../util/cache';
import { isListActive } from '../util/schedule';
import logger from '../util/logger';
import type { SerializdList } from '../util/config';
import type { MediaItem, ScrapeResult } from '../types';

const SERIALIZD_API = 'https://serializd.onrender.com';

const http = createRateLimitedAxios(
    Axios.create({
        headers: {
            'X-Requested-With': 'serializd_vercel',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        timeout: 30_000,
    }),
    serializdLimiter,
    'Serializd'
);

// ── Season resolution ─────────────────────────────────────────────────────────

async function resolveSeasons(showId: number, seasonIds: number[]): Promise<number[]> {
    if (!seasonIds.length) return [];

    const resolved: number[] = [];

    for (const sid of seasonIds) {
        const cached = scrapeCache.getSeason(sid);
        if (cached !== undefined) { resolved.push(cached); continue; }

        const cacheKey = `serializd_show_${showId}`;
        let details = scrapeCache.get<{ seasons: { id: number; seasonNumber: number }[] }>(cacheKey);

        if (!details) {
            try {
                const res = await http.get(`${SERIALIZD_API}/api/show/${showId}`);
                details = res.data;
                if (details) scrapeCache.set(cacheKey, details);
            } catch (e: any) {
                logger.error(`Failed to fetch show details for ${showId}: ${e.message}`);
                continue;
            }
        }

        const season = details?.seasons?.find(s => s.id === sid);
        if (season) {
            scrapeCache.setSeason(sid, season.seasonNumber);
            resolved.push(season.seasonNumber);
        }
    }

    return resolved;
}

// ── List fetching ─────────────────────────────────────────────────────────────

interface SerializdItem {
    showId: number;
    showName: string;
    seasonIds: number[];
}

/** Map a raw API show object (any response shape) to SerializdItem. */
function mapShow(s: any): SerializdItem | null {
    const showId = s.showId ?? s.show_id;
    if (!showId) return null;
    // seasonIds (array) for watchlists, seasonId (singular) for public list items
    const seasonIds = s.seasonIds ?? s.season_ids
        ?? (s.seasonId != null ? [s.seasonId] : []);
    return {
        showId,
        showName: s.showName ?? s.show_name ?? s.name ?? s.title ?? 'Unknown',
        seasonIds,
    };
}

/** Personal watchlist — paginated. */
async function fetchWatchlist(username: string): Promise<SerializdItem[]> {
    const base = `${SERIALIZD_API}/api/user/${username}/watchlistpage_v2`;
    const all: SerializdItem[] = [];
    let page = 1;
    let totalPages = 1;

    do {
        const res = await retryOperation(
            () => http.get<{ items: SerializdItem[]; totalPages: number }>(`${base}/${page}?sort_by=date_added_desc`),
            `fetch serializd watchlist page ${page}`
        );
        totalPages = res.data.totalPages;
        if (res.data.items) all.push(...res.data.items);
        page++;
        if (page <= totalPages) await new Promise(r => setTimeout(r, 500));
    } while (page <= totalPages);

    return all;
}

/** Public list URL: /list/{Name-With-NumericId}
 *  Extracts the numeric id from the slug tail and calls /api/list/{id}. */
async function fetchPublicList(slug: string): Promise<SerializdItem[]> {
    const idMatch = slug.match(/(\d+)$/);
    const listId = idMatch ? idMatch[1] : slug;

    const res = await retryOperation(
        () => http.get(`${SERIALIZD_API}/api/list/${listId}`),
        `fetch serializd public list ${listId}`
    );

    const data = res.data;
    const raw: any[] = Array.isArray(data)
        ? data
        : (data.listItems ?? data.shows ?? data.items ?? data.entries ?? []);

    return raw.map(mapShow).filter((s): s is SerializdItem => s !== null);
}

/** User's named list URL: /user/{username}/lists/{slug}
 *  Calls /api/user/{username}/list/{slug}. */
async function fetchUserList(username: string, slug: string): Promise<SerializdItem[]> {
    const res = await retryOperation(
        () => http.get(`${SERIALIZD_API}/api/user/${username}/list/${slug}`),
        `fetch serializd user list ${username}/${slug}`
    );

    const data = res.data;
    const raw: any[] = Array.isArray(data)
        ? data
        : (data.shows ?? data.items ?? data.entries ?? []);

    return raw.map(mapShow).filter((s): s is SerializdItem => s !== null);
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function scrape(lists: SerializdList[]): Promise<ScrapeResult> {
    const byTmdb = new Map<string, MediaItem>();
    const managedTags = new Set<string>();
    const unsafeTags = new Set<string>();
    let abortCleanup = false;

    await Promise.allSettled(lists.map(async (list) => {
        if (!isListActive(list)) {
            logger.info(`Skipping inactive list: ${list.id ?? list.url}`);
            return;
        }

        logger.info(`Fetching Serializd list: ${list.id ?? list.url}`);

        const watchlistMatch = list.url.match(/\/user\/([^/]+)\/watchlist/);
        const userListMatch  = list.url.match(/\/user\/([^/]+)\/lists\/([^/?]+)/);
        const publicListMatch = list.url.match(/\/list\/([^/?]+)/);

        if (!watchlistMatch && !userListMatch && !publicListMatch) {
            throw new Error(`Invalid Serializd URL: ${list.url}`);
        }

        let raw: SerializdItem[] = [];
        let listFailed = false;

        try {
            if (watchlistMatch) {
                raw = await fetchWatchlist(watchlistMatch[1]);
            } else if (userListMatch) {
                raw = await fetchUserList(userListMatch[1], userListMatch[2]);
            } else if (publicListMatch) {
                raw = await fetchPublicList(publicListMatch[1]);
            }
            logger.info(`Found ${raw.length} items in ${list.id ?? list.url}.`);
        } catch (e: any) {
            logger.error(`Failed to fetch Serializd list ${list.url}: ${e.message}`);
            listFailed = true;
        }

        // Resolve seasons for each show (concurrent per item, limited by serializdLimiter)
        const settled = await Promise.allSettled(raw.map(async (s) => {
            const seasons = await resolveSeasons(s.showId, s.seasonIds ?? []);
            return {
                tmdbId: s.showId.toString(),
                title: s.showName,
                slug: s.showName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
                seasons,
            } satisfies MediaItem;
        }));

        const items: MediaItem[] = [];
        for (let i = 0; i < settled.length; i++) {
            const r = settled[i];
            if (r.status === 'fulfilled') {
                items.push(r.value);
            } else {
                logger.warn(`Failed to process ${raw[i]?.showName}: ${r.reason?.message}`);
                listFailed = true;
            }
        }

        if (listFailed) {
            if (list.tags.length > 0) {
                list.tags.forEach(t => unsafeTags.add(t));
            } else {
                logger.error(`List ${list.url} failed with no tags — activating safety lock.`);
                abortCleanup = true;
            }
        }

        list.tags.forEach(t => managedTags.add(t));

        // Merge into dedup map
        for (const item of items) {
            const existing = byTmdb.get(item.tmdbId);
            if (existing) {
                existing.tags = [...new Set([...(existing.tags ?? []), ...list.tags])];
                if (list.qualityProfile) existing.qualityProfile = list.qualityProfile;
                if (item.seasons?.length) {
                    existing.seasons = [...new Set([...(existing.seasons ?? []), ...item.seasons])];
                }
            } else {
                byTmdb.set(item.tmdbId, {
                    ...item,
                    tags: [...list.tags],
                    ...(list.qualityProfile && { qualityProfile: list.qualityProfile }),
                });
            }
        }
    }));

    const items = [...byTmdb.values()];
    logger.info(`Total unique shows: ${items.length}`);
    return { items, managedTags, unsafeTags, abortCleanup };
}
