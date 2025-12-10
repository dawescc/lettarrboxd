// Mock axios before importing radarr
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
  REMOVE_MISSING_ITEMS: false,
};

jest.mock('../util/env', () => mockEnv);

jest.mock('../util/retry', () => ({
  retryOperation: jest.fn((fn) => fn()),
}));

import {

  getRootFolder,
  getRootFolderById,
  ensureTagsAreAvailable,
  getAllTags,
  addMovie,
  syncMovies,
  getAllMovies,
  deleteMovie,
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
    mockEnv.REMOVE_MISSING_ITEMS = false;
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

  describe('ensureTagsAreAvailable', () => {
    it('should return map of existing tags', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [
          { id: 1, label: 'letterboxd' },
          { id: 2, label: 'other' },
        ],
      });

      const startTags = ['letterboxd', 'other'];
      const result = await ensureTagsAreAvailable(startTags);

      expect(result.get('letterboxd')).toBe(1);
      expect(result.get('other')).toBe(2);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/api/v3/tag');
      expect(mockAxiosInstance.post).not.toHaveBeenCalled();
    });

    it('should create missing tags', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [{ id: 1, label: 'existing' }],
      });

      mockAxiosInstance.post.mockResolvedValueOnce({
        data: { id: 2, label: 'newtag' },
      });

      const tags = ['existing', 'newtag'];
      const result = await ensureTagsAreAvailable(tags);

      expect(result.get('existing')).toBe(1);
      expect(result.get('newtag')).toBe(2);
      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/api/v3/tag', {
        label: 'newtag',
      });
    });

    it('should handle errors gracefully', async () => {
        mockAxiosInstance.get.mockRejectedValueOnce(new Error('Network Error'));
        const result = await ensureTagsAreAvailable(['foo']);
        expect(result.size).toBe(0);
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

  describe('getAllMovies', () => {
    it('should return all movies', async () => {
      const mockMovies = [{ id: 1, title: 'Movie 1' }];
      mockAxiosInstance.get.mockResolvedValueOnce({ data: mockMovies });

      const result = await getAllMovies();
      expect(result).toEqual(mockMovies);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/api/v3/movie');
    });

    it('should return empty array on error', async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error('Network error'));
      const result = await getAllMovies();
      expect(result).toEqual([]);
    });
  });

  describe('deleteMovie', () => {
    it('should delete movie', async () => {
      mockAxiosInstance.delete.mockResolvedValueOnce({});
      await deleteMovie(1, 'Movie 1');
      expect(mockAxiosInstance.delete).toHaveBeenCalledWith('/api/v3/movie/1', {
        params: { deleteFiles: true, addImportExclusion: false }
      });
    });

    it('should not delete in dry run', async () => {
      mockEnv.DRY_RUN = true;
      await deleteMovie(1, 'Movie 1');
      expect(mockAxiosInstance.delete).not.toHaveBeenCalled();
    });
  });

  describe('syncMovies', () => {
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

    it('should process all movies and add new ones', async () => {
      mockAxiosInstance.get.mockImplementation((url) => {
        if (url.includes('/qualityprofile')) return Promise.resolve({ data: [{ id: 2, name: 'HD-1080p' }] });
        if (url.includes('/rootfolder')) return Promise.resolve({ data: [{ id: 1, path: '/movies' }] });
        if (url.includes('/tag')) return Promise.resolve({ data: [] });
        if (url === '/api/v3/movie') return Promise.resolve({ data: [] }); // Empty library
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      mockAxiosInstance.post.mockImplementation((url, data) => {
        if (url.includes('/tag')) return Promise.resolve({ data: { id: 1, label: 'letterboxd' } });
        if (url === '/api/v3/movie') {
          if (data.title === 'Movie 1') return Promise.resolve({ data: { id: 1, title: 'Movie 1' } });
          if (data.title === 'Movie 2') return Promise.resolve({ data: { id: 2, title: 'Movie 2' } });
        }
        return Promise.resolve({ data: {} });
      });

      await syncMovies(mockMovies);

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '/api/v3/movie',
        expect.objectContaining({ title: 'Movie 1' })
      );
      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '/api/v3/movie',
        expect.objectContaining({ title: 'Movie 2' })
      );
    });

    it('should skip existing movies (cached)', async () => {
      mockAxiosInstance.get.mockImplementation((url) => {
        if (url.includes('/qualityprofile')) return Promise.resolve({ data: [{ id: 2, name: 'HD-1080p' }] });
        if (url.includes('/rootfolder')) return Promise.resolve({ data: [{ id: 1, path: '/movies' }] });
        if (url.includes('/tag')) return Promise.resolve({ data: [] });
        if (url === '/api/v3/movie') return Promise.resolve({ 
          data: [{ id: 100, title: 'Movie 1', tmdbId: 123 }] 
        });
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      mockAxiosInstance.post.mockImplementation((url, data) => {
        if (url.includes('/tag')) return Promise.resolve({ data: { id: 1, label: 'letterboxd' } });
        if (url === '/api/v3/movie') return Promise.resolve({ data: { id: 2, title: 'Movie 2' } });
        return Promise.resolve({ data: {} });
      });

      await syncMovies(mockMovies);

      // Should only add Movie 2
      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '/api/v3/movie',
        expect.objectContaining({ title: 'Movie 2' })
      );
      expect(mockAxiosInstance.post).not.toHaveBeenCalledWith(
        '/api/v3/movie',
        expect.objectContaining({ title: 'Movie 1' })
      );
    });

    it('should use list-specific quality profile override', async () => {
      const movieWithOverride = [
        {
          id: 1,
          name: 'Override Movie',
          slug: '/film/override/',
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
        if (url.includes('/rootfolder')) return Promise.resolve({ data: [{ id: 1, path: '/movies' }] });
        if (url.includes('/tag')) return Promise.resolve({ data: [] });
        if (url === '/api/v3/movie') return Promise.resolve({ data: [] });
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      mockAxiosInstance.post.mockResolvedValue({ data: { id: 1, title: 'Override Movie' } });

      await syncMovies(movieWithOverride);

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '/api/v3/movie',
        expect.objectContaining({ 
            title: 'Override Movie',
            qualityProfileId: 3 // Should use 4K ID
        })
      );
    });

    it('should remove missing movies when enabled', async () => {
      mockEnv.REMOVE_MISSING_ITEMS = true;
      
      const moviesInWatchlist = [mockMovies[0]]; // Only Movie 1 is in watchlist

      mockAxiosInstance.get.mockImplementation((url) => {
        if (url.includes('/qualityprofile')) return Promise.resolve({ data: [{ id: 2, name: 'HD-1080p' }] });
        if (url.includes('/rootfolder')) return Promise.resolve({ data: [{ id: 1, path: '/movies' }] });
        if (url.includes('/tag')) return Promise.resolve({ data: [{ id: 1, label: 'letterboxd' }] });
        if (url === '/api/v3/movie') return Promise.resolve({ 
          data: [
            { id: 100, title: 'Movie 1', tmdbId: 123, tags: [1] }, // Keep
            { id: 101, title: 'Movie 2', tmdbId: 456, tags: [1] }, // Remove
            { id: 102, title: 'Movie 3', tmdbId: 789, tags: [] }, // Keep
          ] 
        });
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      mockAxiosInstance.post.mockResolvedValue({ data: { id: 1, label: 'letterboxd' } });
      mockAxiosInstance.delete.mockResolvedValue({});

      await syncMovies(moviesInWatchlist);

      // Should delete Movie 2
      expect(mockAxiosInstance.delete).toHaveBeenCalledWith('/api/v3/movie/101', expect.any(Object));
      // Should NOT delete Movie 3 (no tag)
      expect(mockAxiosInstance.delete).not.toHaveBeenCalledWith('/api/v3/movie/102', expect.any(Object));
    });

    it('should throw error when quality profile not found', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [],
      });

      await expect(syncMovies(mockMovies)).rejects.toThrow(
        /Could not find global quality profile ID/
      );
    });
  });
});
