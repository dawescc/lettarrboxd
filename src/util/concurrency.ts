import { TaskQueue } from './queue';
import { runWithJobId } from './context';

export async function mapConcurrency<T, R>(
    items: T[],
    fn: (item: T) => Promise<R>,
    concurrencyOrQueue: number | TaskQueue
): Promise<R[]> {
    const queue = typeof concurrencyOrQueue === 'number' 
        ? new TaskQueue(concurrencyOrQueue) 
        : concurrencyOrQueue;

    const promises = items.map(item => {
        const jobId = Math.random().toString(36).substring(2, 8);
        return queue.add(() => runWithJobId(jobId, () => fn(item)), jobId);
    });
    return Promise.all(promises);
}
