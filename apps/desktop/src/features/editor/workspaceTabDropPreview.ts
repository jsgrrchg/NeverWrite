import type { WorkspaceDropTarget } from "../../app/store/workspaceContracts";
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

function isPointInsideRect(
    clientX: number,
    clientY: number,
    rect: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
) {
    return (
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom
    );
}

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

export function resolvePaneStripDropIndex(strip: HTMLElement, clientX: number) {
    const tabNodes = Array.from(
        strip.querySelectorAll<HTMLElement>("[data-pane-tab-id]"),
    );
    if (tabNodes.length === 0) {
        return 0;
    }

    for (const [index, tabNode] of tabNodes.entries()) {
        const rect = tabNode.getBoundingClientRect();
        const midpoint = rect.left + rect.width / 2;
        if (clientX < midpoint) {
            return index;
        }
    }

    return tabNodes.length;
}

export function resolveWorkspaceTabDropTarget({
    sourcePaneId,
    tabId: _tabId,
    clientX,
    clientY,
}: {
    sourcePaneId: string | null;
    tabId: string;
    clientX: number;
    clientY: number;
}): WorkspaceDropTarget {
    if (!sourcePaneId) {
        return { type: "none" };
    }

    const paneNodes = Array.from(
        document.querySelectorAll<HTMLElement>("[data-editor-pane-id]"),
    );

    for (const paneNode of paneNodes) {
        const paneId = paneNode.dataset.editorPaneId ?? null;
        if (!paneId) {
            continue;
        }

        const paneRect = paneNode.getBoundingClientRect();
        if (!isPointInsideRect(clientX, clientY, paneRect)) {
            continue;
        }

        const strip = paneNode.querySelector<HTMLElement>(
            `[data-pane-tab-strip="${paneId}"]`,
        );
        if (strip) {
            const stripRect = strip.getBoundingClientRect();
            if (isPointInsideRect(clientX, clientY, stripRect)) {
                if (paneId === sourcePaneId) {
                    return { type: "none" };
                }

                return {
                    type: "strip",
                    paneId,
                    index: resolvePaneStripDropIndex(strip, clientX),
                };
            }
        }

        const position = resolvePaneDropPosition(clientX, clientY, paneRect);
        if (position === "center") {
            return {
                type: "pane-center",
                paneId,
            };
        }

        return {
            type: "split",
            paneId,
            direction: position,
        };
    }

    return { type: "none" };
}

export function toCrossPaneTabDropPreview(
    sourcePaneId: string,
    tabId: string,
    target: WorkspaceDropTarget,
): CrossPaneTabDropPreview | null {
    switch (target.type) {
        case "strip":
            return {
                sourcePaneId,
                targetPaneId: target.paneId,
                position: "center",
                insertIndex: target.index,
                tabId,
            };
        case "pane-center":
            if (target.paneId === sourcePaneId) {
                return null;
            }
            return {
                sourcePaneId,
                targetPaneId: target.paneId,
                position: "center",
                insertIndex: null,
                tabId,
            };
        case "split":
            return {
                sourcePaneId,
                targetPaneId: target.paneId,
                position: target.direction,
                insertIndex: null,
                tabId,
            };
        default:
            return null;
    }
}
