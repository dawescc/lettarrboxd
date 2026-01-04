import * as cheerio from 'cheerio';
import Bluebird from 'bluebird';
import { LetterboxdMovie, LETTERBOXD_BASE_URL } from ".";
import { getMovie } from './movie';
import logger from '../util/logger';
import Scraper from './scraper.interface';
import { retryOperation } from '../util/retry';

export abstract class BaseScraper implements Scraper {
    constructor(
        protected url: string, 
        protected take?: number, 
        protected strategy?: 'oldest' | 'newest'
    ) {}

    // Abstract methods that must be implemented by subclasses
    protected abstract transformUrl(url: string): string;
    protected abstract getMovieLinksFromHtml(html: string): string[];
    protected abstract getNextPageUrl(html: string): string | null;

    // Default implementation can be overridden if needed
    protected verifyEmptyList(html: string): void {
        const $ = cheerio.load(html);
        const text = $.text();
        
        // Common phrases for empty lists on Letterboxd
        const emptyIndicators = [
            'There are no films in this list',
            'No films',
            'No entries',
            'Follow this list to receive updates', // Often appears on empty lists
            'Add films to this list'  // Owner view
        ];

        // We look for at least ONE indicator to consider it safely "empty"
        const isExplicitlyEmpty = emptyIndicators.some(indicator => text.includes(indicator));

        if (!isExplicitlyEmpty) {
            // Log the HTML snippet for debugging (truncate to avoid massive logs)
            const bodyPreview = $('body').text().substring(0, 500).replace(/\s+/g, ' ');
            throw new Error(`Scraper found 0 items but could not verify list is empty. Possible layout change. Body preview: ${bodyPreview}`);
        }
        
        logger.info('List is confirmed empty (found empty state text).');
    }

    async getMovies(): Promise<{ items: LetterboxdMovie[], hasErrors: boolean }> {
        // Transform user-facing URL to processable URL (e.g. AJAX endpoint or sort query)
        const processUrl = this.transformUrl(this.url);
        
        const allMovieLinks = await this.getAllMovieLinks(processUrl);
        const linksToProcess = typeof this.take === 'number' ? allMovieLinks.slice(0, this.take) : allMovieLinks;

        let hasErrors = false;

        const movies = await Bluebird.map(linksToProcess, async (link) => {
            try {
                return await getMovie(link);
            } catch (e: any) {
                logger.warn(`Failed to scrape movie ${link}: ${e.message}`);
                hasErrors = true;
                return null;
            }
        }, {
            concurrency: 10
        });
        
        const validMovies = movies.filter((m): m is LetterboxdMovie => m !== null);
        
        if (hasErrors) {
            logger.warn(`Scrape for ${this.url} had some failures. ${validMovies.length}/${linksToProcess.length} movies retrieved.`);
        }

        return { items: validMovies, hasErrors };
    }

    protected async getAllMovieLinks(baseUrl: string): Promise<string[]> {
        let currentUrl: string | null = baseUrl;
        const allLinks: string[] = [];
        let pageCount = 0;
        
        while (currentUrl) {
            pageCount++;
            logger.info(`Fetching page ${pageCount}: ${currentUrl}`);
            
            try {
                const html = await this.fetchPageWithRetry(currentUrl, pageCount);
                const pageLinks = this.getMovieLinksFromHtml(html);
                
                // SAFETY CHECK: If we found no links, we MUST verify the page is actually empty
                // otherwise it might be a layout change or scraper bug, which could lead to data loss.
                if (pageLinks.length === 0 && allLinks.length === 0) {
                    try {
                        this.verifyEmptyList(html);
                    } catch (e) {
                         // Rethrow immediately for critical safety failure
                         throw e;
                    }
                }

                allLinks.push(...pageLinks);
                
                if (this.take && allLinks.length >= this.take) {
                    logger.debug(`Reached take limit (${this.take}). Stopping pagination.`);
                    currentUrl = null;
                } else {
                    currentUrl = this.getNextPageUrl(html);
                    
                    if (currentUrl) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                }
            } catch (error: any) {
                throw error;
            }
        }
        
        logger.debug(`Retrieved ${allLinks.length} links from scraper.`);
        return allLinks;
    }

    protected async fetchPageWithRetry(url: string, pageCount: number): Promise<string> {
        return await retryOperation(async () => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000);
            
            try {
                const response = await fetch(url, { signal: controller.signal });
                clearTimeout(timeoutId);
                
                if (!response.ok) {
                    throw new Error(`Failed to fetch page: ${response.status}`);
                }
                
                return await response.text();
            } catch (e: any) {
                clearTimeout(timeoutId);
                if (e.name === 'AbortError') {
                    throw new Error(`Timeout fetching page: ${url}`);
                }
                throw e;
            }
        }, `fetch page ${pageCount}`);
    }
}
