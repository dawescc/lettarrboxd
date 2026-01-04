import { ListScraper } from './list';
import logger from '../util/logger';

// Mock logger to suppress noise
jest.mock('../util/logger', () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
}));

// Mock retry operation to just execute directly for tests to be faster
jest.mock('../util/retry', () => ({
    retryOperation: async (op: any) => await op(),
}));

describe('ListScraper Safety Logic', () => {
    let scraper: ListScraper;
    
    beforeEach(() => {
        jest.clearAllMocks();
        scraper = new ListScraper('https://mock-list');
    });

    it('should THROW if 0 items found and NO empty list text is present (Silent Failure Protection)', async () => {
        global.fetch = jest.fn().mockImplementation((url) => {
            if (url === 'https://mock-list') {
                return Promise.resolve({
                    ok: true,
                    text: async () => `
                        <html>
                            <body>
                                <div class="some-random-new-layout">
                                    <!-- No recognized movie links here -->
                                </div>
                            </body>
                        </html>
                    `
                });
            }
            return Promise.reject(new Error('Unknown URL: ' + url));
        }) as any;

        await expect(scraper.getMovies()).rejects.toThrow(/Scraper found 0 items but could not verify list is empty/);
    });

    it('should SUCCEED (return empty items) if 0 items found BUT explicit empty text IS present', async () => {
        global.fetch = jest.fn().mockImplementation((url) => {
            if (url === 'https://mock-list') {
                return Promise.resolve({
                    ok: true,
                    text: async () => `
                        <html>
                            <body>
                                <div class="content">
                                    <p>There are no films in this list</p>
                                </div>
                            </body>
                        </html>
                    `
                });
            }
            return Promise.reject(new Error('Unknown URL: ' + url));
        }) as any;

        const result = await scraper.getMovies();
        expect(result.items).toHaveLength(0);
        expect(result.hasErrors).toBe(false);
    });

    it('should SUCCEED if items are found', async () => {
         global.fetch = jest.fn().mockImplementation((url) => {
            if (url === 'https://mock-list') {
                return Promise.resolve({
                    ok: true,
                    text: async () => `
                        <html>
                            <div class="poster-container">
                                <div data-target-link="/film/test-movie/"></div>
                            </div>
                        </html>
                    `
                });
            }
            if (url.includes('/film/test-movie/')) {
                 return Promise.resolve({
                    ok: true,
                    text: async () => `
                        <html>
                            <div class="film-poster" data-film-id="123">
                                <img src="poster.jpg" />
                            </div>
                            <h1 class="primaryname">Test Movie</h1>
                            <a href="/movie/550" data-track-action="TMDB">TMDB</a>
                        </html>`
                });
            }
            return Promise.reject(new Error('Unknown URL: ' + url));
        }) as any;

        const result = await scraper.getMovies();
        expect(result.items).toHaveLength(1);
        expect(result.items[0].name).toBe('Test Movie');
        expect(result.items[0].tmdbId).toBe('550');
    });
});
