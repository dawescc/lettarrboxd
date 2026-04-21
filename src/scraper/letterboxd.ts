/**
 * Letterboxd scraper.
 * Fetches one or more lists, extracts TMDB IDs via per-movie page scrapes,
 * deduplicates across lists, and returns a ScrapeResult with safety state.
 */
import Axios from 'axios';
import * as cheerio from 'cheerio';
import JSON5 from 'json5';
import { letterboxdLimiter, createRateLimitedAxios } from '../util/limiters';
import { retryOperation } from '../util/retry';
import { scrapeCache } from '../util/cache';
import { isListActive } from '../util/schedule';
import logger from '../util/logger';
import env from '../util/env';
import type { LetterboxdList } from '../util/config';
import type { MediaItem, ScrapeResult } from '../types';

const BASE_URL = 'https://letterboxd.com';

const http = createRateLimitedAxios(
    Axios.create({
        baseURL: BASE_URL,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        responseType: 'text',
        timeout: 30_000,
    }),
    letterboxdLimiter,
    'Letterboxd'
);

// ── URL transforms ────────────────────────────────────────────────────────────

type Transform = (url: string, strategy?: string) => string;

function listTransform(url: string, strategy?: string): string {
    return strategy === 'oldest' ? url.replace(/\/$/, '') + '/by/date-earliest/' : url;
}

function collectionsTransform(url: string, strategy?: string): string {
    let u = strategy === 'oldest' ? url.replace(/\/$/, '') + '/by/release-earliest/' : url;
    const clean = u.replace(/\/$/, '');
    if (clean.includes('/films/in/')) return clean.replace('/films/in/', '/films/ajax/in/') + '/';
    if (clean.includes('/films/ajax/')) return clean + '/';
    throw new Error(`Unsupported collections URL: ${url}`);
}

function popularTransform(url: string): string {
    const clean = url.replace(/\/$/, '');
    if (clean.endsWith('/films/popular')) return `${BASE_URL}/films/ajax/popular/`;
    if (clean.includes('/films/ajax/popular')) return clean + '/';
    throw new Error(`Unsupported popular URL: ${url}`);
}

const PATTERNS: [RegExp, Transform][] = [
    [/^https:\/\/letterboxd\.com\/[^/]+\/watchlist\/?$/,                listTransform],
    [/^https:\/\/letterboxd\.com\/[^/]+\/list\/[^/]+\/?$/,              listTransform],
    [/^https:\/\/letterboxd\.com\/[^/]+\/films\/?$/,                    listTransform],
    [/^https:\/\/letterboxd\.com\/actor\/[^/]+\/?$/,                    listTransform],
    [/^https:\/\/letterboxd\.com\/director\/[^/]+\/?$/,                 listTransform],
    [/^https:\/\/letterboxd\.com\/writer\/[^/]+\/?$/,                   listTransform],
    [/^https:\/\/letterboxd\.com\/films\/in\/[^/]+\/?$/,                collectionsTransform],
    [/^https:\/\/letterboxd\.com\/films\/popular\/?$/,                  popularTransform],
];

function getTransform(url: string): Transform {
    for (const [pattern, fn] of PATTERNS) {
        if (pattern.test(url)) return fn;
    }
    throw new Error(`Unsupported Letterboxd URL: ${url}`);
}

// ── Page fetching ─────────────────────────────────────────────────────────────

async function fetchPage(url: string, attempt = 1): Promise<string> {
    return retryOperation(async () => {
        const res = await http.get(url);
        return res.data as string;
    }, `fetch page ${attempt} (${url})`);
}

function extractLinks(html: string): string[] {
    const $ = cheerio.load(html);
    const links: string[] = [];

    $('.react-component[data-target-link]').each((_, el) => {
        const link = $(el).attr('data-target-link');
        if (link) links.push(link);
    });

    if (!links.length) {
        $('.poster-container div[data-target-link], .posteritem div[data-target-link]').each((_, el) => {
            const link = $(el).attr('data-target-link');
            if (link) links.push(link);
        });
    }

    return links;
}

function nextPageUrl(html: string): string | null {
    const $ = cheerio.load(html);
    const href = $('.paginate-nextprev .next').attr('href');
    return href ? new URL(href, BASE_URL).toString() : null;
}

function assertNotEmpty(html: string): void {
    const $ = cheerio.load(html);
    const text = $.text();
    const EMPTY = [
        'There are no films in this list', 'No films', 'No entries',
        'Follow this list to receive updates', 'Add films to this list',
    ];
    if (EMPTY.some(s => text.includes(s))) {
        logger.info('List confirmed empty.');
        return;
    }
    const preview = $('body').text().slice(0, 300).replace(/\s+/g, ' ');
    throw new Error(`0 links found but list not confirmed empty. Preview: ${preview}`);
}

async function getAllLinks(startUrl: string, limit?: number): Promise<string[]> {
    let url: string | null = startUrl;
    const links: string[] = [];
    let page = 0;

    while (url) {
        page++;
        logger.info(`Fetching page ${page}: ${url}`);
        const html = await fetchPage(url, page);
        const found = extractLinks(html);
        if (found.length === 0 && links.length === 0) assertNotEmpty(html);
        links.push(...found);
        if (limit && links.length >= limit) break;
        url = nextPageUrl(html);
        if (url) await new Promise(r => setTimeout(r, 1000));
    }

    return links;
}

