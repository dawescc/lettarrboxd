
import * as cheerio from 'cheerio';
import { LETTERBOXD_BASE_URL } from ".";
import logger from '../util/logger';
import { BaseScraper } from './scraper.base';

export class PopularScraper extends BaseScraper {
    constructor(url: string, take?: number, strategy?: 'oldest' | 'newest') {
        super(url, take, strategy);
    }

    protected transformUrl(url: string): string {
        // Remove trailing slash for easier manipulation
        const cleanUrl = url.replace(/\/$/, '');

        // Transform /films/popular to /films/ajax/popular
        if (cleanUrl === 'https://letterboxd.com/films/popular') {
            return 'https://letterboxd.com/films/ajax/popular/';
        }

        // If already an AJAX URL, return as is
        if (cleanUrl.includes('/films/ajax/popular')) {
            return cleanUrl + '/';
        }

        throw new Error(`Unsupported popular movies URL format: ${url}`);
    }

    protected getMovieLinksFromHtml(html: string): string[] {
        const $ = cheerio.load(html);
        const links: string[] = [];

        $('.react-component[data-target-link]').each((_, element) => {
            const filmLink = $(element).attr('data-target-link');
            if (filmLink) {
                links.push(filmLink);
            }
        });
        logger.debug(`Found ${links.length} links.`);
        return links;
    }

    protected getNextPageUrl(html: string): string | null {
        const $ = cheerio.load(html);
        const nextLink = $('.paginate-nextprev .next').attr('href');

        if (nextLink) {
            return new URL(nextLink, LETTERBOXD_BASE_URL).toString();
        }

        return null;
    }
}
