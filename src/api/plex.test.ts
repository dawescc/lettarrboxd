import { findItemByTmdbId, addLabels } from './plex';
import Axios from 'axios';
import config from '../util/config';

// Robust mocking: Auto-mock the module, then configure the mock instance
jest.mock('axios');
jest.mock('../util/config');
jest.mock('../util/logger', () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
    }
}));
jest.mock('../util/retry', () => ({
  retryOperation: (fn: Function) => fn()
}));

const mockedAxios = Axios as jest.Mocked<typeof Axios>;

// Define the mock client instance that Axios.create() will return
const mockClient = {
    get: jest.fn(),
    put: jest.fn(),
    defaults: { headers: { common: {} } },
    interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } }
};

// Configure Axios.create to return our mock client
// Use mockReturnValue (synchronous constant return)
mockedAxios.create.mockReturnValue(mockClient as any);

describe('Plex API', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        
        // Re-apply the mock return value in case it was cleared (though mockReturnValue persists usually)
        mockedAxios.create.mockReturnValue(mockClient as any);
        
        // Setup default config mock
        (config as any).plex = {
            url: 'http://plex:32400',
            token: 'test-token',
            tags: []
        };
    });

    describe('findItemByTmdbId', () => {
        it('should return ratingKey if found by Legacy Agent GUID', async () => {
             // Mock response for searchByGuid
             mockClient.get.mockResolvedValueOnce({
                 data: {
                     MediaContainer: {
                        Metadata: [
                            { ratingKey: '100', title: 'Test Movie', Guid: [{ id: 'com.plexapp.agents.themoviedb://12345?lang=en' }] }
                        ]
                     }
                 }
             });

             const result = await findItemByTmdbId('12345', 'Test Movie', 2020, 'movie');
             expect(result).toBe('100');
             expect(mockClient.get).toHaveBeenCalledWith('http://plex:32400/library/all', expect.objectContaining({
                 params: { guid: 'com.plexapp.agents.themoviedb://12345?lang=en' }
             }));
        });

        it('should fallback to title search if GUID fails', async () => {
            // 1. Legacy fail
            mockClient.get.mockResolvedValueOnce({ data: { MediaContainer: { Metadata: [] } } });
            // 2. Modern Movie fail
            mockClient.get.mockResolvedValueOnce({ data: { MediaContainer: { Metadata: [] } } });
            
            // 3. Title Search success
            mockClient.get.mockResolvedValueOnce({
                data: {
                    MediaContainer: {
                        Metadata: [
                            { 
                                ratingKey: '200', 
                                title: 'Test Movie', 
                                type: 'movie',
                                Guid: [{ id: 'tmdb://12345' }] 
                            }
                        ]
                    }
                }
            });

            const result = await findItemByTmdbId('12345', 'Test Movie', 2020, 'movie');
            expect(result).toBe('200');
        });
    });

    describe('addLabels', () => {
        it('should add new labels with atomic batch update', async () => {
            // 1. Get existing labels (mock)
            mockClient.get.mockResolvedValueOnce({
                data: {
                    MediaContainer: {
                        Metadata: [
                            { 
                                ratingKey: '100', 
                                title: 'Test Movie', 
                                Label: [{ tag: 'existing-tag' }] 
                            }
                        ]
                    }
                }
            });

            // 2. Put response
            mockClient.put.mockResolvedValueOnce({ status: 200, data: {} });

            await addLabels('100', ['new-tag'], 'movie');

            // Verify PUT URL
            expect(mockClient.put).toHaveBeenCalledTimes(1);
            const callArgs = mockClient.put.mock.calls[0];
            const url = callArgs[0];
            
            // Check for correct label structure
            expect(url).toContain('label[0].tag.tag=existing-tag');
            expect(url).toContain('label[1].tag.tag=new-tag');
            expect(url).toContain('type=1');
        });

        it('should deduplicate tags and skip if no new tags', async () => {
            // 1. Get existing labels
            mockClient.get.mockResolvedValueOnce({
                data: {
                    MediaContainer: {
                        Metadata: [
                            { ratingKey: '100', Label: [{ tag: 'existing-tag' }] }
                        ]
                    }
                }
            });

            await addLabels('100', ['existing-tag'], 'movie');

            // Expect NO put calls
            expect(mockClient.put).not.toHaveBeenCalled();
        });
    });
});
