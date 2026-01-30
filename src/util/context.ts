import { AsyncLocalStorage } from 'async_hooks';

interface JobContext {
    jobId?: string;
}

export const jobContext = new AsyncLocalStorage<JobContext>();

export function getJobId(): string | undefined {
    const store = jobContext.getStore();
    return store?.jobId;
}

export function runWithJobId<T>(jobId: string, callback: () => T): T {
    return jobContext.run({ jobId }, callback);
}
