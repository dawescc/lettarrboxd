// Mock axios before importing sonarr
const mockAxiosInstance = {
  get: jest.fn(),
  post: jest.fn(),
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
}));

import {
  getQualityProfileId,
  getSeriesLookup,
  upsertSeries,
} from './sonarr';

describe('sonarr API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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

  describe('upsertSeries', () => {
    const mockSeries = [
      {
        id: 1,
        name: 'Barry',
        tmdbId: '73107',
        slug: 'Barry',
      },
    ];

    it('should add series successfully', async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce({
          data: [{ id: 2, name: 'HD-1080p' }],
        })
        .mockResolvedValueOnce({
          data: [{ path: '/tv' }],
        })
        .mockResolvedValueOnce({
          data: [{ id: 1, label: 'serializd' }],
        })
        .mockResolvedValueOnce({
          data: [{
            title: 'Barry',
            tvdbId: 12345,
            seasons: [
              { seasonNumber: 1 },
              { seasonNumber: 2 },
              { seasonNumber: 3 },
              { seasonNumber: 4 }
            ]
          }],
        });

      mockAxiosInstance.post.mockResolvedValueOnce({
        data: { id: 1, title: 'Barry' },
      });

      await upsertSeries(mockSeries);

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/api/v3/series', {
        title: 'Barry',
        qualityProfileId: 2,
        rootFolderPath: '/tv',
        tvdbId: 12345,
        monitored: true,
        tags: [1],
        seasons: [
          { seasonNumber: 1, monitored: true },
          { seasonNumber: 2, monitored: true },
          { seasonNumber: 3, monitored: true },
          { seasonNumber: 4, monitored: true }
        ],
        addOptions: {
          searchForMissingEpisodes: true,
        },
      });
    });
  });
});
