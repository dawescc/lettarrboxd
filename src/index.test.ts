import { main, startScheduledMonitoring } from './index';
import * as scraperModule from './scraper';
import * as radarrModule from './api/radarr';

// Mock dependencies
jest.mock('./util/env', () => ({
  CHECK_INTERVAL_MINUTES: 10,
  LETTERBOXD_URL: 'https://letterboxd.com/user/watchlist',
}));
jest.mock('./util/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('./scraper');
jest.mock('./api/radarr');

describe('main application', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('startScheduledMonitoring', () => {
    it('should run immediately and schedule future runs', async () => {
      const mockMovies = [
        {
          id: 1,
          name: 'Test Movie',
          slug: '/film/test-movie/',
          tmdbId: '123',
          imdbId: null,
          publishedYear: null,
        },
      ];

      (scraperModule.fetchMoviesFromUrl as jest.Mock).mockResolvedValue(mockMovies);
      (radarrModule.syncMovies as jest.Mock).mockResolvedValue(undefined);

      startScheduledMonitoring();

      // Wait for the immediate run to complete
      await Promise.resolve();

      // Verify run was called immediately
      expect(scraperModule.fetchMoviesFromUrl).toHaveBeenCalledTimes(1);
      expect(radarrModule.syncMovies).toHaveBeenCalledTimes(1);
    });

    it('should fetch movies and upsert them during run', async () => {
      const mockMovies = [
        {
          id: 1,
          name: 'Movie 1',
          slug: '/film/movie1/',
          tmdbId: '123',
          imdbId: null,
          publishedYear: null,
        },
        {
          id: 2,
          name: 'Movie 2',
          slug: '/film/movie2/',
          tmdbId: '456',
          imdbId: null,
          publishedYear: null,
        },
      ];

      (scraperModule.fetchMoviesFromUrl as jest.Mock).mockResolvedValue(mockMovies);
      (radarrModule.syncMovies as jest.Mock).mockResolvedValue(undefined);

      startScheduledMonitoring();

      // Wait for the immediate run to complete
      await Promise.resolve();

      expect(scraperModule.fetchMoviesFromUrl).toHaveBeenCalledWith(
        'https://letterboxd.com/user/watchlist'
      );
      expect(radarrModule.syncMovies).toHaveBeenCalledWith(mockMovies);
    });

    it('should call fetchMoviesFromUrl and upsertMovies during scheduled run', async () => {
      const mockMovies = [
        {
          id: 1,
          name: 'Test Movie',
          slug: '/film/test-movie/',
          tmdbId: '123',
          imdbId: null,
          publishedYear: null,
        },
      ];

      (scraperModule.fetchMoviesFromUrl as jest.Mock).mockResolvedValue(mockMovies);
      (radarrModule.syncMovies as jest.Mock).mockResolvedValue(undefined);

      startScheduledMonitoring();

      // Wait for immediate run to complete and finally block to execute
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Clear mocks to test scheduled callback
      jest.clearAllMocks();
      (scraperModule.fetchMoviesFromUrl as jest.Mock).mockResolvedValue(mockMovies);
      (radarrModule.syncMovies as jest.Mock).mockResolvedValue(undefined);

      // Fast-forward time by 10 minutes (600000ms)
      jest.advanceTimersByTime(600000);
      
      // Allow the scheduled run to execute
      await Promise.resolve();
      await Promise.resolve();

      // Verify the scheduled callback also calls the functions
      expect(scraperModule.fetchMoviesFromUrl).toHaveBeenCalled();
      expect(radarrModule.syncMovies).toHaveBeenCalled();
    });
  });

  describe('main', () => {
    it('should call startScheduledMonitoring', async () => {
      const mockMovies = [
        {
          id: 1,
          name: 'Test Movie',
          slug: '/film/test-movie/',
          tmdbId: '123',
          imdbId: null,
          publishedYear: null,
        },
      ];

      (scraperModule.fetchMoviesFromUrl as jest.Mock).mockResolvedValue(mockMovies);
      (radarrModule.syncMovies as jest.Mock).mockResolvedValue(undefined);

      await main();
      await Promise.resolve();

      expect(scraperModule.fetchMoviesFromUrl).toHaveBeenCalled();
      expect(radarrModule.syncMovies).toHaveBeenCalled();
    });
  });
});
