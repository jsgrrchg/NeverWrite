import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from "react";
import type { WorkspaceDropTarget } from "../../app/store/workspaceContracts";
import {
    emitFileTreeNoteDrag,
    type FileTreeNoteDragDetail,
} from "../ai/dragEvents";
import { useTabDragReorder } from "./useTabDragReorder";
import {
    dispatchCrossPaneTabDropPreview,
    resolveWorkspaceTabDropIntent,
    type CrossPaneTabDropPreview,
} from "./workspaceTabDropPreview";

interface DragTabLike {
    id: string;
}

interface DragCoordinates {
    clientX: number;
    clientY: number;
    screenX: number;
    screenY: number;
}

type LayoutWorkspaceDropTarget = Extract<
    WorkspaceDropTarget,
    { type: "strip" | "pane-center" | "split" }
>;
type ExternalWorkspaceDropTarget = Extract<
    WorkspaceDropTarget,
    { type: "composer" | "detach-window" }
>;

interface UseWorkspaceTabDragOptions<TTab extends DragTabLike> {
    tabs: TTab[];
    sourcePaneId?: string | null;
    onCommitReorder: (fromIndex: number, toIndex: number) => void;
    onCommitWorkspaceDrop?: (
        tabId: string,
        target: LayoutWorkspaceDropTarget,
    ) => void;
    onCommitExternalDrop?: (
        tabId: string,
        target: ExternalWorkspaceDropTarget,
        coords: DragCoordinates,
    ) => Promise<void> | void;
    resolveExternalDropTarget?: (
        tabId: string,
        coords: { clientX: number; clientY: number },
    ) => WorkspaceDropTarget;
    onActivate?: (tabId: string) => void;
    liveReorder?: boolean;
    shouldDetach?: (clientX: number, clientY: number) => boolean;
    shouldCommitDrag?: (tabId: string, coords: DragCoordinates) => boolean;
    onDetachStart?: (
        tabId: string,
        coords: { screenX: number; screenY: number },
    ) => Promise<void> | void;
    onDetachMove?: (coords: { screenX: number; screenY: number }) => void;
    onDetachEnd?: (
        tabId: string,
        coords: { screenX: number; screenY: number },
    ) => Promise<void> | void;
    onDetachCancel?: () => void;
    buildAttachmentDetail?: (
        tabId: string,
        phase: "start" | "move" | "end",
        coords: { clientX: number; clientY: number },
    ) => FileTreeNoteDragDetail | null;
}

function isLayoutWorkspaceDropTarget(
    target: WorkspaceDropTarget,
): target is LayoutWorkspaceDropTarget {
    return (
        target.type === "strip" ||
        target.type === "pane-center" ||
        target.type === "split"
    );
}

function getPreviewSignature(
    target: WorkspaceDropTarget,
    preview: CrossPaneTabDropPreview | null,
) {
    if (preview?.lineRect) {
        const { left, top, width, height } = preview.lineRect;
        return `line:${preview.targetPaneId}:${preview.insertIndex}:${left}:${top}:${width}:${height}`;
    }

    if (preview?.overlayRect) {
        const { left, top, width, height } = preview.overlayRect;
        return `overlay:${preview.targetPaneId}:${preview.position}:${left}:${top}:${width}:${height}`;
    }

    if (target.type === "none") {
        return "none";
    }

    return `hidden:${target.type}`;
}

/**
 * Central authority for pointer-based workspace tab drags.
 *
 * It keeps the pointer-session mechanics in `useTabDragReorder`, but moves the
 * shared orchestration here so every tab surface resolves the same drag intent.
 */
