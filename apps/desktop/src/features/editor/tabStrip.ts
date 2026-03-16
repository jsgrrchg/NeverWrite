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
