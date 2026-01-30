import { addSeries, getSeriesLookup, getSeriesLookupByTitle } from './sonarr';
import Axios from 'axios';

// Mock axios
const mockAxiosInstance = {
  get: jest.fn(),
  post: jest.fn()
};

jest.mock('axios', () => ({
  create: jest.fn(() => mockAxiosInstance),
  default: {
    create: jest.fn(() => mockAxiosInstance)
  }
}));

import * as sonarr from './sonarr';

describe('Sonarr Title Fallback', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('getSeriesLookupByTitle should call correct endpoint', async () => {
        mockAxiosInstance.get.mockResolvedValueOnce({ data: [{ title: 'Test Show', tvdbId: 12345 }] });
        
        const res = await sonarr.getSeriesLookupByTitle('Test Show');
        
        expect(mockAxiosInstance.get).toHaveBeenCalledWith('/api/v3/series/lookup', {
            params: { term: 'Test Show' }
        });
        expect(res).toHaveLength(1);
        expect(res[0].tvdbId).toBe(12345);
    });

    it('addSeries should fallback to title search if TMDB ID lookup fails', async () => {
        // Mock sequence:
        // 1. ID lookup -> returns empty (Not Found)
        // 2. Title lookup -> returns match
        // 3. POST to add series
        
        mockAxiosInstance.get
            .mockResolvedValueOnce({ data: [] }) // ID lookup fails
            .mockResolvedValueOnce({ data: [{ 
                title: 'Test Show', 
                tvdbId: 12345, 
                seasons: [{ seasonNumber: 1, monitored: true }]
            }] }); // Title lookup succeeds

        mockAxiosInstance.post.mockResolvedValueOnce({ data: { id: 999, title: 'Test Show' } });

        const item = {
            id: 1,
            name: 'Test Show',
            tmdbId: '100', // invalid or not found id
            slug: 'test-show'
        };

        const result = await sonarr.addSeries(
            item as any,
            1, // profile
            '/tv',
            [],
            [] // cache
        );

        // Verify ID lookup called
        expect(mockAxiosInstance.get).toHaveBeenNthCalledWith(1, '/api/v3/series/lookup', {
            params: { term: 'tmdb:100' }
        });

        // Verify Title lookup called
        expect(mockAxiosInstance.get).toHaveBeenNthCalledWith(2, '/api/v3/series/lookup', {
            params: { term: 'Test Show' }
        });

        // Verify POST called
        expect(mockAxiosInstance.post).toHaveBeenCalled();
        expect(result?.tvdbId).toBe(12345);
        expect(result?.wasAdded).toBe(true);
    });
});
