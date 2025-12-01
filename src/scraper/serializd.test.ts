import { SerializdScraper } from './serializd';
import puppeteer from 'puppeteer';

// Mock logger
jest.mock('../util/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// Mock puppeteer
jest.mock('puppeteer', () => ({
  launch: jest.fn(),
}));

describe('SerializdScraper', () => {
  let mockBrowser: any;
  let mockPage: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockPage = {
      setRequestInterception: jest.fn(),
      on: jest.fn(),
      goto: jest.fn(),
      waitForSelector: jest.fn(),
      evaluate: jest.fn(),
    };

    mockBrowser = {
      newPage: jest.fn().mockResolvedValue(mockPage),
      close: jest.fn(),
    };

    (puppeteer.launch as jest.Mock).mockResolvedValue(mockBrowser);
  });

  it('should scrape series from watchlist', async () => {
    const mockSeries = [
      {
        id: 73107,
        name: 'Barry',
        tmdbId: '73107',
        slug: 'Barry',
      },
    ];

    mockPage.evaluate.mockResolvedValue(mockSeries);

    const scraper = new SerializdScraper('https://www.serializd.com/user/dawescc/watchlist');
    const series = await scraper.getSeries();

    expect(series).toEqual(mockSeries);
    expect(puppeteer.launch).toHaveBeenCalled();
    expect(mockBrowser.newPage).toHaveBeenCalled();
    expect(mockPage.goto).toHaveBeenCalledWith(
      'https://www.serializd.com/user/dawescc/watchlist',
      { waitUntil: 'networkidle2' }
    );
    expect(mockBrowser.close).toHaveBeenCalled();
  });

  it('should handle errors gracefully', async () => {
    (puppeteer.launch as jest.Mock).mockRejectedValue(new Error('Browser launch failed'));

    const scraper = new SerializdScraper('https://www.serializd.com/user/dawescc/watchlist');

    await expect(scraper.getSeries()).rejects.toThrow('Browser launch failed');
  });
});
