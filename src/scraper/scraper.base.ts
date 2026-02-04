import * as cheerio from 'cheerio';
import { movieItemQueue, letterboxdFetch } from '../util/queues';
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
    ) { }

    // Abstract methods that must be implemented by subclasses
    protected abstract transformUrl(url: string): string;
    protected abstract getMovieLinksFromHtml(html: string): string[];
    protected abstract getNextPageUrl(html: string): string | null;

    // Default implementation can be overridden if needed
    protected verifyEmptyList(html: string): void {
        const $ = cheerio.load(html);
        const text = $.text();

        const emptyIndicators = [
            'There are no films in this list',
            'No films',
            'No entries',
            'Follow this list to receive updates',
            'Add films to this list'
        ];

        const isExplicitlyEmpty = emptyIndicators.some(indicator => text.includes(indicator));

        if (!isExplicitlyEmpty) {
            const bodyPreview = $('body').text().substring(0, 500).replace(/\s+/g, ' ');
            throw new Error(`Scraper found 0 items but could not verify list is empty. Body preview: ${bodyPreview}`);
        }

        logger.info('List is confirmed empty.');
    }

    async getMovies(): Promise<{ items: LetterboxdMovie[], hasErrors: boolean }> {
        const processUrl = this.transformUrl(this.url);

        const allMovieLinks = await this.getAllMovieLinks(processUrl);
        const linksToProcess = typeof this.take === 'number' ? allMovieLinks.slice(0, this.take) : allMovieLinks;

        let hasErrors = false;

        logger.info(`Processing ${linksToProcess.length} movie links...`);

        // Use itemQueue for concurrency - HTTP calls already rate-limited via rateLimitedFetch
        const movies = await movieItemQueue.addAll(linksToProcess.map(link => {
            return async () => {
                try {
                    logger.debug(`Processing: ${link}`);
                    return await getMovie(link);
                } catch (e: any) {
                    logger.warn(`Failed to scrape ${link}: ${e.message}`);
                    hasErrors = true;
                    return null;
                }
            };
        }));

        const validMovies = movies.filter((m): m is LetterboxdMovie => m !== null);

        if (hasErrors) {
            logger.warn(`Scrape had failures. ${validMovies.length}/${linksToProcess.length} movies retrieved.`);
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

                if (pageLinks.length === 0 && allLinks.length === 0) {
                    try {
                        this.verifyEmptyList(html);
                    } catch (e) {
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
                // Use rate-limited fetch - automatically queued through Bottleneck
                const response = await letterboxdFetch(url, { signal: controller.signal });
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
