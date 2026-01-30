
import { calculateNextTags, calculateNextTagIds } from '../src/util/tagLogic';
import { loadConfig } from '../src/util/config';
import fs from 'fs';

// Mock fs and env for config tests
jest.mock('fs');
jest.mock('../src/util/env', () => ({
    __esModule: true,
    default: {
        RADARR_TAGS: undefined,
        SONARR_TAGS: undefined,
        LETTERBOXD_URL: undefined,
        SERIALIZD_URL: undefined,
        PLEX_URL: undefined,
        PLEX_TOKEN: undefined,
        PLEX_TAGS: undefined,
        DRY_RUN: false,
    }
}));

import env from '../src/util/env';


jest.mock('../src/util/logger', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn()
    }
}));


describe('Core Logic Tests', () => {

    describe('Tag Logic', () => {
        describe('calculateNextTags (Strings for Plex)', () => {
            it('should add new managed tags', () => {
                const current: string[] = [];
                const managed = new Set(['christmas', 'watchlist']);
                const next = ['christmas'];
                
                const result = calculateNextTags(current, managed, next);
                expect(result).toEqual(['christmas']);
            });

            it('should remove stale managed tags', () => {
                const current = ['christmas', 'watchlist'];
                const managed = new Set(['christmas', 'watchlist']);
                const next = ['watchlist']; // Christmas removed from list
                
                const result = calculateNextTags(current, managed, next);
                expect(result).toContain('watchlist');
                expect(result).not.toContain('christmas');
                expect(result.length).toBe(1);
            });

            it('should preserve user manual tags', () => {
                const current = ['christmas', 'my-custom-tag'];
                const managed = new Set(['christmas', 'watchlist']);
                const next = ['watchlist']; // Swapped lists
                
                const result = calculateNextTags(current, managed, next);
                expect(result).toContain('my-custom-tag'); // Preserved!
                expect(result).toContain('watchlist');     // Added
                expect(result).not.toContain('christmas'); // Removed
            });

            it('should not touch tags if managed list is empty', () => {
                const current = ['christmas'];
                const managed = new Set<string>(); // No managed tags known
                const next = ['watchlist'];
                
                const result = calculateNextTags(current, managed, next);
                expect(result).toContain('christmas'); // Preserved because we didn't know it was managed
                expect(result).toContain('watchlist');
            });
        });

        describe('calculateNextTagIds (Numbers for Radarr/Sonarr)', () => {
            it('should handle numeric IDs correctly', () => {
                const current = [10, 20, 99]; // 99 is manual
                const managed = new Set([10, 20, 30]);
                const next = [20, 30]; // 10 removed, 20 kept, 30 added
                
                const result = calculateNextTagIds(current, managed, next);
                
                expect(result).toContain(20);
                expect(result).toContain(30);
                expect(result).toContain(99); // Preserved
                expect(result).not.toContain(10); // Removed
            });
        });
    });

    describe('Config Logic', () => {
        beforeEach(() => {
            jest.clearAllMocks();
            // Reset mock env
            (env as any).RADARR_TAGS = undefined;
            (env as any).SONARR_TAGS = undefined;
        });

        it('should inject RADARR_TAGS from env into config', () => {
            // Setup no config file
            (fs.existsSync as jest.Mock).mockReturnValue(false);
            (env as any).RADARR_TAGS = 'watchlist';

            const config = loadConfig();

            expect(config.radarr?.tags).toContain('watchlist');
        });

        it('should merge ENV tags with Config tags', () => {
            // Setup config file exist
            (fs.existsSync as jest.Mock).mockReturnValue(true);
            (fs.readFileSync as jest.Mock).mockReturnValue(`
letterboxd: []
serializd: []
radarr:
  tags:
    - existing
            `);
            (env as any).RADARR_TAGS = 'new-tag';

            const config = loadConfig();

            expect(config.radarr?.tags).toEqual(['existing', 'new-tag']);
        });
    });
});
