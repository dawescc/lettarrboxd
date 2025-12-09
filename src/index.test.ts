import { startScheduledMonitoring, main, run } from './index';
import * as scraperModule from './scraper';
import * as radarrModule from './api/radarr';
import * as serializdScraper from './scraper/serializd';
import * as sonarrModule from './api/sonarr';

// Mock dependencies
jest.mock('./util/env', () => ({
  CHECK_INTERVAL_MINUTES: 10,
  // These are kept for legacy path testing, but config mock overrides for most
  LETTERBOXD_URL: 'https://letterboxd.com/user/watchlist', 
  SERIALIZD_URL: 'https://serializd.com/user/watchlist',
  RADARR_TAGS: 'env_tag'
}));

jest.mock('./util/config', () => ({
  default: {
    letterboxd: [],
    serializd: [],
    radarr: undefined,
    sonarr: undefined
  }
}));

import config from './util/config';

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

jest.mock('./api/health', () => ({
  startHealthServer: jest.fn(),
  setAppStatus: jest.fn(),
  updateComponentStatus: jest.fn()
}));

describe('main application logic', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    // Reset config mock state if needed
    config.letterboxd = [{ url: 'https://list-a', tags: ['tag-a'], filters: undefined }];
    config.serializd = [];
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Multiple Lists & Tag Merging', () => {
    it('should aggregate movies from multiple lists and merge tags', async () => {
      // Setup Config with 2 lists
      config.letterboxd = [
        { url: 'https://list-a', tags: ['horror'], filters: undefined },
        { url: 'https://list-b', tags: ['watchlist'], filters: undefined }
      ];

      // Mock Scraper Responses
      (scraperModule.fetchMoviesFromUrl as jest.Mock).mockImplementation(async (url) => {
        if (url === 'https://list-a') {
          return [{ tmdbId: '100', name: 'Movie 100', tags: [] }];
        }
        if (url === 'https://list-b') {
          return [
            { tmdbId: '100', name: 'Movie 100', tags: [] }, // Duplicate
            { tmdbId: '200', name: 'Movie 200', tags: [] }
          ];
        }
        return [];
      });

      (radarrModule.syncMovies as jest.Mock).mockResolvedValue(undefined);

      await run(); // Triggers run()

      await Promise.resolve(); // wait for run promise

      expect(scraperModule.fetchMoviesFromUrl).toHaveBeenCalledTimes(2);
      
      expect(radarrModule.syncMovies).toHaveBeenCalledTimes(1);
      
      // Verify the passed payload to syncMovies
      const calls = (radarrModule.syncMovies as jest.Mock).mock.calls[0];
      const movies = calls[0];
      
      expect(movies).toHaveLength(2);
      
      const movie100 = movies.find((m: any) => m.tmdbId === '100');
      const movie200 = movies.find((m: any) => m.tmdbId === '200');

      // Movie 100 should have BOTH tags
      expect(movie100.tags).toEqual(expect.arrayContaining(['horror', 'watchlist']));
      
      // Movie 200 should have only list-b tag
      expect(movie200.tags).toEqual(['watchlist']);
    });
  });

  describe('Filtering', () => {
    it('should filter movies by minRating', async () => {
      config.letterboxd = [
        { 
          url: 'https://rated-list', 
          tags: [], 
          filters: { minRating: 7.0 } as any 
        }
      ];

      (scraperModule.fetchMoviesFromUrl as jest.Mock).mockResolvedValue([
        { tmdbId: '1', name: 'Good Movie', rating: 8.0 },
        { tmdbId: '2', name: 'Bad Movie', rating: 4.0 },
        { tmdbId: '3', name: 'Unknown Rating', rating: null }
      ]);

      await run();

      const calls = (radarrModule.syncMovies as jest.Mock).mock.calls[0];
      const movies = calls[0];

      // Should only keep 'Good Movie' (8.0 >= 7.0). Unknown rating is strict excluded.
      expect(movies).toHaveLength(1);
      expect(movies[0].name).toBe('Good Movie');
    });

    it('should filter movies by year range', async () => {
      config.letterboxd = [
        { 
          url: 'https://year-list', 
          tags: [], 
          filters: { minYear: 2000, maxYear: 2010 } as any 
        }
      ];

      (scraperModule.fetchMoviesFromUrl as jest.Mock).mockResolvedValue([
        { tmdbId: '1', name: '90s Movie', publishedYear: 1999 },
        { tmdbId: '2', name: '2000s Movie', publishedYear: 2005 },
        { tmdbId: '3', name: 'New Movie', publishedYear: 2024 },
        { tmdbId: '4', name: 'Unknown Year', publishedYear: null }
      ]);

      await run();

      const calls = (radarrModule.syncMovies as jest.Mock).mock.calls[0];
      const movies = calls[0];

      expect(movies).toHaveLength(1);
      expect(movies[0].name).toBe('2000s Movie');
    });
  });
});
