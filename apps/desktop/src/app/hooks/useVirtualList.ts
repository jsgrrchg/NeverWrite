import { useEffect, useMemo, useState, type RefObject } from "react";

export interface VirtualWindow {
    startIndex: number;
    endIndex: number;
    offsetTop: number;
    totalHeight: number;
}

export function useVirtualList(
    container: RefObject<HTMLElement | null>,
    itemCount: number,
    rowHeight: number,
    overscan = 6,
): VirtualWindow {
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportHeight, setViewportHeight] = useState(0);

    useEffect(() => {
        const element = container.current;
        if (!element) return;

        const sync = () => {
            setScrollTop(element.scrollTop);
            setViewportHeight(element.clientHeight);
        };

        sync();
        element.addEventListener("scroll", sync, { passive: true });
        window.addEventListener("resize", sync);

        return () => {
            element.removeEventListener("scroll", sync);
            window.removeEventListener("resize", sync);
        };
    }, [container]);

    return useMemo(() => {
        if (itemCount <= 0) {
            return {
                startIndex: 0,
                endIndex: 0,
                offsetTop: 0,
                totalHeight: 0,
            };
        }

        const visibleCount = Math.max(
            1,
            Math.ceil((viewportHeight || rowHeight) / rowHeight),
        );
        const firstVisible = Math.max(0, Math.floor(scrollTop / rowHeight));
        const startIndex = Math.max(0, firstVisible - overscan);
        const endIndex = Math.min(
            itemCount,
            firstVisible + visibleCount + overscan,
        );

        return {
            startIndex,
            endIndex,
            offsetTop: startIndex * rowHeight,
            totalHeight: itemCount * rowHeight,
        };
    }, [itemCount, overscan, rowHeight, scrollTop, viewportHeight]);
}
