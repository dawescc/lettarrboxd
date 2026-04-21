import logger from './logger';

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timeout of ${ms}ms exceeded for ${label}`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

interface RetryConfig {
    retries?: number;
    delay?: number;
    attemptTimeoutMs?: number;
    maxDelayMs?: number;
}

export async function retryOperation<T>(
    operation: () => Promise<T>,
    name: string,
    configOrRetries: RetryConfig | number = 5,
    delayArg: number = 2000
): Promise<T> {
    let retries = 5;
    let delay = 2000;
    let attemptTimeoutMs: number | undefined;
    const maxDelayMs = 30000;

    if (typeof configOrRetries === 'number') {
        retries = configOrRetries;
        delay = delayArg;
    } else if (configOrRetries) {
        retries = configOrRetries.retries ?? 5;
        delay = configOrRetries.delay ?? 2000;
        attemptTimeoutMs = configOrRetries.attemptTimeoutMs;
    }

    for (let i = 0; i < retries; i++) {
        try {
            logger.debug(`Starting operation: ${name}`);
            const attempt = attemptTimeoutMs
                ? withTimeout(operation(), attemptTimeoutMs, name)
                : operation();
            const result = await attempt;
            logger.debug(`Finished operation: ${name}`);
            return result;
        } catch (error) {
            if (i === retries - 1) throw error;
            const waitMs = Math.min(delay * Math.pow(2, i), maxDelayMs);
            logger.warn(`Failed to ${name}, retrying in ${waitMs / 1000}s... (${i + 1}/${retries})`);
            await new Promise(resolve => setTimeout(resolve, waitMs));
        }
    }
    throw new Error(`Failed to ${name} after ${retries} retries`);
}
