
import * as cheerio from 'cheerio';
import { LETTERBOXD_BASE_URL } from ".";
import logger from '../util/logger';
import { BaseScraper } from './scraper.base';

export class ListScraper extends BaseScraper {
    constructor(url: string, take?: number, strategy?: 'oldest' | 'newest') {
        super(url, take, strategy);
    }

    protected transformUrl(url: string): string {
        if (this.strategy === 'oldest') {
            return url.replace(/\/$/, '') + '/by/date-earliest/';
        }
        return url;
    }

    protected getMovieLinksFromHtml(html: string): string[] {
        const $ = cheerio.load(html);
        const links: string[] = [];
        
        // React Component (Modern Lists)
        $('.react-component[data-target-link]').each((_, element) => {
            const filmLink = $(element).attr('data-target-link');
            if (filmLink) links.push(filmLink);
        });

        // Poster Container (Classic/Fallback)
        if (links.length === 0) {
            $('.poster-container div[data-target-link]').each((_, element) => {
                const filmLink = $(element).attr('data-target-link');
                if (filmLink) links.push(filmLink);
            });
        }
        
        // Direct Poster Item
        if (links.length === 0) {
            $('.posteritem div[data-target-link]').each((_, element) => {
                const filmLink = $(element).attr('data-target-link');
                if (filmLink) links.push(filmLink);
            });
        }

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