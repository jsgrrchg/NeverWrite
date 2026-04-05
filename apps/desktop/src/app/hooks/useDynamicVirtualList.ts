import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";

export interface DynamicVirtualListItem<T> {
    index: number;
    item: T;
    key: string;
    start: number;
    size: number;
}

export interface DynamicVirtualListWindow<T> {
    items: DynamicVirtualListItem<T>[];
    totalSize: number;
    startIndex: number;
    endIndex: number;
    getMeasureRef: (key: string) => (node: HTMLElement | null) => void;
}

interface UseDynamicVirtualListOptions<T> {
    container: RefObject<HTMLElement | null>;
    items: T[];
    getItemKey: (item: T, index: number) => string;
    estimateSize: (item: T, index: number) => number;
    itemGap?: number;
    overscan?: number;
    measurementVersion?: string | number;
}

function findFirstEndAfter(ends: number[], value: number) {
    let low = 0;
    let high = ends.length;

    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (ends[mid] > value) {
            high = mid;
        } else {
            low = mid + 1;
        }
    }

    return low;
}

function findFirstStartAtOrAfter(starts: number[], value: number) {
    let low = 0;
    let high = starts.length;

    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (starts[mid] >= value) {
            high = mid;
        } else {
            low = mid + 1;
        }
    }

    return low;
}

export function useDynamicVirtualList<T>({
    container,
    items,
    getItemKey,
    estimateSize,
    itemGap = 0,
    overscan = 6,
    measurementVersion,
}: UseDynamicVirtualListOptions<T>): DynamicVirtualListWindow<T> {
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportHeight, setViewportHeight] = useState(0);
    const [measuredSizes, setMeasuredSizes] = useState<Record<string, number>>(
        {},
    );
    const observersRef = useRef(new Map<string, ResizeObserver>());
    const measureRefsRef = useRef(
        new Map<string, (node: HTMLElement | null) => void>(),
    );

    useEffect(() => {
        const element = container.current;
        if (!element) return;

        const sync = () => {
            setScrollTop(element.scrollTop);
            setViewportHeight(element.clientHeight);
        };

        let resizeObserver: ResizeObserver | null = null;
        sync();
        element.addEventListener("scroll", sync, { passive: true });
        window.addEventListener("resize", sync);
        if (typeof ResizeObserver === "function") {
            resizeObserver = new ResizeObserver(() => {
                sync();
            });
            resizeObserver.observe(element);
        }

        return () => {
            element.removeEventListener("scroll", sync);
            window.removeEventListener("resize", sync);
            resizeObserver?.disconnect();
        };
    }, [container]);

    useEffect(
        () => () => {
            observersRef.current.forEach((observer) => observer.disconnect());
            observersRef.current.clear();
        },
        [],
    );

    useEffect(() => {
        queueMicrotask(() => {
            setMeasuredSizes((current) => {
                if (Object.keys(current).length === 0) {
                    return current;
                }
                return {};
            });
        });
    }, [measurementVersion]);

    useEffect(() => {
        const activeKeys = new Set(
            items.map((item, index) => getItemKey(item, index)),
        );

        observersRef.current.forEach((observer, key) => {
            if (activeKeys.has(key)) {
                return;
            }
            observer.disconnect();
            observersRef.current.delete(key);
        });

        measureRefsRef.current.forEach((_callback, key) => {
            if (!activeKeys.has(key)) {
                measureRefsRef.current.delete(key);
            }
        });

        queueMicrotask(() => {
            setMeasuredSizes((current) => {
                let changed = false;
                const next: Record<string, number> = {};

                for (const [key, size] of Object.entries(current)) {
                    if (!activeKeys.has(key)) {
                        changed = true;
                        continue;
                    }
                    next[key] = size;
                }

                return changed ? next : current;
            });
        });
    }, [getItemKey, items]);

    const getMeasureRef = useCallback((key: string) => {
        const existing = measureRefsRef.current.get(key);
        if (existing) {
            return existing;
        }

        const callback = (node: HTMLElement | null) => {
            observersRef.current.get(key)?.disconnect();
            observersRef.current.delete(key);

            if (!node) {
                return;
            }

            const measure = () => {
                const nextHeight = Math.ceil(
                    node.getBoundingClientRect().height ||
                        node.offsetHeight ||
                        0,
                );
                if (nextHeight <= 0) return;

                setMeasuredSizes((current) => {
                    if (current[key] === nextHeight) {
                        return current;
                    }
                    return {
                        ...current,
                        [key]: nextHeight,
                    };
                });
            };

            measure();

            if (typeof ResizeObserver === "function") {
                const observer = new ResizeObserver(() => {
                    measure();
                });
                observer.observe(node);
                observersRef.current.set(key, observer);
            }
        };

        measureRefsRef.current.set(key, callback);
        return callback;
    }, []);

    return useMemo(() => {
        if (items.length === 0) {
            return {
                items: [],
                totalSize: 0,
                startIndex: 0,
                endIndex: 0,
                getMeasureRef,
            };
        }

        const starts = new Array<number>(items.length);
        const ends = new Array<number>(items.length);
        const sizes = new Array<number>(items.length);
        const keys = new Array<string>(items.length);
        let cursor = 0;

        for (let index = 0; index < items.length; index += 1) {
            const item = items[index];
            const key = getItemKey(item, index);
            const size = measuredSizes[key] ?? estimateSize(item, index);
            keys[index] = key;
            sizes[index] = size;
            starts[index] = cursor;
            ends[index] = cursor + size;
            cursor = ends[index] + itemGap;
        }

        const totalSize = cursor;
        const viewportEnd = scrollTop + viewportHeight;
        const firstVisible = Math.min(
            items.length - 1,
            findFirstEndAfter(ends, scrollTop),
        );
        const lastVisibleExclusive = Math.max(
            firstVisible + 1,
            findFirstStartAtOrAfter(starts, viewportEnd),
        );
        const startIndex = Math.max(0, firstVisible - overscan);
        const endIndex = Math.min(
            items.length,
            lastVisibleExclusive + overscan,
        );
        const virtualItems: DynamicVirtualListItem<T>[] = [];

        for (let index = startIndex; index < endIndex; index += 1) {
            virtualItems.push({
                index,
                item: items[index],
                key: keys[index],
                start: starts[index],
                size: sizes[index],
            });
        }

        return {
            items: virtualItems,
            totalSize,
            startIndex,
            endIndex,
            getMeasureRef,
        };
    }, [
        estimateSize,
        getItemKey,
        getMeasureRef,
        itemGap,
        items,
        measuredSizes,
        overscan,
        scrollTop,
        viewportHeight,
    ]);
}
