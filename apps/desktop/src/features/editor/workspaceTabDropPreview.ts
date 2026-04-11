import type { WorkspaceMovePosition } from "../../app/store/workspaceLayoutTree";

export type WorkspaceTabDropPosition = "center" | WorkspaceMovePosition;

export interface CrossPaneTabDropPreview {
    sourcePaneId: string;
    targetPaneId: string;
    position: WorkspaceTabDropPosition;
    insertIndex: number | null;
    tabId: string;
}

export const CROSS_PANE_TAB_DROP_PREVIEW_EVENT =
    "neverwrite:cross-pane-tab-drop-preview";

const EDGE_DROP_ZONE_RATIO = 0.22;
const MIN_EDGE_DROP_ZONE_SIZE = 56;
const MAX_EDGE_DROP_ZONE_SIZE = 96;

export function dispatchCrossPaneTabDropPreview(
    detail: CrossPaneTabDropPreview | null,
) {
    window.dispatchEvent(
        new CustomEvent<CrossPaneTabDropPreview | null>(
            CROSS_PANE_TAB_DROP_PREVIEW_EVENT,
            {
                detail,
            },
        ),
    );
}

function getEdgeDropZoneSize(size: number) {
    return Math.min(
        MAX_EDGE_DROP_ZONE_SIZE,
        Math.max(MIN_EDGE_DROP_ZONE_SIZE, size * EDGE_DROP_ZONE_RATIO),
    );
}

export function resolvePaneDropPosition(
    clientX: number,
    clientY: number,
    rect: DOMRect | Pick<DOMRect, "left" | "right" | "top" | "bottom">,
): WorkspaceTabDropPosition {
    const width = Math.max(0, rect.right - rect.left);
    const height = Math.max(0, rect.bottom - rect.top);
    const horizontalEdgeZone = getEdgeDropZoneSize(width);
    const verticalEdgeZone = getEdgeDropZoneSize(height);
    const distances = [
        { position: "left" as const, distance: clientX - rect.left },
        { position: "right" as const, distance: rect.right - clientX },
        { position: "up" as const, distance: clientY - rect.top },
        { position: "down" as const, distance: rect.bottom - clientY },
    ].filter(({ position, distance }) => {
        if (distance < 0) {
            return false;
        }

        if (position === "left" || position === "right") {
            return distance <= horizontalEdgeZone;
        }

        return distance <= verticalEdgeZone;
    });

    if (distances.length === 0) {
        return "center";
    }

    distances.sort((left, right) => left.distance - right.distance);
    return distances[0]?.position ?? "center";
}
