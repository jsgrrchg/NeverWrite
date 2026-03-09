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
