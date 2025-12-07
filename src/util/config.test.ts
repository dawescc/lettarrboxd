import fs from 'fs';
import { z } from 'zod';

// Explicit mocks
const mockExistsSync = jest.fn();
const mockReadFileSync = jest.fn();

jest.mock('fs', () => ({
  __esModule: true,
  default: {
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
  },
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
}));

jest.mock('./logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  }
}));

// Mock env
let mockEnv = {
    LETTERBOXD_URL: 'https://env-letterboxd',
    SERIALIZD_URL: 'https://env-serializd',
    DRY_RUN: false,
    LETTERBOXD_TAKE_AMOUNT: 10,
    LETTERBOXD_TAKE_STRATEGY: 'newest'
};

jest.mock('./env', () => {
    return {
        __esModule: true,
        default: new Proxy({}, {
            get: (target, prop) => mockEnv[prop as keyof typeof mockEnv]
        })
    };
});

describe('Config Loader', () => {
    let mockExit: jest.SpyInstance;

    beforeEach(() => {
        jest.clearAllMocks();
        // Make process.exit throw so we stop execution
        mockExit = jest.spyOn(process, 'exit').mockImplementation(((code: number) => {
            throw new Error(`Process.exit called with ${code}`);
        }) as any);
        
        jest.resetModules();
        
        // Reset defaults
        mockEnv = {
            LETTERBOXD_URL: 'https://env-letterboxd',
            SERIALIZD_URL: 'https://env-serializd',
            DRY_RUN: false,
            LETTERBOXD_TAKE_AMOUNT: 10,
            LETTERBOXD_TAKE_STRATEGY: 'newest'
        } as any;
    });

    afterEach(() => {
        mockExit.mockRestore();
    });

    it('should load config from src/config/config.yaml if it exists', () => {
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue(`
letterboxd:
  - url: https://yaml-list
    tags: [yaml]
`);
        
        const config = require('./config').default;
        
        expect(config.letterboxd).toHaveLength(1);
        expect(config.letterboxd[0].url).toBe('https://yaml-list');
        expect(config.letterboxd[0].tags).toEqual(['yaml']);
    });

    it('should fallback to Env variables if config file missing', () => {
        mockExistsSync.mockReturnValue(false); 

        const config = require('./config').default;

        expect(config.letterboxd).toHaveLength(1);
        expect(config.letterboxd[0].id).toBe('env-letterboxd');
    });

    it('should exit if YAML is invalid', () => {
        mockExistsSync.mockReturnValue(true);
        // Invalid URL
        mockReadFileSync.mockReturnValue(`
letterboxd:
  - url: not-a-url
`); 

        expect(() => {
             require('./config');
        }).toThrow('Process.exit called with 1');
    });
});
