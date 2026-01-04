import { loadConfig } from './config';
import fs from 'fs';
import env from './env';

// Mock fs and env
jest.mock('fs');
jest.mock('./env', () => ({
  // Default mocks, will be overridden
  LETTERBOXD_URL: 'http://test',
  LOG_LEVEL: 'info',
  RADARR_TAGS: undefined,
  SONARR_TAGS: undefined,
  PLEX_URL: undefined
}));
jest.mock('./logger', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn()
    }
}));


describe('Config Loader', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Reset env overrides
        (env as any).RADARR_TAGS = undefined;
        (env as any).SONARR_TAGS = undefined;
        (env as any).LETTERBOXD_URL = undefined;
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
