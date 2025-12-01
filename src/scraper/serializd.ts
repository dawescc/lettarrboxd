import puppeteer from 'puppeteer';
import logger from '../util/logger';
import { LetterboxdMovie } from './index';

export class SerializdScraper {
    constructor(private url: string) {}

    async getSeries(): Promise<LetterboxdMovie[]> {
        logger.info(`Scraping Serializd watchlist: ${this.url}`);
        
        let browser;
        try {
            browser = await puppeteer.launch({
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
            
            const page = await browser.newPage();
            
            // Block images and fonts to speed up loading
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                if (['image', 'font', 'stylesheet'].includes(req.resourceType())) {
                    req.abort();
                } else {
                    req.continue();
                }
            });

            await page.goto(this.url, { waitUntil: 'networkidle2' });

            // Wait for the watchlist items to load
            // Based on the HTML we saw, items link to /show/Name-ID
            await page.waitForSelector('a[href^="/show/"]', { timeout: 30000 });

            const series = await page.evaluate(() => {
                const items: any[] = [];
                // Select all links that look like show links
                const links = document.querySelectorAll('a[href^="/show/"]');
                
                links.forEach((link) => {
                    const href = link.getAttribute('href');
                    if (!href) return;

                    // Format: /show/Name-ID
                    // Example: /show/Barry-73107
                    const match = href.match(/\/show\/(.+)-(\d+)$/);
                    if (match) {
                        const name = match[1].replace(/-/g, ' ');
                        const tmdbId = match[2];
                        
                        // Avoid duplicates if multiple links point to same show
                        if (!items.find(i => i.tmdbId === tmdbId)) {
                            items.push({
                                id: parseInt(tmdbId), // Using TMDB ID as internal ID
                                name: name,
                                tmdbId: tmdbId,
                                slug: match[1]
                            });
                        }
                    }
                });
                return items;
            });

            logger.debug(`Found ${series.length} series in Serializd watchlist`);
            return series;

        } catch (error) {
            logger.error('Error scraping Serializd:', error);
            throw error;
        } finally {
            if (browser) {
                await browser.close();
            }
        }
    }
}
