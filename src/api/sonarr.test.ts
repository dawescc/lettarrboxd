// Mock axios before importing sonarr
const mockAxiosInstance = {
  get: jest.fn(),
  post: jest.fn(),
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
}));

jest.mock('../util/retry', () => ({
  retryOperation: jest.fn((fn) => fn()),
}));

import {
  getQualityProfileId,
  getSeriesLookup,
  syncSeries,
  getAllSeries,
  deleteSeries,
} from './sonarr';

describe('sonarr API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset env
    const env = require('../util/env');
    env.REMOVE_MISSING_ITEMS = false;
    env.DRY_RUN = false;
  });

  describe('getQualityProfileId', () => {
    it('should return quality profile ID when profile exists', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [
          { id: 1, name: 'SD' },
          { id: 2, name: 'HD-1080p' },
        ],
      });

      const result = await getQualityProfileId('HD-1080p');

      expect(result).toBe(2);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/api/v3/qualityprofile');
    });

    it('should return null when profile does not exist', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [{ id: 1, name: 'SD' }],
      });

      const result = await getQualityProfileId('HD-1080p');

      expect(result).toBeNull();
    });
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
        params: { deleteFiles: false, addImportExclusion: false }
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

      await syncSeries(mockSeries);

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

      await syncSeries(mockSeries);

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

      await syncSeries(mockSeries);

      expect(mockAxiosInstance.delete).toHaveBeenCalledWith('/api/v3/series/101', expect.any(Object));
      expect(mockAxiosInstance.delete).not.toHaveBeenCalledWith('/api/v3/series/102', expect.any(Object));
    });
  });
});
