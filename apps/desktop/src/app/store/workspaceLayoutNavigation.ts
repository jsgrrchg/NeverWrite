import type {
    WorkspaceLayoutNode,
    WorkspaceMovePosition,
} from "./workspaceLayoutTree";

type WorkspaceNeighborDirection = WorkspaceMovePosition;

interface PaneRect {
    paneId: string;
    left: number;
    top: number;
    right: number;
    bottom: number;
}

const RECT_EPSILON = 1e-6;

function collectPaneRects(
    tree: WorkspaceLayoutNode,
    left = 0,
    top = 0,
    width = 1,
    height = 1,
    rects: PaneRect[] = [],
) {
    if (tree.type === "pane") {
        rects.push({
            paneId: tree.paneId,
            left,
            top,
            right: left + width,
            bottom: top + height,
        });
        return rects;
    }

    let cursor = 0;
    tree.children.forEach((child, index) => {
        const size = tree.sizes[index] ?? 0;
        if (tree.direction === "row") {
            collectPaneRects(
                child,
                left + width * cursor,
                top,
                width * size,
                height,
                rects,
            );
        } else {
            collectPaneRects(
                child,
                left,
                top + height * cursor,
                width,
                height * size,
                rects,
            );
        }
        cursor += size;
    });
    return rects;
}

function getOverlap(sourceStart: number, sourceEnd: number, targetStart: number, targetEnd: number) {
    return Math.max(
        0,
        Math.min(sourceEnd, targetEnd) - Math.max(sourceStart, targetStart),
    );
}

export function findAdjacentPane(
    tree: WorkspaceLayoutNode,
    paneId: string,
    direction: WorkspaceNeighborDirection,
) {
    const rects = collectPaneRects(tree);
    const source = rects.find((rect) => rect.paneId === paneId);
    if (!source) {
        return null;
    }

    const candidates = rects
        .filter((candidate) => candidate.paneId !== paneId)
        .map((candidate) => {
            switch (direction) {
                case "left": {
                    const distance = source.left - candidate.right;
                    const overlap = getOverlap(
                        source.top,
                        source.bottom,
                        candidate.top,
                        candidate.bottom,
                    );
                    return { candidate, distance, overlap };
                }
                case "right": {
                    const distance = candidate.left - source.right;
                    const overlap = getOverlap(
                        source.top,
                        source.bottom,
                        candidate.top,
                        candidate.bottom,
                    );
                    return { candidate, distance, overlap };
                }
                case "up": {
                    const distance = source.top - candidate.bottom;
                    const overlap = getOverlap(
                        source.left,
                        source.right,
                        candidate.left,
                        candidate.right,
                    );
                    return { candidate, distance, overlap };
                }
                case "down": {
                    const distance = candidate.top - source.bottom;
                    const overlap = getOverlap(
                        source.left,
                        source.right,
                        candidate.left,
                        candidate.right,
                    );
                    return { candidate, distance, overlap };
                }
            }
        })
        .filter(
            (entry) =>
                entry.distance >= -RECT_EPSILON && entry.overlap > RECT_EPSILON,
        )
        .sort((left, right) => {
            if (Math.abs(left.distance - right.distance) > RECT_EPSILON) {
                return left.distance - right.distance;
            }
            if (Math.abs(left.overlap - right.overlap) > RECT_EPSILON) {
                return right.overlap - left.overlap;
            }

            const leftCenter =
                (left.candidate.left + left.candidate.right) / 2 +
                (left.candidate.top + left.candidate.bottom) / 2;
            const rightCenter =
                (right.candidate.left + right.candidate.right) / 2 +
                (right.candidate.top + right.candidate.bottom) / 2;
            return leftCenter - rightCenter;
        });

    return candidates[0]?.candidate.paneId ?? null;
}
