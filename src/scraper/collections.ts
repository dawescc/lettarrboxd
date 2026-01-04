
import * as cheerio from 'cheerio';
import { LETTERBOXD_BASE_URL } from ".";
import logger from '../util/logger';
import { BaseScraper } from './scraper.base';

export class CollectionsScraper extends BaseScraper {
    constructor(url: string, take?: number, strategy?: 'oldest' | 'newest') {
        super(url, take, strategy);
    }

    protected transformUrl(url: string): string {
        // For oldest strategy, modify the original URL before transforming to AJAX
        let urlToTransform = url;

        if (this.strategy === 'oldest') {
            // Add sorting to the base URL before transforming
            // /films/in/collection/ -> /films/in/collection/by/release-earliest/
            urlToTransform = url.replace(/\/$/, '') + '/by/release-earliest/';
        }

        return this.transformToAjaxUrl(urlToTransform);
    }

    private transformToAjaxUrl(url: string): string {
        // Remove trailing slash for easier manipulation
        const cleanUrl = url.replace(/\/$/, '');

        // Transform /films/in/collection-name to /films/ajax/in/collection-name
        // Also handles URLs with sorting like /films/in/collection/by/release-earliest
        if (cleanUrl.includes('/films/in/')) {
            return cleanUrl.replace('/films/in/', '/films/ajax/in/') + '/';
        }

        // If already an AJAX URL, return as is
        if (cleanUrl.includes('/films/ajax/')) {
            return cleanUrl + '/';
        }

        throw new Error(`Unsupported collections URL format: ${url}`);
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

