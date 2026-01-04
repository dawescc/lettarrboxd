
import { processLists } from './index';
import * as plex from './api/plex';
import * as health from './api/health';
import { LetterboxdMovie } from './scraper';

// Mocks
jest.mock('./api/plex');
jest.mock('./api/health');
jest.mock('./util/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }
}));

describe('Safety Lock Mechanism', () => {
    const mockSyncItemsFn = jest.fn();
    const mockFetchItemsFn = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should ACTIVATE safety lock (abortCleanup=true) if an UNTAGGED list fails alongside a valid list', async () => {
        // Arrange
        const lists = [
            { url: 'https://letterboxd.com/user/untagged-list/', tags: [] }, // Fails
            { url: 'https://letterboxd.com/user/valid-list/', tags: ['valid'] } // Succeeds
        ];

        mockFetchItemsFn.mockImplementation(async (list) => {
            if (list.url.includes('untagged-list')) {
                return { items: [], hasErrors: true };
            }
            return { items: [{ name: 'Good Movie', tmdbId: '123', tags: ['valid'] }], hasErrors: false };
        });

        // Act
        await processLists<LetterboxdMovie>(
            lists,
            'letterboxd',
            mockFetchItemsFn,
            mockSyncItemsFn,
            'movie',
            []
        );

        // Assert
        expect(mockSyncItemsFn).toHaveBeenCalledWith(
            expect.anything(), // items
            expect.anything(), // managedTags
            expect.anything(), // unsafeTags
            true // abortCleanup MUST BE TRUE
        );
    });

    it('should NOT activate safety lock (abortCleanup=false) if a TAGGED list fails alongside a valid list', async () => {
        // Arrange
        const lists = [
            { url: 'https://letterboxd.com/user/tagged-list/', tags: ['my-safe-tag'] }, // Fails
            { url: 'https://letterboxd.com/user/valid-list/', tags: ['valid'] } // Succeeds
        ];

        mockFetchItemsFn.mockImplementation(async (list) => {
            if (list.url.includes('tagged-list')) {
                return { items: [], hasErrors: true };
            }
            return { items: [{ name: 'Good Movie', tmdbId: '123', tags: ['valid'] }], hasErrors: false };
        });

        // Act
        await processLists<LetterboxdMovie>(
            lists,
            'letterboxd',
            mockFetchItemsFn,
            mockSyncItemsFn,
            'movie',
            []
        );

        // Assert
        expect(mockSyncItemsFn).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.any(Set),
            false // abortCleanup MUST BE FALSE
        );
        
        // Verify the tag was marked unsafe
        const unsafeTags = mockSyncItemsFn.mock.calls[0][2];
        expect(unsafeTags.has('my-safe-tag')).toBe(true);
    });

    it('should ACTIVATE safety lock if items missing IDs come from an UNTAGGED list', async () => {
        // Arrange
        const lists = [{
            url: 'https://letterboxd.com/user/untagged-bad-items/',
            tags: [] 
        }];

        mockFetchItemsFn.mockResolvedValue({
            items: [{ name: 'Bad Movie', tmdbId: null }], // Missing ID - technically "found" so uniqueItems > 0 if we allowed nulls, but we filter them out... wait
            // index.ts:
            // for (const item of items) {
            //   if (!item.tmdbId) { ... continue } 
            // }
            // So if only bad items exist, uniqueItems is 0.
            // We need a good item too.
            hasErrors: false 
        });

        // We need a helper to injecting a good list to ensure sync runs
         const mixedLists = [
            { url: 'https://letterboxd.com/user/untagged-bad-items/', tags: [] },
            { url: 'https://letterboxd.com/user/valid-list/', tags: ['valid'] }
        ];

        mockFetchItemsFn.mockImplementation(async (list) => {
            if (list.url.includes('untagged-bad-items')) {
                return { items: [{ name: 'Bad Movie', tmdbId: null }], hasErrors: false };
            }
            return { items: [{ name: 'Good Movie', tmdbId: '123', tags: ['valid'] }], hasErrors: false };
        });

        // Act
        await processLists<LetterboxdMovie>(
            mixedLists,
            'letterboxd',
            mockFetchItemsFn,
            mockSyncItemsFn,
            'movie',
            []
        );

        // Assert
        expect(mockSyncItemsFn).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.anything(),
            true // abortCleanup MUST BE TRUE
        );
    });

    it('should NOT activate safety lock if items missing IDs come from a TAGGED list', async () => {
        // Arrange
        const lists = [
            { url: 'https://letterboxd.com/user/tagged-bad-items/', tags: ['safe-tag'] },
            { url: 'https://letterboxd.com/user/valid-list/', tags: ['valid'] }
        ];

        mockFetchItemsFn.mockImplementation(async (list) => {
            if (list.url.includes('tagged-bad-items')) {
                return { items: [{ name: 'Bad Movie', tmdbId: null }], hasErrors: false };
            }
            return { items: [{ name: 'Good Movie', tmdbId: '123', tags: ['valid'] }], hasErrors: false };
        });

        // Act
        await processLists<LetterboxdMovie>(
            lists,
            'letterboxd',
            mockFetchItemsFn,
            mockSyncItemsFn,
            'movie',
            []
        );

        // Assert
        expect(mockSyncItemsFn).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.any(Set),
            false // abortCleanup MUST BE FALSE
        );

        const unsafeTags = mockSyncItemsFn.mock.calls[0][2];
        expect(unsafeTags.has('safe-tag')).toBe(true);
    });
});
