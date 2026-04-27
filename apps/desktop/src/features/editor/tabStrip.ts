import { useLayoutEffect, type RefObject } from "react";

const TAB_REVEAL_PADDING = 12;

export function getTabStripScrollTarget({
    stripLeft,
    stripWidth,
    scrollWidth,
    nodeLeft,
    nodeWidth,
    padding = TAB_REVEAL_PADDING,
}: {
    stripLeft: number;
    stripWidth: number;
    scrollWidth: number;
    nodeLeft: number;
    nodeWidth: number;
    padding?: number;
}) {
    const nodeRight = nodeLeft + nodeWidth;
    const visibleLeft = stripLeft + padding;
    const visibleRight = stripLeft + stripWidth - padding;

    if (nodeLeft < visibleLeft) {
        return Math.max(0, nodeLeft - padding);
    }

    if (nodeRight > visibleRight) {
        return Math.max(
            0,
            Math.min(
                nodeRight - stripWidth + padding,
                Math.max(0, scrollWidth - stripWidth),
            ),
        );
    }

    return null;
}

export function getTabStripInsertIndex(
    clientX: number,
    tabRects: Array<{ left: number; width: number }>,
) {
    for (let index = 0; index < tabRects.length; index += 1) {
        const rect = tabRects[index];
        if (clientX < rect.left + rect.width / 2) {
            return index;
        }
    }

    return tabRects.length;
}

export function getTabStripDropIndex(
    strip: HTMLElement | null,
    clientX: number,
) {
    if (!strip) return 0;

    const tabRects = Array.from(
        strip.querySelectorAll<HTMLElement>("[data-tab-id]"),
    ).map((tab) => {
        const rect = tab.getBoundingClientRect();
        return {
            left: rect.left,
            width: rect.width,
        };
    });

    return getTabStripInsertIndex(clientX, tabRects);
}

function escapeCssValue(value: string) {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
        return CSS.escape(value);
    }

    return value.replace(/["\\]/g, "\\$&");
}

function revealActiveTabInStrip({
    strip,
    activeTabId,
    tabIdAttribute,
}: {
    strip: HTMLElement;
    activeTabId: string;
    tabIdAttribute: string;
}) {
    const activeNode = strip.querySelector<HTMLElement>(
        `[${tabIdAttribute}="${escapeCssValue(activeTabId)}"]`,
    );
    if (!activeNode) return;

    const target = getTabStripScrollTarget({
        stripLeft: strip.scrollLeft,
        stripWidth: strip.clientWidth,
        scrollWidth: strip.scrollWidth,
        nodeLeft: activeNode.offsetLeft,
        nodeWidth: activeNode.offsetWidth,
    });

    if (target === null || Math.abs(target - strip.scrollLeft) < 1) {
        return;
    }

    if (typeof strip.scrollTo === "function") {
        strip.scrollTo({
            left: target,
            behavior: "auto",
        });
        return;
    }

    strip.scrollLeft = target;
}

export function useActiveTabStripReveal({
    stripRef,
    activeTabId,
    draggingTabId,
    tabOrderKey,
    tabIdAttribute,
}: {
    stripRef: RefObject<HTMLDivElement | null>;
    activeTabId: string | null;
    draggingTabId: string | null;
    tabOrderKey: string;
    tabIdAttribute: string;
}) {
    useLayoutEffect(() => {
        if (!activeTabId || draggingTabId) return;

        const strip = stripRef.current;
        if (!strip) return;

        let disposed = false;
        let frame: number | null = null;
        let resizeObserver: ResizeObserver | null = null;

        const reveal = () => {
            if (disposed) return;
            revealActiveTabInStrip({
                strip,
                activeTabId,
                tabIdAttribute,
            });
        };

        const scheduleReveal = () => {
            if (disposed || frame !== null) return;
            frame = window.requestAnimationFrame(() => {
                frame = null;
                reveal();
            });
        };

        reveal();
        scheduleReveal();

        if (typeof ResizeObserver !== "undefined") {
            resizeObserver = new ResizeObserver(scheduleReveal);
            resizeObserver.observe(strip);
        }

        window.addEventListener("resize", scheduleReveal);

        return () => {
            disposed = true;
            if (frame !== null) {
                window.cancelAnimationFrame(frame);
            }
            resizeObserver?.disconnect();
            window.removeEventListener("resize", scheduleReveal);
        };
    }, [
        activeTabId,
        draggingTabId,
        stripRef,
        tabIdAttribute,
        tabOrderKey,
    ]);
}
