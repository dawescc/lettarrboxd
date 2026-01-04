import env from '../util/env';
import logger from '../util/logger';

export type AppStatus = 'idle' | 'syncing' | 'error';
export type ComponentStatus = 'ok' | 'error' | 'disabled';

interface ComponentHealth {
    status: ComponentStatus;
    lastCheck: string | null;
    message?: string;
}

interface HealthState {
    status: 'ok' | 'error';
    appStatus: AppStatus;
    lastRunStr: string | null;
    lastRunTime: number | null;
    uptimeSeconds: number;
    components: Record<string, ComponentHealth>;
    isStale: boolean;
}

let currentAppStatus: AppStatus = 'idle';
let lastRunTime: number | null = null;
let syncStartTime: number | null = null;
const startTime = Date.now();

const components: Record<string, ComponentHealth> = {
    letterboxd: { status: 'disabled', lastCheck: null },
    radarr: { status: 'disabled', lastCheck: null },
    serializd: { status: 'disabled', lastCheck: null },
    sonarr: { status: 'disabled', lastCheck: null }
};

export function setAppStatus(status: AppStatus) {
    currentAppStatus = status;
    if (status === 'syncing') {
        syncStartTime = Date.now();
    }
    if (status === 'idle') {
        lastRunTime = Date.now();
        syncStartTime = null;
    }
}

export function updateComponentStatus(name: string, status: ComponentStatus, message?: string) {
    if (!components[name]) {
        components[name] = { status: 'disabled', lastCheck: null };
    }
    components[name] = {
        status,
        lastCheck: new Date().toISOString(),
        message
    };
}

export function startHealthServer(port: number = 3000) {
    logger.info(`Starting health check server on port ${port}...`);
    
    Bun.serve({
        port,
        fetch(req: Request) {
            const url = new URL(req.url);
            
            if (url.pathname === '/health') {
                const now = Date.now();
                // Staleness Check:
                // 1. If syncing for > 30 mins (likely stuck)
                // 2. If idle, but last run was > (Interval + 5 mins buffer) ago
                
                const intervalMs = (env as any).CHECK_INTERVAL_MINUTES * 60 * 1000;
                const staleThreshold = intervalMs + (5 * 60 * 1000); // Interval + 5 mins
                
                let isStale = false;
                
                // Check if stuck in syncing
                /* 
                   Note: simple timestamp check for syncing start would be better, 
                   but for now assuming if we haven't finished a run in a long time 
                   AND we are syncing, it might be stuck. 
                   Actually, let's just rely on lastRunTime.
                */

                // Staleness Check:
                // If we haven't successfully finished a run in (Interval + Buffer), something is wrong.
                // This covers:
                // 1. Scheduler died (IDLE for too long)
                // 2. Stuck in syncing (SYNCING for too long without finishing)
                // 3. Valid sync taking too long (User should increase interval in this case)
                
                if (lastRunTime) {
                    const timeSinceLastRun = now - lastRunTime;
                    if (timeSinceLastRun > staleThreshold) {
                        isStale = true;
                    }
                } else {
                     // First run handling
                     const timeSinceStart = now - startTime;
                     
                     // If we haven't finished the first run within the threshold, we are likely stuck or slow
                     if (timeSinceStart > staleThreshold && !lastRunTime) {
                         isStale = true;
                     }
                }

                // Strict Health Check:
                // 1. Staleness: If stuck syncing or scheduler died.
                // 2. Functional: If ANY component is in 'error' state.
                
                const hasComponentErrors = Object.values(components).some(c => c.status === 'error');
                const isHealthy = !isStale && !hasComponentErrors;

                const response: HealthState = {
                    status: isHealthy ? 'ok' : 'error',
                    appStatus: currentAppStatus,
                    lastRunStr: lastRunTime ? new Date(lastRunTime).toISOString() : null,
                    lastRunTime: lastRunTime,
                    uptimeSeconds: Math.floor((now - startTime) / 1000),
                    components,
                    isStale
                };
                
                return new Response(JSON.stringify(response, null, 2), {
                    status: isHealthy ? 200 : 500,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            
            return new Response('Not Found', { status: 404 });
        }
    });
}
