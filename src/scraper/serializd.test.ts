import { SerializdScraper } from './serializd';
import axios from 'axios';

// Mock logger
jest.mock('../util/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock fs
jest.mock('fs', () => ({
  existsSync: jest.fn(() => false), // No cache file exists by default
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
}));
import fs from 'fs';

// Mock retry
jest.mock('../util/retry', () => ({
  retryOperation: jest.fn(async (fn) => await fn()),
}));

describe('SerializdScraper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should scrape series from watchlist', async () => {
    const mockResponse = {
      items: [
        {
          showId: 73107,
          showName: 'Barry',
          bannerImage: '/path/to/image.jpg',
          dateAdded: '2023-01-01T00:00:00Z'
        },
        {
          showId: 66732,
          showName: 'Stranger Things',
          bannerImage: '/path/to/image2.jpg',
          dateAdded: '2023-01-02T00:00:00Z'
        }
      ],
      totalPages: 1,
      numberOfShows: 2
    };

    mockedAxios.get.mockResolvedValue({ data: mockResponse });

    const scraper = new SerializdScraper('https://www.serializd.com/user/dawescc/watchlist');
    const { items: series } = await scraper.getSeries();

    expect(series).toHaveLength(2);
    expect(series[0]).toEqual(expect.objectContaining({
      id: 73107,
      name: 'Barry',
      tmdbId: '73107',
      slug: 'barry',
      seasons: []
    }));
    expect(series[1]).toEqual(expect.objectContaining({
      id: 66732,
      name: 'Stranger Things',
      tmdbId: '66732',
      slug: 'stranger-things',
      seasons: []
    }));

    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('https://www.serializd.com/api/user/dawescc/watchlistpage_v2/1'),
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Requested-With': 'serializd_vercel'
        })
      })
    );
  });

  it('should handle pagination', async () => {
    const mockResponsePage1 = {
      items: [{ showId: 1, showName: 'Show 1' }],
      totalPages: 2,
      numberOfShows: 2
    };
    const mockResponsePage2 = {
      items: [{ showId: 2, showName: 'Show 2' }],
      totalPages: 2,
      numberOfShows: 2
    };

    mockedAxios.get
      .mockResolvedValueOnce({ data: mockResponsePage1 })
      .mockResolvedValueOnce({ data: mockResponsePage2 });

    const scraper = new SerializdScraper('https://www.serializd.com/user/dawescc/watchlist');
    const { items: series } = await scraper.getSeries();

    expect(series).toHaveLength(2);
    expect(series[0].id).toBe(1);
    expect(series[1].id).toBe(2);
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
  });

  it('should throw error for invalid URL', async () => {
    const scraper = new SerializdScraper('https://www.serializd.com/invalid/url');
    await expect(scraper.getSeries()).rejects.toThrow('Invalid Serializd watchlist URL');
  });

  it('should handle errors gracefully', async () => {
    mockedAxios.get.mockRejectedValue(new Error('Network error'));

    const scraper = new SerializdScraper('https://www.serializd.com/user/dawescc/watchlist');

    await expect(scraper.getSeries()).rejects.toThrow('Network error');
  });


  it('should resolve season numbers from cache/api', async () => {
    // Mock the watchlist response
    mockedAxios.get.mockImplementation((url) => {
      if (url.includes('watchlistpage_v2')) {
        return Promise.resolve({
          data: {
            items: [{ showId: 999, showName: 'Test Show', seasonIds: [100, 200] }],
            totalPages: 1,
            numberOfShows: 1
          }
        });
      }
      if (url.includes('/api/show/999')) {
        return Promise.resolve({
          data: {
            seasons: [
              { id: 100, seasonNumber: 1 },
              { id: 200, seasonNumber: 2 }
            ]
          }
        });
      }
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });

    const scraper = new SerializdScraper('https://www.serializd.com/user/dawescc/watchlist');
    const { items: series } = await scraper.getSeries();

    expect(series).toHaveLength(1);
    expect(series[0].seasons).toEqual([1, 2]);
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('/api/show/999'), 
      expect.anything()
    );
  });
});
