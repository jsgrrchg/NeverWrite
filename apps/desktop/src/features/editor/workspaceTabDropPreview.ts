import type { WorkspaceDropTarget } from "../../app/store/workspaceContracts";
import type { WorkspaceMovePosition } from "../../app/store/workspaceLayoutTree";

export type WorkspaceTabDropPosition = "center" | WorkspaceMovePosition;

export interface WorkspaceDropPreviewRect {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
}

export interface CrossPaneTabDropPreview {
    sourcePaneId: string;
    targetPaneId: string;
    position: WorkspaceTabDropPosition;
    insertIndex: number | null;
    tabId: string;
    overlayRect: WorkspaceDropPreviewRect | null;
    lineRect: WorkspaceDropPreviewRect | null;
}

export const CROSS_PANE_TAB_DROP_PREVIEW_EVENT =
    "neverwrite:cross-pane-tab-drop-preview";

const EDGE_DROP_ZONE_RATIO = 0.22;
const MIN_EDGE_DROP_ZONE_SIZE = 56;
const MAX_EDGE_DROP_ZONE_SIZE = 96;
const CENTER_PREVIEW_INSET_PX = 6;
const STRIP_PREVIEW_INSET_Y_PX = 4;
const SPLIT_PREVIEW_RATIO = 0.42;
const MIN_SPLIT_PREVIEW_SIZE = 72;

function roundPreviewValue(value: number) {
    return Math.round(value * 1000) / 1000;
}

function normalizePreviewRect(
    rect: WorkspaceDropPreviewRect,
): WorkspaceDropPreviewRect {
    return {
        left: roundPreviewValue(rect.left),
        top: roundPreviewValue(rect.top),
        right: roundPreviewValue(rect.right),
        bottom: roundPreviewValue(rect.bottom),
        width: roundPreviewValue(rect.width),
        height: roundPreviewValue(rect.height),
    };
}

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

function rectFromDom(
    rect:
        | DOMRect
        | Pick<
              DOMRect,
              "left" | "right" | "top" | "bottom" | "width" | "height"
          >,
): WorkspaceDropPreviewRect {
    const width = rect.width ?? Math.max(0, rect.right - rect.left);
    const height = rect.height ?? Math.max(0, rect.bottom - rect.top);

    return normalizePreviewRect({
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width,
        height,
    });
}

function insetRect(
    rect: WorkspaceDropPreviewRect,
    inset: number,
): WorkspaceDropPreviewRect {
    return normalizePreviewRect({
        left: rect.left + inset,
        top: rect.top + inset,
        right: rect.right - inset,
        bottom: rect.bottom - inset,
        width: Math.max(rect.width - inset * 2, 0),
        height: Math.max(rect.height - inset * 2, 0),
    });
}

