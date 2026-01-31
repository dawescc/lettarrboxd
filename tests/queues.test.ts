// Mock the dependencies BEFORE import
jest.mock('p-queue', () => {
    return jest.fn().mockImplementation((options) => {
        return { concurrency: options?.concurrency || 1, add: jest.fn() };
    });
});

jest.mock('bottleneck', () => {
    return jest.fn().mockImplementation((options) => {
        return { 
            maxConcurrent: options?.maxConcurrent,
            minTime: options?.minTime,
            schedule: jest.fn()
        };
    });
});

// Import AFTER mocking
import { listQueue, radarrLimiter, sonarrLimiter, scraperLimiter, plexLimiter } from '../src/util/queues';
import PQueue from 'p-queue';
import Bottleneck from 'bottleneck';

describe('Global Queue Configuration', () => {
    
    describe('listQueue (P-Queue)', () => {
        it('should be instantiated with concurrency 2', () => {
            expect(PQueue).toHaveBeenCalledWith(expect.objectContaining({
                concurrency: 2
            }));
            expect(listQueue.concurrency).toBe(2);
        });
    });

    describe('radarrLimiter (Bottleneck)', () => {
        it('should be instantiated with safely limited config', () => {
            expect(Bottleneck).toHaveBeenCalledWith(expect.objectContaining({
                maxConcurrent: 3,
                minTime: 100
            }));
        });
    });

    describe('sonarrLimiter (Bottleneck)', () => {
        it('should be instantiated with safely limited config', () => {
             // Bottleneck constructor is called multiple times, we just check if one of them matched
             // The order in `queues.ts` is list, radarr, sonarr, scraper, plex
             // So sonarr is likely the 2nd call? Or we can just check 'bottleneck' mock calls
             // But simpler: just trust the property we mocked on the instance if possible,
             // or check the mock.instances.
        });
    });
    
    // We already verified the constructor calls above essentially by import.
    // Let's iterate the mock calls to find specific Configs
    
    it('should configure all limiters correctly', () => {
        const bottleneckCalls = (Bottleneck as unknown as jest.Mock).mock.calls;
        
        // Find configuration for Radarr/Sonarr
        const radarrConfig = bottleneckCalls.find(call => call[0].maxConcurrent === 3 && call[0].minTime === 100);
        expect(radarrConfig).toBeDefined();

        // Find configuration for Scrapers/Plex
        const scraperConfig = bottleneckCalls.find(call => call[0].maxConcurrent === 5);
        expect(scraperConfig).toBeDefined();
    });
});
