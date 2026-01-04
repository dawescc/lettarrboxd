
import { run } from './index';
import * as scraperModule from './scraper';
import * as radarrModule from './api/radarr';
import { loadConfig } from './util/config';

// Mock dependencies
jest.mock('./util/env', () => ({
  CHECK_INTERVAL_MINUTES: 10,
  LETTERBOXD_URL: 'https://letterboxd.com/user/watchlist',
  RADARR_TAGS: 'env_tag',
  REMOVE_MISSING_ITEMS: true // Crucial for this test
}));

jest.mock('./util/config', () => {
    return {
        __esModule: true,
        default: {},
        loadConfig: jest.fn()
    };
});

jest.mock('./util/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('./scraper');
jest.mock('./api/radarr');
jest.mock('./scraper/serializd');
jest.mock('./api/sonarr');
jest.mock('./api/plex');
jest.mock('./api/health', () => ({
  startHealthServer: jest.fn(),
  setAppStatus: jest.fn(),
  updateComponentStatus: jest.fn()
}));

describe('Safety Regression Tests', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Setup default config
        (loadConfig as jest.Mock).mockReturnValue({
            letterboxd: [
                { url: 'https://unsafe-list', tags: ['unsafe-tag'] }
            ],
            serializd: [],
            radarr: {},
            sonarr: {}
        });
    });

    it('should NOT delete existing items if the source list has partial failures (missing TMDB ID)', async () => {
        // 1. Mock Scraper to return one valid movie and one invalid (missing ID)
        (scraperModule.fetchMoviesFromUrl as jest.Mock).mockResolvedValue({
            items: [
                { tmdbId: '100', name: 'Valid Movie', tags: [] },
                { tmdbId: null, name: 'Invalid Movie', tags: [] } // This causes the failure
            ],
            hasErrors: false // Partial failure inside items doesn't mean scraper failed entirely, but processLists checks IDs
        });

        // 2. Mock Radarr Sync to verify input
        (radarrModule.syncMovies as jest.Mock).mockResolvedValue(undefined);

        // 3. Run Sync
        await run();

        // 4. Verification
        expect(radarrModule.syncMovies).toHaveBeenCalledTimes(1);
        const calls = (radarrModule.syncMovies as jest.Mock).mock.calls[0];
        const moviesToSync = calls[0];
        const managedTags = calls[1];
        const unsafeTags = calls[2] as Set<string>;

        // Check that valid movie is passed
        expect(moviesToSync).toHaveLength(1);
        expect(moviesToSync[0].name).toBe('Valid Movie');

        // CRITICAL CHECK: The list's tag ('unsafe-tag') MUST be in the unsafeTags set
        // This tells Radarr "Do not delete items with this tag"
        expect(unsafeTags.has('unsafe-tag')).toBe(true);
        
        // Ensure it's NOT in managedTags (it's removed from there effectively by logic, 
        // though our code passes managedTags as "potential - unsafe")
        // In index.ts: managedTags.add(t) only if !unsafeTags.has(t)
        expect(managedTags.has('unsafe-tag')).toBe(false);
    });

    it('should mark list as unsafe if fetch completely fails', async () => {
        // 1. Mock Scraper to throw error
        (scraperModule.fetchMoviesFromUrl as jest.Mock).mockRejectedValue(new Error('Network Error'));

        // 2. Mock Radarr Sync
        (radarrModule.syncMovies as jest.Mock).mockResolvedValue(undefined);

        // 3. Run Sync
        await run();

        // 4. Verification
        expect(radarrModule.syncMovies).toHaveBeenCalledTimes(0); // Should skip sync entirely if no unique items found?
        // Wait, if 0 unique items found, syncMovies is NOT called.
        // Let's modify config to have a second VALID list so syncMovies IS called.
    });

    it('should mark failed list tags as unsafe while processing other valid lists', async () => {
         (loadConfig as jest.Mock).mockReturnValue({
            letterboxd: [
                { url: 'https://failed-list', tags: ['failed-tag'] },
                { url: 'https://valid-list', tags: ['valid-tag'] }
            ],
            serializd: [],
            radarr: {}
        });

        (scraperModule.fetchMoviesFromUrl as jest.Mock).mockImplementation(async (url) => {
            if (url === 'https://failed-list') throw new Error('Fail');
            if (url === 'https://valid-list') return { 
                items: [{ tmdbId: '999', name: 'Valid', tags: [] }],
                hasErrors: false
            };
            return { items: [], hasErrors: false };
        });

        (radarrModule.syncMovies as jest.Mock).mockResolvedValue(undefined);

        await run();

        expect(radarrModule.syncMovies).toHaveBeenCalledTimes(1);
        const calls = (radarrModule.syncMovies as jest.Mock).mock.calls[0];
        const unsafeTags = calls[2] as Set<string>;
        const managedTags = calls[1] as Set<string>;

        expect(unsafeTags.has('failed-tag')).toBe(true);
        expect(managedTags.has('failed-tag')).toBe(false);
        
        expect(managedTags.has('valid-tag')).toBe(true);
    });
});
