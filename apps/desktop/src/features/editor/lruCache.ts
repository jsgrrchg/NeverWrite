export class LruCache<K, V> {
    private readonly entries = new Map<K, V>();
    private readonly maxEntries: number;

    constructor(maxEntries: number) {
        if (!Number.isInteger(maxEntries) || maxEntries < 1) {
            throw new Error("LruCache maxEntries must be a positive integer");
        }

        this.maxEntries = maxEntries;
    }

    get size() {
        return this.entries.size;
    }

    clear() {
        this.entries.clear();
    }

    delete(key: K) {
        return this.entries.delete(key);
    }

    has(key: K) {
        return this.entries.has(key);
    }

    get(key: K) {
        if (!this.entries.has(key)) {
            return undefined;
        }

        const value = this.entries.get(key) as V;
        this.entries.delete(key);
        this.entries.set(key, value);
        return value;
    }

    set(key: K, value: V) {
        if (this.entries.has(key)) {
            this.entries.delete(key);
        }

        this.entries.set(key, value);

        let evicted = 0;
        while (this.entries.size > this.maxEntries) {
            const oldestKey = this.entries.keys().next().value;
            if (oldestKey === undefined) {
                break;
            }
            this.entries.delete(oldestKey);
            evicted += 1;
        }

        return evicted;
    }

    keys() {
        return this.entries.keys();
    }
}