export function useWorkspaceTabDrag<TTab extends DragTabLike>({
    tabs,
    sourcePaneId,
    onCommitReorder,
    onCommitWorkspaceDrop,
    onCommitExternalDrop,
    resolveExternalDropTarget,
    onActivate,
    liveReorder = false,
    shouldDetach,
    shouldCommitDrag,
    onDetachStart,
    onDetachMove,
    onDetachEnd,
    onDetachCancel,
    buildAttachmentDetail,
}: UseWorkspaceTabDragOptions<TTab>) {
    const [dragPreviewTabId, setDragPreviewTabId] = useState<string | null>(
        null,
    );
    const dragPreviewNodeRef = useRef<HTMLDivElement | null>(null);
    const dragPreviewPosRef = useRef({ clientX: 0, clientY: 0 });
    const dragPreviewFrameRef = useRef<number | null>(null);
    const internalDragActiveRef = useRef(false);
    const activeDragTabIdRef = useRef<string | null>(null);
    const latestDragCoordsRef = useRef<DragCoordinates>({
        clientX: 0,
        clientY: 0,
        screenX: 0,
        screenY: 0,
    });
    const pendingDetachDropTargetRef =
        useRef<ExternalWorkspaceDropTarget | null>(null);
    const detachEndHandledByDragEndRef = useRef(false);
    const dragDropHandledRef = useRef(false);
    const workspaceDropTargetRef = useRef<WorkspaceDropTarget>({
        type: "none",
    });
    const workspacePreviewSignatureRef = useRef<string>("none");

    const applyDragPreviewPosition = useCallback(() => {
        dragPreviewFrameRef.current = null;
        const node = dragPreviewNodeRef.current;
        if (!node) {
            return;
        }

        const { clientX, clientY } = dragPreviewPosRef.current;
        node.style.transform = `translate3d(${clientX + 12}px, ${clientY + 12}px, 0) scale(1.02)`;
    }, []);

    const scheduleDragPreviewPosition = useCallback(() => {
        if (dragPreviewFrameRef.current !== null) {
            return;
        }

        dragPreviewFrameRef.current = window.requestAnimationFrame(
            applyDragPreviewPosition,
        );
    }, [applyDragPreviewPosition]);

    const updateTabDragPreview = useCallback(
        (tabId: string, clientX: number, clientY: number) => {
            dragPreviewPosRef.current = { clientX, clientY };
            setDragPreviewTabId((current) =>
                current === tabId ? current : tabId,
            );
            scheduleDragPreviewPosition();
        },
        [scheduleDragPreviewPosition],
    );

    const publishWorkspaceDropPreview = useCallback(
        (
            target: WorkspaceDropTarget,
            preview: CrossPaneTabDropPreview | null,
        ) => {
            if (!sourcePaneId || !onCommitWorkspaceDrop) {
                return;
            }

            const signature = getPreviewSignature(target, preview);
            if (workspacePreviewSignatureRef.current === signature) {
                return;
            }

            workspacePreviewSignatureRef.current = signature;
            dispatchCrossPaneTabDropPreview(preview);
        },
        [onCommitWorkspaceDrop, sourcePaneId],
    );

    const clearWorkspaceDropPreview = useCallback(() => {
        workspaceDropTargetRef.current = { type: "none" };
        if (workspacePreviewSignatureRef.current === "none") {
            return;
        }

        workspacePreviewSignatureRef.current = "none";
        dispatchCrossPaneTabDropPreview(null);
    }, []);

    const resolveCurrentWorkspaceDropTarget = useCallback(
        (
            tabId: string,
            coords: { clientX: number; clientY: number },
            options?: { publishPreview?: boolean },
        ) => {
            const shouldPublishPreview = options?.publishPreview ?? true;
            const externalTarget = resolveExternalDropTarget?.(
                tabId,
                coords,
            ) ?? { type: "none" };
            if (externalTarget.type !== "none") {
                workspaceDropTargetRef.current = externalTarget;
                if (shouldPublishPreview) {
                    publishWorkspaceDropPreview(externalTarget, null);
                }
                return externalTarget;
            }

            if (!sourcePaneId || !onCommitWorkspaceDrop) {
                const target: WorkspaceDropTarget = { type: "none" };
                workspaceDropTargetRef.current = target;
                if (shouldPublishPreview) {
                    publishWorkspaceDropPreview(target, null);
                }
                return target;
            }

            const { target, preview } = resolveWorkspaceTabDropIntent({
                sourcePaneId,
                tabId,
                clientX: coords.clientX,
                clientY: coords.clientY,
            });
            workspaceDropTargetRef.current = target;
            if (shouldPublishPreview) {
                publishWorkspaceDropPreview(target, preview);
            }
            return target;
        },
        [
            onCommitWorkspaceDrop,
            publishWorkspaceDropPreview,
            resolveExternalDropTarget,
            sourcePaneId,
        ],
    );

    const getCommittedWorkspaceDropTarget = useCallback(
        (tabId: string, coords: { clientX: number; clientY: number }) => {
            if (workspaceDropTargetRef.current.type !== "none") {
                return workspaceDropTargetRef.current;
            }

            return resolveCurrentWorkspaceDropTarget(tabId, coords, {
                publishPreview: false,
            });
        },
        [resolveCurrentWorkspaceDropTarget],
    );

    const emitAttachmentDragDetail = useCallback(
        (
            tabId: string,
            phase: "start" | "move" | "end" | "cancel",
            coords?: { clientX: number; clientY: number },
        ) => {
            if (!buildAttachmentDetail) {
                return;
            }

            if (phase === "cancel") {
                emitFileTreeNoteDrag({
                    phase: "cancel",
                    x: 0,
                    y: 0,
                    notes: [],
                });
                return;
            }

            if (!coords) {
                return;
            }

            const detail = buildAttachmentDetail(tabId, phase, coords);
            if (!detail) {
                return;
            }

            emitFileTreeNoteDrag({
                ...detail,
                origin: {
                    kind: "workspace-tab",
                    tabId,
                },
            });
        },
        [buildAttachmentDetail],
    );

    useLayoutEffect(() => {
        if (dragPreviewTabId !== null) {
            applyDragPreviewPosition();
        }
    }, [applyDragPreviewPosition, dragPreviewTabId]);

    useEffect(() => {
        return () => {
            if (dragPreviewFrameRef.current !== null) {
                window.cancelAnimationFrame(dragPreviewFrameRef.current);
                dragPreviewFrameRef.current = null;
            }
            clearWorkspaceDropPreview();
        };
    }, [clearWorkspaceDropPreview]);

    const dragState = useTabDragReorder({
        tabs,
        onCommitReorder,
        onActivate,
        liveReorder,
        shouldDetach: (clientX, clientY) => {
            if (shouldDetach?.(clientX, clientY)) {
                return true;
            }

            const tabId = activeDragTabIdRef.current;
            if (!tabId) {
                return false;
            }

            const target = resolveCurrentWorkspaceDropTarget(tabId, {
                clientX,
                clientY,
            });
            return target.type === "detach-window";
        },
        shouldCommitDrag: (tabId, coords) => {
            if (dragDropHandledRef.current) {
                return false;
            }

            const workspaceTarget = getCommittedWorkspaceDropTarget(
                tabId,
                coords,
            );
            if (workspaceTarget.type !== "none") {
                return false;
            }

            return shouldCommitDrag?.(tabId, coords) ?? true;
        },
        onDetachStart,
        onDetachMove,
        onDetachEnd: (tabId, coords) => {
            const latestCoords = latestDragCoordsRef.current;
            const detachCoords = {
                ...latestCoords,
                screenX: coords.screenX,
                screenY: coords.screenY,
            } satisfies DragCoordinates;
            const target =
                pendingDetachDropTargetRef.current ??
                workspaceDropTargetRef.current;

            if (!detachEndHandledByDragEndRef.current) {
                emitAttachmentDragDetail(tabId, "end", detachCoords);
            }
            detachEndHandledByDragEndRef.current = false;

            if (target.type === "detach-window") {
                void onCommitExternalDrop?.(tabId, target, detachCoords);
            } else {
                void onDetachEnd?.(tabId, coords);
            }

            pendingDetachDropTargetRef.current = null;
            activeDragTabIdRef.current = null;
            dragDropHandledRef.current = false;
            clearWorkspaceDropPreview();
        },
        onDetachCancel: () => {
            pendingDetachDropTargetRef.current = null;
            detachEndHandledByDragEndRef.current = false;
            dragDropHandledRef.current = false;
            clearWorkspaceDropPreview();
            onDetachCancel?.();
        },
        onDragStart: (tabId, coords) => {
            internalDragActiveRef.current = true;
            activeDragTabIdRef.current = tabId;
            latestDragCoordsRef.current = coords;
            pendingDetachDropTargetRef.current = null;
            detachEndHandledByDragEndRef.current = false;
            dragDropHandledRef.current = false;
            updateTabDragPreview(tabId, coords.clientX, coords.clientY);
            emitAttachmentDragDetail(tabId, "start", coords);
        },
        onDragMove: (tabId, coords) => {
            latestDragCoordsRef.current = coords;
            updateTabDragPreview(tabId, coords.clientX, coords.clientY);
            emitAttachmentDragDetail(tabId, "move", coords);
            resolveCurrentWorkspaceDropTarget(tabId, coords);
        },
        onDragEnd: (tabId, coords) => {
            internalDragActiveRef.current = false;
            latestDragCoordsRef.current = coords;
            emitAttachmentDragDetail(tabId, "end", coords);
            setDragPreviewTabId(null);

            const workspaceTarget = getCommittedWorkspaceDropTarget(
                tabId,
                coords,
            );
            if (isLayoutWorkspaceDropTarget(workspaceTarget)) {
                dragDropHandledRef.current = true;
                onCommitWorkspaceDrop?.(tabId, workspaceTarget);
                activeDragTabIdRef.current = null;
                pendingDetachDropTargetRef.current = null;
                clearWorkspaceDropPreview();
                return;
            }

            if (workspaceTarget.type === "detach-window") {
                dragDropHandledRef.current = true;
                pendingDetachDropTargetRef.current = workspaceTarget;
                detachEndHandledByDragEndRef.current = true;
                return;
            }

            if (workspaceTarget.type !== "none") {
                dragDropHandledRef.current = true;
                void onCommitExternalDrop?.(tabId, workspaceTarget, coords);
            }

            activeDragTabIdRef.current = null;
            pendingDetachDropTargetRef.current = null;
            dragDropHandledRef.current = false;
            clearWorkspaceDropPreview();
        },
        onDragCancel: (tabId) => {
            internalDragActiveRef.current = false;
            emitAttachmentDragDetail(tabId, "cancel");
            setDragPreviewTabId(null);
            activeDragTabIdRef.current = null;
            pendingDetachDropTargetRef.current = null;
            detachEndHandledByDragEndRef.current = false;
            dragDropHandledRef.current = false;
            clearWorkspaceDropPreview();
        },
    });

    return {
        ...dragState,
        dragPreviewNodeRef,
        dragPreviewTabId,
        internalDragActiveRef,
    };
}
