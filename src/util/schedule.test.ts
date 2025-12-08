import { isListActive } from './schedule';

describe('isListActive', () => {
    // Helper to create a specific date for testing
    const createDate = (month: number, day: number, year: number = 2023) => {
        // Month is 0-indexed in JS Date Constructor if using numbers, 
        // but let's use the same logic as our source code implies or simply string parsing to be safe?
        // Actually, createDate(2023, 0, 1) is Jan 1. 
        return new Date(year, month - 1, day);
    };

    const currentYear = new Date().getFullYear();

    it('should return true if no schedule is defined', () => {
        expect(isListActive({})).toBe(true);
    });

    it('should return true if current date is within range', () => {
        const config = { activeFrom: '01-01', activeUntil: '01-31' };
        // Jan 15
        const date = createDate(1, 15, currentYear);
        expect(isListActive(config, date)).toBe(true);
    });

    it('should return true if current date is exactly start date', () => {
        const config = { activeFrom: '01-01', activeUntil: '01-31' };
        const date = createDate(1, 1, currentYear);
        expect(isListActive(config, date)).toBe(true);
    });

    it('should return true if current date is exactly end date', () => {
        const config = { activeFrom: '01-01', activeUntil: '01-31' };
        const date = createDate(1, 31, currentYear);
        expect(isListActive(config, date)).toBe(true);
    });

    it('should return false if current date is before start date', () => {
        const config = { activeFrom: '02-01', activeUntil: '02-28' };
        // Jan 31
        const date = createDate(1, 31, currentYear);
        expect(isListActive(config, date)).toBe(false);
    });

    it('should return false if current date is after end date', () => {
        const config = { activeFrom: '02-01', activeUntil: '02-28' };
        // March 1
        const date = createDate(3, 1, currentYear);
        expect(isListActive(config, date)).toBe(false);
    });

    it('should handle open-ended start (only From defined)', () => {
        const config = { activeFrom: '06-01' };
        
        // May 31 (False)
        expect(isListActive(config, createDate(5, 31, currentYear))).toBe(false);
        // June 1 (True)
        expect(isListActive(config, createDate(6, 1, currentYear))).toBe(true);
        // Dec 31 (True)
        expect(isListActive(config, createDate(12, 31, currentYear))).toBe(true);
    });

    it('should handle open-ended end (only Until defined)', () => {
        const config = { activeUntil: '06-01' };
        
        // Jan 1 (True)
        expect(isListActive(config, createDate(1, 1, currentYear))).toBe(true);
        // June 1 (True)
        expect(isListActive(config, createDate(6, 1, currentYear))).toBe(true);
        // June 2 (False)
        expect(isListActive(config, createDate(6, 2, currentYear))).toBe(false);
    });

    it('should handle year wrap-around (e.g. Dec to Jan)', () => {
        const config = { activeFrom: '12-01', activeUntil: '01-31' };

        // Dec 15 (True)
        expect(isListActive(config, createDate(12, 15, currentYear))).toBe(true);
        
        // Jan 15 (True)
        expect(isListActive(config, createDate(1, 15, currentYear))).toBe(true);

        // Feb 1 (False)
        expect(isListActive(config, createDate(2, 1, currentYear))).toBe(false); // After end
        
         // Nov 30 (False)
        expect(isListActive(config, createDate(11, 30, currentYear))).toBe(false); // Before start
    });
});
