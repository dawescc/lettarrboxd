import { TaskQueue } from './queue';

export async function mapConcurrency<T, R>(
    items: T[],
    fn: (item: T) => Promise<R>,
    concurrencyOrQueue: number | TaskQueue
): Promise<R[]> {
    const queue = typeof concurrencyOrQueue === 'number' 
        ? new TaskQueue(concurrencyOrQueue) 
        : concurrencyOrQueue;

    const promises = items.map(item => queue.add(() => fn(item)));
    return Promise.all(promises);
}
