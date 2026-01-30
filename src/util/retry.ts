import logger from './logger';

import env from './env';

export async function retryOperation<T>(operation: () => Promise<T>, name: string, retries = 5, delay = 2000): Promise<T> {
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
