
import logger from './logger';
import env from './env';

/**
 * An adaptive concurrency queue.
 * Automatically adjusts concurrency limits based on task success/failure.
 * Starts safe (2), ramps up on success (AIMD-like), backs off on failure.
 */
export class TaskQueue {
    private running = 0;
    private queue: Array<() => void> = [];
    
    // Adaptive controls
    private concurrency = 2; // Initial safer default
    private minConcurrency = 1;
    private maxConcurrency = 20; // Hard max
    private successfulTasksInRow = 0;
    private rampUpThreshold = 5; // Increase concurrency after this many successes

    constructor(initialConcurrency: number = 2) {
        this.concurrency = initialConcurrency;
    }

    /**
     * Add a task to the queue.
     * @param task A function that returns a promise.
     * @returns A promise that resolves with the task's result.
     */
    add<T>(task: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const runner = async () => {
                this.running++;
                try {
                    const result = await task();
                    this.recordSuccess();
                    resolve(result);
                } catch (error) {
                    this.recordFailure();
                    reject(error);
                } finally {
                    this.running--;
                    this.next();
                }
            };

            if (this.running < this.concurrency) {
                runner();
            } else {
                this.queue.push(runner);
            }
        });
    }

    private next() {
        while (this.running < this.concurrency && this.queue.length > 0) {
            const nextTask = this.queue.shift();
            if (nextTask) nextTask();
        }
    }

    // Adaptive Logic
    
    private recordSuccess() {
        this.successfulTasksInRow++;
        if (this.successfulTasksInRow > this.rampUpThreshold) {
            this.successfulTasksInRow = 0;
            if (this.concurrency < this.maxConcurrency) {
                this.concurrency++;
                if (env.GRANULAR_LOGGING) logger.info(`[GRANULAR] Increasing concurrency to ${this.concurrency}`);
                this.next(); // Try to start more if pending
            }
        }
    }

    private recordFailure() {
        this.successfulTasksInRow = 0;
        if (this.concurrency > this.minConcurrency) {
            const newLimit = Math.max(this.minConcurrency, Math.floor(this.concurrency / 2));
            if (newLimit < this.concurrency) {
                this.concurrency = newLimit;
                logger.warn(`[Queue] Detected failure. Backing off concurrency to ${this.concurrency}`);
            }
        }
    }

    get active() {
        return this.running;
    }
}