// ── Movie detail extraction ───────────────────────────────────────────────────

async function fetchMovieDetails(link: string): Promise<MediaItem> {
    const cacheKey = `lbd_movie_${link}`;
    const cached = scrapeCache.get<MediaItem>(cacheKey);
    if (cached) {
        logger.debug(`[CACHE HIT] ${link}`);
        return cached;
    }

    logger.debug(`Fetching movie: ${link}`);
    const url = new URL(link, BASE_URL).toString();

    const res = await http.get(url);
    const html = res.data as string;

    const $ = cheerio.load(html);

    const title = $('.primaryname').first().text().trim();

    const tmdbHref = $('a[data-track-action="TMDB"]').attr('href') ?? '';
    const tmdbMatch = tmdbHref.match(/\/movie\/(\d+)/);
    if (!tmdbMatch) throw new Error(`No TMDB id on page: ${link}`);
    const tmdbId = tmdbMatch[1];

    const imdbHref = $('a[href*="imdb.com"]').attr('href') ?? '';
    const imdbMatch = imdbHref.match(/\/title\/(tt\d+)/);

    let rating: number | undefined;
    try {
        const ld = JSON5.parse($('script[type="application/ld+json"]').first().html() ?? '{}');
        if (ld.aggregateRating?.ratingValue) rating = parseFloat(ld.aggregateRating.ratingValue);
    } catch { /* no rating */ }

    let publishedYear: number | undefined;
    const yearHref = $('span.releasedate a').attr('href') ?? '';
    const yearMatch = yearHref.match(/\/(\d{4})\//);
    if (yearMatch) publishedYear = parseInt(yearMatch[1]);

    const item: MediaItem = {
        tmdbId,
        title,
        slug: link,
        ...(imdbMatch && { imdbId: imdbMatch[1] }),
        ...(publishedYear !== undefined && { publishedYear }),
        ...(rating !== undefined && { rating }),
    };

    scrapeCache.set(cacheKey, item);
    return item;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function scrape(lists: LetterboxdList[]): Promise<ScrapeResult> {
    const byTmdb = new Map<string, MediaItem>();
    const managedTags = new Set<string>();
    const unsafeTags = new Set<string>();
    let abortCleanup = false;

    await Promise.allSettled(lists.map(async (list) => {
        if (!isListActive(list)) {
            logger.info(`Skipping inactive list: ${list.id ?? list.url}`);
            return;
        }

        logger.info(`Fetching Letterboxd list: ${list.id ?? list.url}`);

        let items: MediaItem[] = [];
        let listFailed = false;

        try {
            const transform = getTransform(list.url);
            const strategy = list.takeStrategy ?? env.LETTERBOXD_TAKE_STRATEGY;
            const limit = list.takeAmount ?? env.LETTERBOXD_TAKE_AMOUNT;
            const startUrl = transform(list.url, strategy);

            const allLinks = await getAllLinks(startUrl, limit);
            const links = limit ? allLinks.slice(0, limit) : allLinks;
            logger.info(`Processing ${links.length} movies from ${list.id ?? list.url}...`);

            const settled = await Promise.allSettled(links.map(link => fetchMovieDetails(link)));
            for (let i = 0; i < settled.length; i++) {
                const r = settled[i];
                if (r.status === 'fulfilled') {
                    items.push(r.value);
                } else {
                    logger.warn(`Failed to scrape ${links[i]}: ${r.reason?.message}`);
                    listFailed = true;
                }
            }
        } catch (e: any) {
            logger.error(`Failed to fetch list ${list.url}: ${e.message}`);
            listFailed = true;
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

        // Apply filters
        if (list.filters) {
            const { minRating, minYear, maxYear } = list.filters;
            const before = items.length;
            items = items.filter(m => {
                if (minRating !== undefined && (m.rating == null || m.rating < minRating)) return false;
                if (minYear !== undefined && (m.publishedYear == null || m.publishedYear < minYear)) return false;
                if (maxYear !== undefined && (m.publishedYear == null || m.publishedYear > maxYear)) return false;
                return true;
            });
            if (items.length < before) logger.info(`Filtered ${before - items.length} movies from ${list.id ?? list.url}.`);
        }

        // Merge into dedup map
        for (const item of items) {
            const existing = byTmdb.get(item.tmdbId);
            if (existing) {
                existing.tags = [...new Set([...(existing.tags ?? []), ...list.tags])];
                if (list.qualityProfile) existing.qualityProfile = list.qualityProfile;
            } else {
                byTmdb.set(item.tmdbId, {
                    ...item,
                    tags: [...list.tags],
                    ...(list.qualityProfile && { qualityProfile: list.qualityProfile }),
                });
            }
        }

        logger.info(`Got ${items.length} movies from ${list.id ?? list.url}.`);
    }));

    const items = [...byTmdb.values()];
    logger.info(`Total unique movies: ${items.length}`);
    return { items, managedTags, unsafeTags, abortCleanup };
}
