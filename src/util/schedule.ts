import logger from './logger';

interface ScheduleConfig {
    activeFrom?: string; // "MM-DD"
    activeUntil?: string; // "MM-DD"
}

/**
 * Checks if a list is currently active based on its schedule.
 * If no schedule is defined, it returns true (always active).
 * 
 * @param config Object containing optional activeFrom and activeUntil strings
 * @param currentDate Optional date to check against (defaults to now)
 * @returns boolean
 */
export function isListActive(config: ScheduleConfig, currentDate: Date = new Date()): boolean {
    if (!config.activeFrom && !config.activeUntil) {
        return true;
    }

    const currentYear = currentDate.getFullYear();
    const currentMonth = currentDate.getMonth(); // 0-indexed
    const currentDay = currentDate.getDate();

    // Helper to parse "MM-DD"
    const parseDate = (dateStr: string): Date => {
        const [month, day] = dateStr.split('-').map(Number);
        // Create date for current year
        // Note: Month is 0-indexed in JS Date
        return new Date(currentYear, month - 1, day);
    };

    let fromDate: Date | null = null;
    let untilDate: Date | null = null;

    if (config.activeFrom) {
        fromDate = parseDate(config.activeFrom);
    }

    if (config.activeUntil) {
        untilDate = parseDate(config.activeUntil);
    }

    // Normalizing current date for comparison (ignore time)
    const now = new Date(currentYear, currentMonth, currentDay);

    // Case 1: Wrap-around (e.g. Dec 1 to Jan 31)
    if (fromDate && untilDate && fromDate > untilDate) {
         return now >= fromDate || now <= untilDate;
    }

    // Case 2: Standard Range (e.g. Jan 1 to Jan 31) or Open-ended
    if (fromDate && now < fromDate) {
        return false;
    }

    if (untilDate && now > untilDate) {
        return false;
    }

    return true;
}
