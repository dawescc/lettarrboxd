import * as cheerio from 'cheerio';
import { LETTERBOXD_BASE_URL, LetterboxdMovie } from ".";
import logger from '../util/logger';
import env from '../util/env';
import { scrapeCache } from '../util/cache';

/**
 * Obtain details of a movie.
 * @param link - This is the 'data-film-link' property on the movie div in letterboxd.
 */
export async function getMovie(link: string): Promise<LetterboxdMovie> {
    const cacheKey = `letterboxd_movie_${link}`;
    const cached = scrapeCache.get<LetterboxdMovie>(cacheKey);
    if (cached) {
        logger.debug(`[CACHE HIT] Movie: ${link}`);
        return cached;
    }

    logger.debug(`Fetching movie page: ${link}`);
    const movieUrl = new URL(link, LETTERBOXD_BASE_URL).toString();
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
        const response = await fetch(movieUrl, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`Failed to fetch movie page: ${response.status} ${response.statusText}`);
        }
        
        const html = await response.text();
        const movie = extractMovieFromHtml(link, html);
        
        scrapeCache.set(cacheKey, movie);
        return movie;
    } catch (metric: unknown) {
        clearTimeout(timeoutId);
        const error = metric as Error;
        if (error.name === 'AbortError') {
            throw new Error(`Timeout fetching movie page: ${link}`);
        }
        throw error;
    }
}

function extractMovieFromHtml(slug: string, html: string): LetterboxdMovie {
    const $ = cheerio.load(html);
    
    // Improved extraction with better logging context if needed
    // but keep it simple as failing one field usually shouldn't kill the whole process 
    // unless it's critical like ID.
    
    const id = extractLetterboxdId($); // Critical
    const name = extractName($); // Critical
    const tmdbId = extractTmdbId($);
    const imdbId = extractImdbId($);
    const year = extractPublishedYear($);
    const rating = extractRating($);
    
    return {
        id,
        name,
        imdbId,
        tmdbId,
        publishedYear: year, // Now properly typed as number | null
        rating,
        slug
    };
}

function extractRating($: cheerio.CheerioAPI): number|null {
    // Try JSON-LD first (most reliable)
    try {
        const jsonLdScript = $('script[type="application/ld+json"]');
        if (jsonLdScript.length) {
            const data = JSON.parse(jsonLdScript.first().html() || '{}');
            if (data.aggregateRating && data.aggregateRating.ratingValue) {
                return parseFloat(data.aggregateRating.ratingValue);
            }
        }
    } catch (e: unknown) {
         logger.debug(`Failed to parse JSON-LD for rating: ${(e as Error).message}`);
    }

    // Fallback to meta tag (twitter:data2 = "3.5 out of 5")
    const metaRating = $('meta[name="twitter:data2"]').attr('content');
    if (metaRating) {
        const match = metaRating.match(/([\d.]+) out of 5/);
        if (match) {
            return parseFloat(match[1]);
        }
    }

    return null;
}

function extractName($: cheerio.CheerioAPI): string {
    return $('.primaryname').first().text().trim();
}

function extractTmdbId($: cheerio.CheerioAPI): string|null {
    const tmdbLink = $('a[data-track-action="TMDB"]').attr('href');
    if (!tmdbLink) {
        // Reduced log level to debug as this is common for TV shows
        logger.debug('Could not find TMDB link. This could happen if there is a TV show in the list.');
        return null;
    }
    
    const tmdbMatch = tmdbLink.match(/\/movie\/(\d+)/);
    if (!tmdbMatch) {
         logger.debug(`Could not extract TMDB ID from link: ${tmdbLink}`);
         return null;
    }
    
    return tmdbMatch[1];
}

function extractImdbId($: cheerio.CheerioAPI): string|null {
    const imdbLink = $('a[href*="imdb.com"]').attr('href');
    if (!imdbLink) {
        return null;
    }
    
    const imdbMatch = imdbLink.match(/\/title\/(tt\d+)/);
    if (!imdbMatch) {
        return null;
    }
    
    return imdbMatch[1];
}

function extractLetterboxdId($: cheerio.CheerioAPI): number {
    const filmId = $('.film-poster img').closest('[data-film-id]').attr('data-film-id');
    if (!filmId) {
        throw new Error('Could not find Letterboxd film ID');
    }
    
    return parseInt(filmId, 10);
}

function extractPublishedYear($: cheerio.CheerioAPI): number|null {
    const releaseDateLink = $('span.releasedate a').attr('href');
    if (releaseDateLink) {
        const yearMatch = releaseDateLink.match(/\/(\d{4})\//);
        if (yearMatch) {
            return parseInt(yearMatch[1], 10);
        }
    }
    
    return null;
}