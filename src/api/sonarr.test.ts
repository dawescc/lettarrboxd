// Mock axios before importing sonarr
const mockAxiosInstance = {
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  delete: jest.fn(),
};

jest.mock('axios', () => {
  return {
    create: jest.fn(() => mockAxiosInstance),
    default: {
      create: jest.fn(() => mockAxiosInstance),
    },
  };
});

// Mock logger
jest.mock('../util/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// Mock env
jest.mock('../util/env', () => ({
  SONARR_API_URL: 'http://localhost:8989',
  SONARR_API_KEY: 'test-key',
  SONARR_QUALITY_PROFILE: 'HD-1080p',
  SONARR_ROOT_FOLDER_PATH: '/tv',
  SONARR_SEASON_MONITORING: 'all',
  DRY_RUN: false,
  REMOVE_MISSING_ITEMS: false,
  OVERRIDE_TAGS: false,
}));

jest.mock('../util/retry', () => ({
  retryOperation: jest.fn((fn) => fn()),
}));

import {

  getAllSeries,
  deleteSeries,
  syncSeries,
  getSeriesLookup,

} from './sonarr';

describe('sonarr API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset env
    const env = require('../util/env');
    env.REMOVE_MISSING_ITEMS = false;
    env.DRY_RUN = false;
  });



  describe('getSeriesLookup', () => {
    it('should return series info when found', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [{ title: 'Barry', tvdbId: 12345 }],
      });

      const result = await getSeriesLookup('73107');

      expect(result).toEqual({ title: 'Barry', tvdbId: 12345 });
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/api/v3/series/lookup', {
        params: { term: 'tmdb:73107' },
      });
    });

    it('should return null when not found', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [],
      });

      const result = await getSeriesLookup('99999');

      expect(result).toBeNull();
    });
  });

  describe('getAllSeries', () => {
    it('should return all series', async () => {
      const mockSeries = [{ id: 1, title: 'Series 1' }];
      mockAxiosInstance.get.mockResolvedValueOnce({ data: mockSeries });

      const result = await getAllSeries();
      expect(result).toEqual(mockSeries);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/api/v3/series');
    });

    it('should return empty array on error', async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error('Network error'));
      const result = await getAllSeries();
      expect(result).toEqual([]);
    });
  });

  describe('deleteSeries', () => {
    it('should delete series', async () => {
      mockAxiosInstance.delete.mockResolvedValueOnce({});
      await deleteSeries(1, 'Series 1');
      expect(mockAxiosInstance.delete).toHaveBeenCalledWith('/api/v3/series/1', {
        params: { deleteFiles: true, addImportExclusion: false }
      });
    });

    it('should not delete in dry run', async () => {
      const env = require('../util/env');
      env.DRY_RUN = true;
      await deleteSeries(1, 'Series 1');
      expect(mockAxiosInstance.delete).not.toHaveBeenCalled();
    });
  });

  describe('syncSeries', () => {
    const mockSeries = [
      {
        id: 1,
        name: 'Barry',
        tmdbId: '73107',
        slug: 'Barry',
      },
    ];

      it('should add series successfully', async () => {
      mockAxiosInstance.get.mockImplementation((url) => {
        if (url.includes('/qualityprofile')) return Promise.resolve({ data: [{ id: 2, name: 'HD-1080p' }] });
        if (url.includes('/rootfolder')) return Promise.resolve({ data: [{ path: '/tv' }] });
        if (url.includes('/tag')) return Promise.resolve({ data: [{ id: 1, label: 'serializd' }] });
        if (url === '/api/v3/series') return Promise.resolve({ data: [] }); // Empty library
        if (url.includes('/series/lookup')) return Promise.resolve({ 
          data: [{
            title: 'Barry',
            tvdbId: 12345,
            seasons: [{ seasonNumber: 1 }]
          }]
        });
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      mockAxiosInstance.post.mockResolvedValueOnce({
        data: { id: 1, title: 'Barry' },
      });

      await syncSeries(mockSeries, new Set());

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/api/v3/series', expect.objectContaining({
        title: 'Barry',
        tvdbId: 12345,
      }));
    });

    it('should skip existing series (cached match)', async () => {
      mockAxiosInstance.get.mockImplementation((url) => {
        if (url.includes('/qualityprofile')) return Promise.resolve({ data: [{ id: 2, name: 'HD-1080p' }] });
        if (url.includes('/rootfolder')) return Promise.resolve({ data: [{ path: '/tv' }] });
        if (url.includes('/tag')) return Promise.resolve({ data: [{ id: 1, label: 'serializd' }] });
        if (url === '/api/v3/series') return Promise.resolve({ 
          data: [{ id: 100, title: 'Barry', tvdbId: 12345, tmdbId: 73107 }] 
        });
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      await syncSeries(mockSeries, new Set());

      expect(mockAxiosInstance.post).not.toHaveBeenCalled();
    });

    it('should remove missing series when enabled', async () => {
      const env = require('../util/env');
      env.REMOVE_MISSING_ITEMS = true;

      mockAxiosInstance.get.mockImplementation((url) => {
        if (url.includes('/qualityprofile')) return Promise.resolve({ data: [{ id: 2, name: 'HD-1080p' }] });
        if (url.includes('/rootfolder')) return Promise.resolve({ data: [{ path: '/tv' }] });
        if (url.includes('/tag')) return Promise.resolve({ data: [{ id: 1, label: 'serializd' }] });
        if (url === '/api/v3/series') return Promise.resolve({ 
          data: [
            { id: 100, title: 'Barry', tvdbId: 12345, tmdbId: 73107, tags: [1] }, // Keep
            { id: 101, title: 'Removed', tvdbId: 99999, tags: [1] }, // Remove
            { id: 102, title: 'Other', tvdbId: 88888, tags: [] }, // Keep
          ] 
        });
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      mockAxiosInstance.post.mockResolvedValue({ data: { id: 1, label: 'serializd' } });
      mockAxiosInstance.delete.mockResolvedValue({});

      await syncSeries(mockSeries, new Set());

      expect(mockAxiosInstance.delete).toHaveBeenCalledWith('/api/v3/series/101', expect.any(Object));
      expect(mockAxiosInstance.delete).not.toHaveBeenCalledWith('/api/v3/series/102', expect.any(Object));
    });
    it('should update seasons for existing series if changed', async () => {
      mockAxiosInstance.get.mockImplementation((url) => {
        if (url.includes('/qualityprofile')) return Promise.resolve({ data: [{ id: 2, name: 'HD-1080p' }] });
        if (url.includes('/rootfolder')) return Promise.resolve({ data: [{ path: '/tv' }] });
        if (url.includes('/tag')) return Promise.resolve({ data: [{ id: 1, label: 'serializd' }] });
        if (url === '/api/v3/series') return Promise.resolve({ 
          data: [{ 
            id: 100, 
            title: 'Barry', 
            tvdbId: 12345, 
            tmdbId: 73107, 
            seasons: [
              { seasonNumber: 1, monitored: false },
              { seasonNumber: 2, monitored: false }
            ] 
          }] 
        });
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      mockAxiosInstance.put.mockResolvedValue({});

      const seriesWithSeasons = [{
        ...mockSeries[0],
        seasons: [1] // Target Season 1
      }];

      await syncSeries(seriesWithSeasons, new Set());

      expect(mockAxiosInstance.put).toHaveBeenCalledWith('/api/v3/series/100', expect.objectContaining({
        id: 100,
        seasons: expect.arrayContaining([
          expect.objectContaining({ seasonNumber: 1, monitored: true }),
          expect.objectContaining({ seasonNumber: 2, monitored: false })
        ])
      }));
    });

    it('should unmonitor seasons that are no longer in the target list', async () => {
      mockAxiosInstance.get.mockImplementation((url) => {
        if (url.includes('/qualityprofile')) return Promise.resolve({ data: [{ id: 2, name: 'HD-1080p' }] });
        if (url.includes('/rootfolder')) return Promise.resolve({ data: [{ path: '/tv' }] });
        if (url.includes('/tag')) return Promise.resolve({ data: [{ id: 1, label: 'serializd' }] });
        if (url === '/api/v3/series') return Promise.resolve({ 
          data: [{ 
            id: 100, 
            title: 'Barry', 
            tvdbId: 12345, 
            tmdbId: 73107, 
            seasons: [
              { seasonNumber: 1, monitored: true }, // Was monitored
              { seasonNumber: 2, monitored: true }  // Was monitored
            ] 
          }] 
        });
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      mockAxiosInstance.put.mockResolvedValue({});

      const seriesWithSeasons = [{
        ...mockSeries[0],
        seasons: [2] // Now ONLY monitor Season 2 (Season 1 should become unmonitored)
      }];

      await syncSeries(seriesWithSeasons, new Set());

      expect(mockAxiosInstance.put).toHaveBeenCalledWith('/api/v3/series/100', expect.objectContaining({
        id: 100,
        seasons: expect.arrayContaining([
          expect.objectContaining({ seasonNumber: 1, monitored: false }), // Should be false now
          expect.objectContaining({ seasonNumber: 2, monitored: true })
        ])
      }));
    });

    it('should use list-specific quality profile override', async () => {
        const seriesWithOverride = [
          {
            id: 1,
            name: 'Override Series',
            slug: 'Override Series',
            tmdbId: '999',
            qualityProfile: '4K'
          }
        ];
  
        mockAxiosInstance.get.mockImplementation((url) => {
          if (url.includes('/qualityprofile')) return Promise.resolve({ 
              data: [
                  { id: 2, name: 'HD-1080p' },
                  { id: 3, name: '4K' }
              ] 
          });
          if (url.includes('/rootfolder')) return Promise.resolve({ data: [{ path: '/tv' }] });
          if (url.includes('/tag')) return Promise.resolve({ data: [] });
          if (url === '/api/v3/series') return Promise.resolve({ data: [] });
          if (url.includes('/series/lookup')) return Promise.resolve({ 
            data: [{
              title: 'Override Series',
              tvdbId: 12345,
              seasons: [{ seasonNumber: 1 }]
            }]
          });
          return Promise.reject(new Error(`Unexpected URL: ${url}`));
        });
  
        mockAxiosInstance.post.mockResolvedValue({ data: { id: 1, title: 'Override Series' } });
  
        await syncSeries(seriesWithOverride, new Set());
  
        expect(mockAxiosInstance.post).toHaveBeenCalledWith(
          '/api/v3/series',
          expect.objectContaining({ 
              title: 'Override Series',
              qualityProfileId: 3 // Should use 4K ID
          })
        );
      });

    it('should add new series with specific monitored seasons', async () => {
      mockAxiosInstance.get.mockImplementation((url) => {
        if (url.includes('/qualityprofile')) return Promise.resolve({ data: [{ id: 2, name: 'HD-1080p' }] });
        if (url.includes('/rootfolder')) return Promise.resolve({ data: [{ path: '/tv' }] });
        if (url.includes('/tag')) return Promise.resolve({ data: [{ id: 1, label: 'serializd' }] });
        if (url === '/api/v3/series') return Promise.resolve({ data: [] });
        if (url.includes('/series/lookup')) return Promise.resolve({ 
          data: [{
            title: 'Barry',
            tvdbId: 12345,
            seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }]
          }]
        });
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      mockAxiosInstance.post.mockResolvedValueOnce({ data: { id: 1, title: 'Barry' } });

      const seriesWithSeasons = [{
        ...mockSeries[0],
        seasons: [2] // Only monitor Season 2
      }];

      await syncSeries(seriesWithSeasons, new Set());

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/api/v3/series', expect.objectContaining({
        title: 'Barry',
        seasons: expect.arrayContaining([
          expect.objectContaining({ seasonNumber: 1, monitored: false }),
          expect.objectContaining({ seasonNumber: 2, monitored: true })
        ])
      }));
    });

    it('should update existing series tags if OVERRIDE_TAGS is enabled, even without ownership tag', async () => {
        const env = require('../util/env');
        env.OVERRIDE_TAGS = true;
  
        mockAxiosInstance.get.mockImplementation((url) => {
          if (url.includes('/qualityprofile')) return Promise.resolve({ data: [{ id: 2, name: 'HD-1080p' }] });
          if (url.includes('/rootfolder')) return Promise.resolve({ data: [{ path: '/tv' }] });
          if (url.includes('/tag')) return Promise.resolve({ data: [{ id: 1, label: 'serializd' }] });
          if (url === '/api/v3/series') return Promise.resolve({ 
            data: [{ id: 100, title: 'Barry', tvdbId: 12345, tmdbId: 73107, tags: [] }] // No tags
          });
          return Promise.reject(new Error(`Unexpected URL: ${url}`));
        });
  
        mockAxiosInstance.put.mockResolvedValue({});
  
        await syncSeries(mockSeries, new Set());
  
        expect(mockAxiosInstance.put).toHaveBeenCalledWith(
          '/api/v3/series/100',
          expect.objectContaining({
            id: 100,
            tags: expect.arrayContaining([1])
          })
        );
      });
  

      it('should NOT update existing series tags if OVERRIDE_TAGS is disabled and ownership tag is missing', async () => {
        const env = require('../util/env');
        env.OVERRIDE_TAGS = false;
  
        mockAxiosInstance.get.mockImplementation((url) => {
          if (url.includes('/qualityprofile')) return Promise.resolve({ data: [{ id: 2, name: 'HD-1080p' }] });
          if (url.includes('/rootfolder')) return Promise.resolve({ data: [{ path: '/tv' }] });
          if (url.includes('/tag')) return Promise.resolve({ data: [{ id: 1, label: 'serializd' }] });
          if (url === '/api/v3/series') return Promise.resolve({ 
            data: [{ id: 100, title: 'Barry', tvdbId: 12345, tmdbId: 73107, tags: [] }] // No tags
          });
          return Promise.reject(new Error(`Unexpected URL: ${url}`));
        });
  
        await syncSeries(mockSeries, new Set());
  
        expect(mockAxiosInstance.put).not.toHaveBeenCalled();
      });

      it('should delete episode files for unmonitored seasons when REMOVE_MISSING_ITEMS is enabled', async () => {
        const env = require('../util/env');
        env.REMOVE_MISSING_ITEMS = true;

        mockAxiosInstance.get.mockImplementation((url, config) => {
            if (url.includes('/qualityprofile')) return Promise.resolve({ data: [{ id: 2, name: 'HD-1080p' }] });
            if (url.includes('/rootfolder')) return Promise.resolve({ data: [{ path: '/tv' }] });
            if (url.includes('/tag')) return Promise.resolve({ data: [{ id: 1, label: 'serializd' }] });
            if (url === '/api/v3/series') return Promise.resolve({ 
                data: [{ 
                    id: 100, 
                    title: 'Barry', 
                    tvdbId: 12345, 
                    tmdbId: 73107, 
                    seasons: [
                        { seasonNumber: 1, monitored: true }, 
                        { seasonNumber: 2, monitored: true }
                    ] 
                }] 
            });
            if (url === '/api/v3/episodefile') {
                // Return files for Season 1 (id 10) and Season 2 (id 20)
                return Promise.resolve({
                    data: [
                        { id: 10, seriesId: 100, seasonNumber: 1, path: '/tv/Barry/S01/E01.mkv', size: 1000 },
                        { id: 20, seriesId: 100, seasonNumber: 2, path: '/tv/Barry/S02/E01.mkv', size: 1000 }
                    ]
                });
            }
            return Promise.reject(new Error(`Unexpected URL: ${url}`));
        });

        mockAxiosInstance.put.mockResolvedValue({});
        mockAxiosInstance.delete.mockResolvedValue({});

        const seriesWithSeasons = [{
            ...mockSeries[0],
            seasons: [2] // Only monitor Season 2. Season 1 Should be unmonitored and cleaned up.
        }];

        await syncSeries(seriesWithSeasons, new Set());

        // 1. Expect Season 1 to be unmonitored
        expect(mockAxiosInstance.put).toHaveBeenCalledWith('/api/v3/series/100', expect.objectContaining({
            seasons: expect.arrayContaining([
                expect.objectContaining({ seasonNumber: 1, monitored: false }),
                expect.objectContaining({ seasonNumber: 2, monitored: true })
            ])
        }));

        // 2. Expect file for Season 1 (id 10) to be deleted
        expect(mockAxiosInstance.delete).toHaveBeenCalledWith('/api/v3/episodefile/10');
        
        // 3. Expect file for Season 2 (id 20) NOT to be deleted
        expect(mockAxiosInstance.delete).not.toHaveBeenCalledWith('/api/v3/episodefile/20');
      });

  });
});
