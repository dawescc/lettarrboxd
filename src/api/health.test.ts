
import { startHealthServer, setAppStatus, updateComponentStatus } from './health';
import env from '../util/env';

// Mock logger
jest.mock('../util/logger', () => ({
  info: jest.fn(),
  error: jest.fn()
}));

// Mock env
jest.mock('../util/env', () => ({
  __esModule: true,
  default: {
    CHECK_INTERVAL_MINUTES: 10
  }
}));

// Mock Bun.serve
const mockFetch = jest.fn();
(global as any).Bun = {
  serve: jest.fn((options) => {
    mockFetch.mockImplementation(options.fetch);
    return {
      stop: jest.fn()
    };
  })
};

describe('Health Check', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Reset state if possible? 
        // Since module state is singleton-ish, we might need to rely on setters
        setAppStatus('idle');
    });

    it('should start server on port 3000', () => {
        startHealthServer(3000);
        expect((global as any).Bun.serve).toHaveBeenCalledWith(expect.objectContaining({ port: 3000 }));
    });

    it('should return 200 OK for /health', async () => {
        startHealthServer();
        const req = new Request('http://localhost:3000/health');
        const res = await mockFetch(req);
        
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.status).toBe('ok');
        expect(data.components).toBeDefined();
    });

    it('should return stale error if syncing for too long', async () => {
        // We can't easily advance Date.now() in imported module without complex mocking or refactoring.
        // For now, let's skip complex time manipulation tests and focus on logic correctness via code review
        // or refactor health.ts to accept a time provider.
        
        // Actually, we can use jest.useFakeTimers and spyOn Date.now
        jest.useFakeTimers();
        const now = 1000000000000;
        jest.setSystemTime(now);
        
        setAppStatus('idle'); // Set lastRunTime to now
        
        // Move forward 20 minutes (Interval 10 + 5 buffer = 15 threshold)
        jest.setSystemTime(now + 20 * 60 * 1000); 
        
        const req = new Request('http://localhost:3000/health');
        const res = await mockFetch(req);
        
        // It should be stale because we are IDLE but last run was > 15 mins ago
        expect(res.status).toBe(500);
        const data = await res.json();
        expect(data.status).toBe('error');
        expect(data.isStale).toBe(true);
        
        jest.useRealTimers();
    });
    
    it('should update component status', async () => {
        updateComponentStatus('radarr', 'error', 'Connection failed');
        
        const req = new Request('http://localhost:3000/health');
        const res = await mockFetch(req);
        const data = await res.json();
        
        expect(data.components.radarr.status).toBe('error');
        expect(data.components.radarr.message).toBe('Connection failed');
    });

    it('should return 500 error if any component is in error state', async () => {
        updateComponentStatus('radarr', 'error', 'Critical failure');
        
        const req = new Request('http://localhost:3000/health');
        const res = await mockFetch(req);
        
        expect(res.status).toBe(500);
        const data = await res.json();
        expect(data.status).toBe('error');
    });
});