function buildSplitPreviewRect(
    paneRect: WorkspaceDropPreviewRect,
    direction: WorkspaceMovePosition,
): WorkspaceDropPreviewRect {
    const previewWidth = Math.max(
        paneRect.width * SPLIT_PREVIEW_RATIO,
        MIN_SPLIT_PREVIEW_SIZE,
    );
    const previewHeight = Math.max(
        paneRect.height * SPLIT_PREVIEW_RATIO,
        MIN_SPLIT_PREVIEW_SIZE,
    );

    switch (direction) {
        case "left":
            return normalizePreviewRect({
                ...paneRect,
                right: paneRect.left + previewWidth,
                width: previewWidth,
            });
        case "right":
            return normalizePreviewRect({
                ...paneRect,
                left: paneRect.right - previewWidth,
                width: previewWidth,
            });
        case "up":
            return normalizePreviewRect({
                ...paneRect,
                bottom: paneRect.top + previewHeight,
                height: previewHeight,
            });
        case "down":
            return normalizePreviewRect({
                ...paneRect,
                top: paneRect.bottom - previewHeight,
                height: previewHeight,
            });
    }
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

function buildPaneStripDropLineRect(
    strip: HTMLElement,
    insertIndex: number,
    draggedTabId: string,
) {
    const stripRect = rectFromDom(strip.getBoundingClientRect());
    const tabNodes = Array.from(
        strip.querySelectorAll<HTMLElement>("[data-pane-tab-id]"),
    ).filter((tabNode) => tabNode.dataset.paneTabId !== draggedTabId);

    let lineLeft = stripRect.left + 12;
    if (tabNodes.length > 0) {
        if (insertIndex === 0) {
            lineLeft = rectFromDom(tabNodes[0]!.getBoundingClientRect()).left;
        } else if (insertIndex >= tabNodes.length) {
            lineLeft = rectFromDom(
                tabNodes[tabNodes.length - 1]!.getBoundingClientRect(),
            ).right;
        } else {
            lineLeft = rectFromDom(
                tabNodes[insertIndex]!.getBoundingClientRect(),
            ).left;
        }
    }

    return normalizePreviewRect({
        left: lineLeft - 1,
        right: lineLeft + 1,
        top: stripRect.top + STRIP_PREVIEW_INSET_Y_PX,
        bottom: stripRect.bottom - STRIP_PREVIEW_INSET_Y_PX,
        width: 2,
        height: Math.max(stripRect.height - STRIP_PREVIEW_INSET_Y_PX * 2, 16),
    } satisfies WorkspaceDropPreviewRect);
}

function buildCrossPaneTabDropPreview(
    sourcePaneId: string,
    tabId: string,
    target: WorkspaceDropTarget,
): CrossPaneTabDropPreview | null {
    switch (target.type) {
        case "strip": {
            const strip = document.querySelector<HTMLElement>(
                `[data-pane-tab-strip="${target.paneId}"]`,
            );
            if (!strip) {
                return null;
            }

            return {
                sourcePaneId,
                targetPaneId: target.paneId,
                position: "center",
                insertIndex: target.index,
                tabId,
                overlayRect: null,
                lineRect: buildPaneStripDropLineRect(
                    strip,
                    target.index,
                    tabId,
                ),
            };
        }
        case "pane-center": {
            if (target.paneId === sourcePaneId) {
                return null;
            }

            const paneNode = document.querySelector<HTMLElement>(
                `[data-editor-pane-id="${target.paneId}"]`,
            );
            if (!paneNode) {
                return null;
            }

            return {
                sourcePaneId,
                targetPaneId: target.paneId,
                position: "center",
                insertIndex: null,
                tabId,
                overlayRect: insetRect(
                    rectFromDom(paneNode.getBoundingClientRect()),
                    CENTER_PREVIEW_INSET_PX,
                ),
                lineRect: null,
            };
        }
        case "split": {
            const paneNode = document.querySelector<HTMLElement>(
                `[data-editor-pane-id="${target.paneId}"]`,
            );
            if (!paneNode) {
                return null;
            }

            return {
                sourcePaneId,
                targetPaneId: target.paneId,
                position: target.direction,
                insertIndex: null,
                tabId,
                overlayRect: buildSplitPreviewRect(
                    rectFromDom(paneNode.getBoundingClientRect()),
                    target.direction,
                ),
                lineRect: null,
            };
        }
        default:
            return null;
    }
}

export function resolveWorkspaceTabDropIntent({
    sourcePaneId,
    tabId,
    clientX,
    clientY,
}: {
    sourcePaneId: string | null;
    tabId: string;
    clientX: number;
    clientY: number;
}): { target: WorkspaceDropTarget; preview: CrossPaneTabDropPreview | null } {
    const target = resolveWorkspaceTabDropTarget({
        sourcePaneId,
        tabId,
        clientX,
        clientY,
    });

    if (!sourcePaneId) {
        return { target, preview: null };
    }

    return {
        target,
        preview: buildCrossPaneTabDropPreview(sourcePaneId, tabId, target),
    };
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
    return buildCrossPaneTabDropPreview(sourcePaneId, tabId, target);
}
