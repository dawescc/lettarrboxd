import logger from './logger';

import env from './env';

export async function retryOperation<T>(
    operation: () => Promise<T>, 
    name: string, 
    configOrRetries: { retries?: number, delay?: number } | number = 5, 
    delayArg: number = 2000
): Promise<T> {
    let retries = 5;
    let delay = 2000;

    if (typeof configOrRetries === 'number') {
        retries = configOrRetries;
        delay = delayArg;
    } else if (configOrRetries) {
        retries = configOrRetries.retries ?? 5;
        delay = configOrRetries.delay ?? 2000;
    }

    for (let i = 0; i < retries; i++) {
        try {
            if (env.GRANULAR_LOGGING) logger.info(`[GRANULAR] Starting operation: ${name}`);
            const result = await operation();
            if (env.GRANULAR_LOGGING) logger.info(`[GRANULAR] Finished operation: ${name}`);
            return result;
        } catch (error) {
            if (i === retries - 1) throw error;
            logger.warn(`Failed to ${name}, retrying in ${delay / 1000}s... (${i + 1}/${retries})`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw new Error(`Failed to ${name} after ${retries} retries`);
}

