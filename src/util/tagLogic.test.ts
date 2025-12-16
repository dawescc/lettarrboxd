import { calculateNextTags, calculateNextTagIds } from './tagLogic';

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

        it('should handle case-insensitive matching if enabled', () => {
            const current = ['Christmas', 'My-Tag'];
            const managed = new Set(['christmas']); // Lowercase in config
            const next = ['watchlist'];
            
            // With caseInsensitive = true
            const result = calculateNextTags(current, managed, next, true);
            expect(result).toContain('My-Tag');
            expect(result).toContain('watchlist');
            expect(result).not.toContain('Christmas'); // Should be removed matching 'christmas'
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
