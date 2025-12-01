// Mock axios before importing radarr
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

// Mock env with mutable object
const mockEnv = {
  RADARR_API_URL: 'http://localhost:7878',
  RADARR_API_KEY: 'test-key',
  RADARR_QUALITY_PROFILE: 'HD-1080p',
  RADARR_MINIMUM_AVAILABILITY: 'released',
  RADARR_TAGS: 'tag1,tag2',
  RADARR_ADD_UNMONITORED: false,
  DRY_RUN: false,
  RADARR_ROOT_FOLDER_ID: undefined as string | undefined,
};

jest.mock('../util/env', () => mockEnv);

import {
  getQualityProfileId,
  getRootFolder,
  getRootFolderById,
  getOrCreateTag,
  getAllRequiredTagIds,
  addMovie,
  upsertMovies,
} from './radarr';

describe('radarr API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset env to defaults
    mockEnv.RADARR_API_URL = 'http://localhost:7878';
    mockEnv.RADARR_API_KEY = 'test-key';
    mockEnv.RADARR_QUALITY_PROFILE = 'HD-1080p';
    mockEnv.RADARR_MINIMUM_AVAILABILITY = 'released';
    mockEnv.RADARR_TAGS = 'tag1,tag2';
    mockEnv.RADARR_ADD_UNMONITORED = false;
    mockEnv.DRY_RUN = false;
    mockEnv.RADARR_ROOT_FOLDER_ID = undefined;
  });

  describe('getQualityProfileId', () => {
    it('should return quality profile ID when profile exists', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [
          { id: 1, name: 'SD' },
          { id: 2, name: 'HD-1080p' },
          { id: 3, name: '4K' },
        ],
      });

      const result = await getQualityProfileId('HD-1080p');

      expect(result).toBe(2);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/api/v3/qualityprofile');
    });

    it('should return null when profile does not exist', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [
          { id: 1, name: 'SD' },
          { id: 2, name: 'HD-1080p' },
        ],
      });

      const result = await getQualityProfileId('NonExistent');

      expect(result).toBeNull();
    });

    it('should return null on error', async () => {
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation((cb: any) => cb() as any);
      mockAxiosInstance.get.mockRejectedValue(new Error('Network error'));

      const result = await getQualityProfileId('HD-1080p');

      expect(result).toBeNull();
      setTimeoutSpy.mockRestore();
    });
  });

  describe('getRootFolder', () => {
    it('should return first root folder path', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [
          { id: 1, path: '/movies' },
          { id: 2, path: '/movies2' },
        ],
      });

      const result = await getRootFolder();

      expect(result).toBe('/movies');
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/api/v3/rootfolder');
    });

    it('should return null when no root folders exist', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [],
      });

      const result = await getRootFolder();

      expect(result).toBeNull();
    });

    it('should return null on error', async () => {
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation((cb: any) => cb() as any);
      mockAxiosInstance.get.mockRejectedValue(new Error('Network error'));

      const result = await getRootFolder();

      expect(result).toBeNull();
      setTimeoutSpy.mockRestore();
    });
  });

  describe('getRootFolderById', () => {
    it('should return root folder path by ID', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { id: 1, path: '/movies' },
      });

      const result = await getRootFolderById('1');

      expect(result).toBe('/movies');
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/api/v3/rootfolder/1');
    });

    it('should return null when folder not found', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: null,
      });

      const result = await getRootFolderById('999');

      expect(result).toBeNull();
    });

    it('should return null on error', async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error('Network error'));

      const result = await getRootFolderById('1');

      expect(result).toBeNull();
    });
  });

  describe('getOrCreateTag', () => {
    it('should return existing tag ID', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [
          { id: 1, label: 'letterboxd' },
          { id: 2, label: 'other' },
        ],
      });

      const result = await getOrCreateTag('letterboxd');

      expect(result).toBe(1);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/api/v3/tag');
      expect(mockAxiosInstance.post).not.toHaveBeenCalled();
    });

    it('should create new tag when it does not exist', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [{ id: 1, label: 'existing' }],
      });

      mockAxiosInstance.post.mockResolvedValueOnce({
        data: { id: 2, label: 'newtag' },
      });

      const result = await getOrCreateTag('newtag');

      expect(result).toBe(2);
      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/api/v3/tag', {
        label: 'newtag',
      });
    });

    it('should return null on error', async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error('Network error'));

      const result = await getOrCreateTag('testtag');

      expect(result).toBeNull();
    });
  });

  describe('getAllRequiredTagIds', () => {
    it('should return tag IDs for all configured tags', async () => {
      mockAxiosInstance.get.mockResolvedValue({
        data: [],
      });

      mockAxiosInstance.post
        .mockResolvedValueOnce({ data: { id: 1, label: 'letterboxd' } })
        .mockResolvedValueOnce({ data: { id: 2, label: 'tag1' } })
        .mockResolvedValueOnce({ data: { id: 3, label: 'tag2' } });

      const result = await getAllRequiredTagIds();

      expect(result).toHaveLength(3);
      expect(result).toContain(1);
      expect(result).toContain(2);
      expect(result).toContain(3);
    });

    it('should filter out null tag IDs', async () => {
      mockAxiosInstance.get.mockResolvedValue({
        data: [],
      });

      mockAxiosInstance.post
        .mockResolvedValueOnce({ data: { id: 1, label: 'letterboxd' } })
        .mockRejectedValueOnce(new Error('Failed to create tag'))
        .mockResolvedValueOnce({ data: { id: 3, label: 'tag2' } });

      const result = await getAllRequiredTagIds();

      expect(result).toHaveLength(2);
      expect(result).toContain(1);
      expect(result).toContain(3);
    });
  });

  describe('addMovie', () => {
    const mockMovie = {
      id: 1,
      name: 'Test Movie',
      slug: '/film/test-movie/',
      tmdbId: '12345',
      imdbId: 'tt12345',
      publishedYear: 2020,
    };

    it('should add movie to Radarr successfully', async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: { id: 1, title: 'Test Movie' },
      });

      await addMovie(mockMovie, 2, '/movies', [1, 2], 'released');

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/api/v3/movie', {
        title: 'Test Movie',
        qualityProfileId: 2,
        rootFolderPath: '/movies',
        tmdbId: 12345,
        minimumAvailability: 'released',
        monitored: true,
        tags: [1, 2],
        addOptions: {
          searchForMovie: true,
        },
      });
    });

    it('should skip movie without tmdbId', async () => {
      const movieWithoutTmdb = {
        ...mockMovie,
        tmdbId: null,
      };

      await addMovie(movieWithoutTmdb, 2, '/movies', [1], 'released');

      expect(mockAxiosInstance.post).not.toHaveBeenCalled();
    });

    it('should handle dry run mode', async () => {
      mockEnv.DRY_RUN = true;

      await addMovie(mockMovie, 2, '/movies', [1], 'released');

      expect(mockAxiosInstance.post).not.toHaveBeenCalled();
    });

    it('should handle movie already exists error', async () => {
      mockAxiosInstance.post.mockRejectedValueOnce({
        response: {
          status: 400,
          data: 'This movie has already been added',
        },
      });

      await expect(addMovie(mockMovie, 2, '/movies', [1], 'released')).resolves.toBeUndefined();
    });

    it('should log error for other errors', async () => {
      mockAxiosInstance.post.mockRejectedValueOnce(new Error('Network error'));

      await expect(addMovie(mockMovie, 2, '/movies', [1], 'released')).resolves.toBeUndefined();
    });

    it('should set monitored to false when RADARR_ADD_UNMONITORED is true', async () => {
      mockEnv.RADARR_ADD_UNMONITORED = true;

      mockAxiosInstance.post.mockResolvedValueOnce({
        data: { id: 1, title: 'Test Movie' },
      });

      await addMovie(mockMovie, 2, '/movies', [1], 'released');

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '/api/v3/movie',
        expect.objectContaining({
          monitored: false,
        })
      );
    });
  });

  describe('upsertMovies', () => {
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

    it('should process all movies', async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce({
          data: [{ id: 2, name: 'HD-1080p' }],
        })
        .mockResolvedValueOnce({
          data: [{ id: 1, path: '/movies' }],
        })
        .mockResolvedValue({
          data: [],
        });

      mockAxiosInstance.post
        .mockResolvedValueOnce({ data: { id: 1, label: 'letterboxd' } })
        .mockResolvedValueOnce({ data: { id: 1, title: 'Movie 1' } })
        .mockResolvedValueOnce({ data: { id: 2, title: 'Movie 2' } });

      await upsertMovies(mockMovies);

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '/api/v3/movie',
        expect.objectContaining({ title: 'Movie 1' })
      );
      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '/api/v3/movie',
        expect.objectContaining({ title: 'Movie 2' })
      );
    });

    it('should throw error when quality profile not found', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [],
      });

      await expect(upsertMovies(mockMovies)).rejects.toThrow(
        'Could not get quality profile ID.'
      );
    });

    it('should throw error when root folder not found', async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce({
          data: [{ id: 2, name: 'HD-1080p' }],
        })
        .mockResolvedValueOnce({
          data: [],
        });

      await expect(upsertMovies(mockMovies)).rejects.toThrow('Could not get root folder');
    });
  });
});
