
import { addSeries, getSeriesLookup, getSeriesLookupByTitle } from './sonarr'; // We need to export addSeries/getSeriesLookup for testing or test indirectly? 
// addSeries is not exported in sonarr.ts, it's used by syncSeries.
// Wait, addSeries IS NOT exported in the file I viewed earlier?
// Let me check lines 483...
// "async function addSeries" -> it is NOT exported.

// I can test getSeriesLookup and getSeriesLookupByTitle easily. Use those.
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
        // 1. Mock getSeriesLookup (ID) to return null
        // Since we mock axios, we need to mock the implementation of getSeriesLookup? 
        // No, getSeriesLookup calls axios. We mock axios.
        
        // First call: ID lookup -> returns []
        // Second call: Title lookup -> returns [{ ... }]
        // Third call: POST to add
        
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
