import { describe, expect, it } from "vitest";
import { LruCache } from "./lruCache";

describe("LruCache", () => {
    it("evicts the oldest entry once the limit is exceeded", () => {
        const cache = new LruCache<string, number>(2);

        expect(cache.set("a", 1)).toBe(0);
        expect(cache.set("b", 2)).toBe(0);
        expect(cache.set("c", 3)).toBe(1);

        expect(cache.has("a")).toBe(false);
        expect(cache.get("b")).toBe(2);
        expect(cache.get("c")).toBe(3);
    });

    it("refreshes recency on get", () => {
        const cache = new LruCache<string, number>(2);

        cache.set("a", 1);
        cache.set("b", 2);

        expect(cache.get("a")).toBe(1);
        cache.set("c", 3);

        expect(cache.has("a")).toBe(true);
        expect(cache.has("b")).toBe(false);
        expect(cache.has("c")).toBe(true);
    });

    it("updates existing keys without growing the cache", () => {
        const cache = new LruCache<string, number>(2);

        cache.set("a", 1);
        cache.set("b", 2);

        expect(cache.set("a", 10)).toBe(0);
        expect(cache.size).toBe(2);
        expect(cache.get("a")).toBe(10);
    });
});
