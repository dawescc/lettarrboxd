export async function mapConcurrency<T, R>(
    items: T[],
    fn: (item: T) => Promise<R>,
    concurrency: number
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    const iterator = items.entries();

    const workers = Array(Math.min(items.length, concurrency)).fill(null).map(async () => {
        for (const [index, item] of iterator) {
            results[index] = await fn(item);
        }
    });

    await Promise.all(workers);
    return results;
}
