
import config from '../util/config';

// Types for our module functions
type FindItemFn = (id: string) => Promise<string | null>;
type AddLabelFn = (key: string, label: string) => Promise<void>;

describe('Plex API', () => {
    let findItemByTmdbId: FindItemFn;
    let addLabel: AddLabelFn;
    let mockGet: jest.Mock;
    let mockPut: jest.Mock;

    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();

        mockGet = jest.fn();
        mockPut = jest.fn();

        // 1. Mock Axios using doMock to avoid hoisting
        jest.doMock('axios', () => ({
            create: jest.fn(() => ({
                get: mockGet,
                put: mockPut
            })),
            default: {
                create: jest.fn(() => ({
                    get: mockGet,
                    put: mockPut
                }))
            }
        }));

        // 2. Mock Config
        // Ensure TS default import compatibility
        jest.doMock('../util/config', () => ({
            __esModule: true,
            default: {
                plex: {
                    url: 'http://plex.test',
                    token: 'test-token',
                    tags: ['lettarrboxd']
                }
            }
        }));

        // 3. Mock Logger
        jest.doMock('../util/logger', () => ({
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(), // Console.warn to debug
            error: jest.fn((msg, err) => console.error(msg, err)), // Log errors
        }));
        
        jest.doMock('../util/retry', () => ({
            retryOperation: jest.fn((fn) => fn())
        }));

        // 4. Require the module under test
        const plexModule = require('./plex');
        findItemByTmdbId = plexModule.findItemByTmdbId;
        addLabel = plexModule.addLabel;
    });

    describe('findItemByTmdbId', () => {
        it('should return ratingKey when item is found', async () => {
            mockGet.mockResolvedValue({
                data: {
                    MediaContainer: {
                        Metadata: [
                            { ratingKey: '12345', title: 'Test Movie' }
                        ]
                    }
                }
            });

            const result = await findItemByTmdbId('999');
            expect(result).toBe('12345');
            
            // Check headers/params
            expect(mockGet).toHaveBeenCalledWith('http://plex.test/library/all', expect.objectContaining({
                headers: expect.objectContaining({ 'X-Plex-Token': 'test-token' }),
                params: expect.objectContaining({
                    guid: 'com.plexapp.agents.themoviedb://999?lang=en'
                })
            }));
        });

        it('should return null when no item is found', async () => {
            mockGet.mockResolvedValue({
                data: {
                    MediaContainer: {
                        Metadata: []
                    }
                }
            });

            const result = await findItemByTmdbId('999');
            expect(result).toBeNull();
        });

        it('should return null on error', async () => {
             mockGet.mockRejectedValue(new Error('Network Error'));
             const result = await findItemByTmdbId('999');
             expect(result).toBeNull();
        });
    });

    describe('addLabel', () => {
        it('should add label if it does not exist', async () => {
            // Mock finding existing labels
            mockGet.mockResolvedValue({
                data: {
                    MediaContainer: {
                        Metadata: [
                            { 
                                title: 'Test Movie',
                                Label: [{ tag: 'existing' }] 
                            }
                        ]
                    }
                }
            });

            await addLabel('12345', 'new-label');

            expect(mockPut).toHaveBeenCalledWith(
                'http://plex.test/library/metadata/12345',
                null, 
                expect.objectContaining({
                   params: expect.any(URLSearchParams) 
                })
            );
            
            // Verify params contains new label
            const callArgs = mockPut.mock.calls[0];
            const params = callArgs[2].params as URLSearchParams;
            expect(params.getAll('label[0].tag.value')).toContain('existing');
            // Since we use new URLSearchParams in the code, the index might vary or key might be explicit.
            // My code: params.append(`label[${i}].tag.value`, l);
            // existing -> 0, new-label -> 1
            expect(params.get('label[0].tag.value')).toBe('existing');
            expect(params.get('label[1].tag.value')).toBe('new-label');
        });

        it('should skip if label already exists', async () => {
            mockGet.mockResolvedValue({
                data: {
                    MediaContainer: {
                        Metadata: [
                            { 
                                title: 'Test Movie',
                                Label: [{ tag: 'existing' }, { tag: 'new-label' }] 
                            }
                        ]
                    }
                }
            });

            await addLabel('12345', 'new-label');

            expect(mockPut).not.toHaveBeenCalled();
        });
    });
});
