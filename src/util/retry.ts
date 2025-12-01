import logger from './logger';

export async function retryOperation<T>(operation: () => Promise<T>, name: string, retries = 5, delay = 2000): Promise<T> {
    for (let i = 0; i < retries; i++) {
        try {
            return await operation();
        } catch (error) {
            if (i === retries - 1) throw error;
            logger.warn(`Failed to ${name}, retrying in ${delay / 1000}s... (${i + 1}/${retries})`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw new Error(`Failed to ${name} after ${retries} retries`);
}
