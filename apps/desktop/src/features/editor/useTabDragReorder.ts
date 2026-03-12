import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type PointerEvent as ReactPointerEvent,
} from "react";
import type { Tab } from "../../app/store/editorStore";

const TAB_REORDER_THRESHOLD = 6;
const TAB_EDGE_SCROLL_ZONE = 40;
const TAB_EDGE_SCROLL_STEP = 12;
const TAB_DETACH_HYSTERESIS_MS = 80;

interface TabDragSession {
    pointerId: number;
    tabId: string;
    originalIndex: number;
    startX: number;
    startY: number;
    startScrollLeft: number;
    startOffsetLeft: number;
    width: number;
    tabWidths: Record<string, number>;
    dragging: boolean;
    detachArmedAt: number | null;
}

interface UseTabDragReorderOptions {
    tabs: Tab[];
    onCommitReorder: (fromIndex: number, toIndex: number) => void;
    shouldDetach?: (clientX: number, clientY: number) => boolean;
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
}

function arraysEqual(left: string[], right: string[]) {
    return (
        left.length === right.length &&
        left.every((value, index) => value === right[index])
    );
}

export function useTabDragReorder({
    tabs,
    onCommitReorder,
    shouldDetach,
    onDetachStart,
    onDetachMove,
    onDetachEnd,
    onDetachCancel,
}: UseTabDragReorderOptions) {
    const tabStripRef = useRef<HTMLDivElement>(null);
    const tabRefs = useRef<Record<string, HTMLDivElement | null>>({});
    const sessionRef = useRef<TabDragSession | null>(null);
    const previewOrderRef = useRef<string[] | null>(null);
    const previousPositionsRef = useRef<Record<string, number>>({});
    const suppressClickRef = useRef<string | null>(null);
    const detachActiveRef = useRef(false);
    const detachCleanupRef = useRef<(() => void) | null>(null);
    const handlePointerUpRef = useRef<
        (
            pointerId?: number,
            screenCoords?: { screenX: number; screenY: number },
        ) => void
    >(() => {});
    const latestPointerXRef = useRef(0);
    const edgeScrollDirectionRef = useRef(-1 as -1 | 0 | 1);
    const edgeScrollFrameRef = useRef<number | null>(null);
    const runEdgeScrollRef = useRef<() => void>(() => {});
    const domShiftRef = useRef(0);

    const [previewOrder, setPreviewOrder] = useState<string[] | null>(null);
    const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
    const [dragOffsetX, setDragOffsetX] = useState(0);
    const [detachPreviewActive, setDetachPreviewActive] = useState(false);

    const tabsById = useMemo(
        () => Object.fromEntries(tabs.map((tab) => [tab.id, tab])),
        [tabs],
    );
    const visualOrder = previewOrder ?? tabs.map((tab) => tab.id);
    const visualTabs = visualOrder
        .map((tabId) => tabsById[tabId])
        .filter((tab): tab is Tab => Boolean(tab));

    const stopEdgeScroll = useCallback(() => {
        edgeScrollDirectionRef.current = 0;
        if (edgeScrollFrameRef.current !== null) {
            window.cancelAnimationFrame(edgeScrollFrameRef.current);
            edgeScrollFrameRef.current = null;
        }
    }, []);

    const registerTabNode = useCallback(
        (tabId: string, node: HTMLDivElement | null) => {
            tabRefs.current[tabId] = node;
        },
        [],
    );

    useEffect(() => {
        previewOrderRef.current = previewOrder;
    }, [previewOrder]);

    const computeDragOffset = useCallback((clientX: number) => {
        const strip = tabStripRef.current;
        const session = sessionRef.current;
        if (!strip || !session) return 0;

        return (
            clientX -
            session.startX +
            (strip.scrollLeft - session.startScrollLeft)
        );
    }, []);

    const buildPreviewOrder = useCallback(
        (clientX: number) => {
            const session = sessionRef.current;
            const strip = tabStripRef.current;
            if (!session || !strip) return null;

            const currentOrder =
                previewOrderRef.current ?? tabs.map((tab) => tab.id);
            const nextOrder = currentOrder.filter((id) => id !== session.tabId);

            // Convert pointer to content-space using only the strip container rect
            const stripRect = strip.getBoundingClientRect();
            const pointerInContent =
                clientX - stripRect.left + strip.scrollLeft;

            // Compute virtual positions by accumulating snapshotted widths
            // (without the dragged tab). No DOM reads, no race conditions.
            let contentX = 0;
            let insertAt = nextOrder.length;
            for (let i = 0; i < nextOrder.length; i++) {
                const w = session.tabWidths[nextOrder[i]] ?? 0;
                if (pointerInContent < contentX + w / 2) {
                    insertAt = i;
                    break;
                }
                contentX += w;
            }

            nextOrder.splice(insertAt, 0, session.tabId);
            return nextOrder;
        },
        [tabs],
    );

    const syncDraggedTab = useCallback(
        (clientX: number) => {
            setDragOffsetX(computeDragOffset(clientX) - domShiftRef.current);

            const nextOrder = buildPreviewOrder(clientX);
            const currentOrder =
                previewOrderRef.current ?? tabs.map((tab) => tab.id);

            if (nextOrder && !arraysEqual(nextOrder, currentOrder)) {
                previewOrderRef.current = nextOrder;
                setPreviewOrder(nextOrder);
            }
        },
        [buildPreviewOrder, computeDragOffset, tabs],
    );

    useEffect(() => {
        runEdgeScrollRef.current = () => {
            edgeScrollFrameRef.current = null;

            const strip = tabStripRef.current;
            const session = sessionRef.current;
            if (!strip || !session || !session.dragging) {
                stopEdgeScroll();
                return;
            }

            const direction = edgeScrollDirectionRef.current;
            if (!direction) return;

            const previousScroll = strip.scrollLeft;
            strip.scrollLeft += direction * TAB_EDGE_SCROLL_STEP;

            if (strip.scrollLeft !== previousScroll) {
                syncDraggedTab(latestPointerXRef.current);
            }

            edgeScrollFrameRef.current = window.requestAnimationFrame(() => {
                runEdgeScrollRef.current();
            });
        };
    }, [stopEdgeScroll, syncDraggedTab]);

    const updateEdgeScroll = useCallback(
        (clientX: number) => {
            const strip = tabStripRef.current;
            if (!strip) return;

            const bounds = strip.getBoundingClientRect();
            let nextDirection: -1 | 0 | 1 = 0;

            if (clientX < bounds.left + TAB_EDGE_SCROLL_ZONE) {
                nextDirection = -1;
            } else if (clientX > bounds.right - TAB_EDGE_SCROLL_ZONE) {
                nextDirection = 1;
            }

            if (nextDirection === edgeScrollDirectionRef.current) {
                return;
            }

            edgeScrollDirectionRef.current = nextDirection;

            if (nextDirection === 0) {
                stopEdgeScroll();
                return;
            }

            if (edgeScrollFrameRef.current === null) {
                edgeScrollFrameRef.current = window.requestAnimationFrame(
                    () => {
                        runEdgeScrollRef.current();
                    },
                );
            }
        },
        [stopEdgeScroll],
    );

    const finishDrag = useCallback(
        (
            pointerId?: number,
            options?: { commit?: boolean; suppressClick?: boolean },
        ) => {
            const session = sessionRef.current;
            if (!session) return;
            if (pointerId !== undefined && session.pointerId !== pointerId)
                return;

            const draggedNode = tabRefs.current[session.tabId];
            if (
                draggedNode &&
                pointerId !== undefined &&
                draggedNode.hasPointerCapture(pointerId)
            ) {
                draggedNode.releasePointerCapture(pointerId);
            }

            stopEdgeScroll();
            detachCleanupRef.current?.();
            document.body.classList.remove("dragging-tab");
            setDetachPreviewActive(false);

            const commit = options?.commit ?? true;
            const suppressClick = options?.suppressClick ?? session.dragging;

            if (suppressClick) {
                suppressClickRef.current = session.tabId;
            }

            if (commit) {
                const finalIndex =
                    previewOrderRef.current?.indexOf(session.tabId) ?? -1;
                if (finalIndex !== -1 && finalIndex !== session.originalIndex) {
                    onCommitReorder(session.originalIndex, finalIndex);
                }
            }

            detachActiveRef.current = false;
            sessionRef.current = null;
            previewOrderRef.current = null;
            domShiftRef.current = 0;
            setPreviewOrder(null);
            setDraggingTabId(null);
            setDragOffsetX(0);
        },
        [onCommitReorder, stopEdgeScroll],
    );

    useEffect(() => {
        return () => {
            stopEdgeScroll();
            document.body.classList.remove("dragging-tab");
            setDetachPreviewActive(false);
        };
    }, [stopEdgeScroll]);

    useLayoutEffect(() => {
        const nextPositions: Record<string, number> = {};

        visualTabs.forEach((tab) => {
            const node = tabRefs.current[tab.id];
            if (!node) return;

            const nextLeft = node.offsetLeft;
            nextPositions[tab.id] = nextLeft;

            if (tab.id === draggingTabId) {
                const session = sessionRef.current;
                if (session) {
                    // Re-capture pointer if lost during DOM reorder
                    if (!node.hasPointerCapture(session.pointerId)) {
                        try {
                            node.setPointerCapture(session.pointerId);
                        } catch {
                            // Pointer was released — end drag
                            finishDrag(session.pointerId);
                            return;
                        }
                    }
                    domShiftRef.current = nextLeft - session.startOffsetLeft;
                    const strip = tabStripRef.current;
                    const scrollDelta = strip
                        ? strip.scrollLeft - session.startScrollLeft
                        : 0;
                    const visualOffset =
                        latestPointerXRef.current -
                        session.startX +
                        scrollDelta -
                        domShiftRef.current;
                    node.style.transform = `translateX(${visualOffset}px) scale(1.02)`;
                }
                return;
            }

            const previousLeft = previousPositionsRef.current[tab.id];
            if (previousLeft === undefined || previousLeft === nextLeft) {
                node.style.transition =
                    "transform 250ms cubic-bezier(0.2, 0.8, 0.2, 1), background-color 150ms ease, color 150ms ease, border-color 150ms ease";
                node.style.transform = "";
                return;
            }

            // FLIP animation: Invert
            node.style.transition = "none";
            node.style.transform = `translateX(${previousLeft - nextLeft}px)`;

            // FLIP animation: Play
            // Usamos setTimeout para asegurar que el navegador registre el cambio de "none" a "transform"
            setTimeout(() => {
                if (node) {
                    node.style.transition =
                        "transform 250ms cubic-bezier(0.2, 0.8, 0.2, 1), background-color 150ms ease, color 150ms ease, border-color 150ms ease";
                    node.style.transform = "";
                }
            }, 0);
        });

        previousPositionsRef.current = nextPositions;
    }, [draggingTabId, finishDrag, visualTabs]);

    const handlePointerDown = useCallback(
        (
            tabId: string,
            index: number,
            event: ReactPointerEvent<HTMLDivElement>,
        ) => {
            if (event.button !== 0) return;
            if ((event.target as HTMLElement).closest("button")) return;

            const strip = tabStripRef.current;
            if (!strip) return;

            const node = event.currentTarget;

            const tabWidths: Record<string, number> = {};
            for (const tab of tabs) {
                const tabNode = tabRefs.current[tab.id];
                if (tabNode) tabWidths[tab.id] = tabNode.offsetWidth;
            }

            detachActiveRef.current = false;
            detachCleanupRef.current?.();
            domShiftRef.current = 0;
            sessionRef.current = {
                pointerId: event.pointerId,
                tabId,
                originalIndex: index,
                startX: event.clientX,
                startY: event.clientY,
                startScrollLeft: strip.scrollLeft,
                startOffsetLeft: node.offsetLeft,
                width: node.offsetWidth,
                tabWidths,
                dragging: false,
                detachArmedAt: null,
            };

            node.setPointerCapture(event.pointerId);
        },
        [tabs],
    );

    const handlePointerMove = useCallback(
        (tabId: string, event: ReactPointerEvent<HTMLDivElement>) => {
            const session = sessionRef.current;
            if (!session || session.pointerId !== event.pointerId) return;
            if (session.tabId !== tabId) return;

            latestPointerXRef.current = event.clientX;

            const deltaX = event.clientX - session.startX;
            const deltaY = event.clientY - session.startY;

            if (
                !session.dragging &&
                Math.hypot(deltaX, deltaY) < TAB_REORDER_THRESHOLD
            ) {
                return;
            }

            if (!session.dragging) {
                session.dragging = true;
                if (previewOrderRef.current === null) {
                    const initialOrder = tabs.map((tab) => tab.id);
                    previewOrderRef.current = initialOrder;
                    setPreviewOrder(initialOrder);
                }
                setDraggingTabId(tabId);
                document.body.classList.add("dragging-tab");
            }

            const wantsDetach = shouldDetach?.(event.clientX, event.clientY);

            // Already in ghost mode — check if button was released (missed pointerup)
            if (wantsDetach && detachActiveRef.current) {
                if (event.buttons === 0) {
                    const tid = session.tabId;
                    const coords = {
                        screenX: event.screenX,
                        screenY: event.screenY,
                    };
                    finishDrag(event.pointerId, {
                        commit: false,
                        suppressClick: true,
                    });
                    void onDetachEnd?.(tid, coords);
                    return;
                }
                onDetachMove?.({
                    screenX: event.screenX,
                    screenY: event.screenY,
                });
                return;
            }

            // Pointer wants to detach — arm hysteresis
            if (wantsDetach && onDetachStart) {
                if (session.detachArmedAt === null) {
                    session.detachArmedAt = window.performance.now();
                }

                setDetachPreviewActive(true);
                stopEdgeScroll();
                setDragOffsetX(
                    computeDragOffset(event.clientX) - domShiftRef.current,
                );

                if (
                    window.performance.now() - session.detachArmedAt <
                    TAB_DETACH_HYSTERESIS_MS
                ) {
                    return;
                }

                // Hysteresis passed — enter ghost mode (keep pointer capture)
                detachActiveRef.current = true;

                // Install document-level pointerup as fallback (WebKit may not
                // deliver pointerup to captured elements outside the window).
                const onDocPointerUp = (e: PointerEvent) => {
                    if (e.pointerId !== session.pointerId) return;
                    cleanup();
                    handlePointerUpRef.current(e.pointerId, {
                        screenX: e.screenX,
                        screenY: e.screenY,
                    });
                };
                const cleanup = () => {
                    document.removeEventListener("pointerup", onDocPointerUp);
                    detachCleanupRef.current = null;
                };
                detachCleanupRef.current = cleanup;
                document.addEventListener("pointerup", onDocPointerUp);

                void onDetachStart(tabId, {
                    screenX: event.screenX,
                    screenY: event.screenY,
                });
                return;
            }

            // Pointer returned to window while ghost was active — cancel ghost
            if (!wantsDetach && detachActiveRef.current) {
                detachActiveRef.current = false;
                detachCleanupRef.current?.();
                onDetachCancel?.();
                setDetachPreviewActive(false);
                session.detachArmedAt = null;
                // Resume normal drag
                syncDraggedTab(event.clientX);
                updateEdgeScroll(event.clientX);
                return;
            }

            if (session.detachArmedAt !== null) {
                session.detachArmedAt = null;
            }
            if (detachPreviewActive) {
                setDetachPreviewActive(false);
            }

            updateEdgeScroll(event.clientX);
            syncDraggedTab(event.clientX);
        },
        [
            computeDragOffset,
            detachPreviewActive,
            finishDrag,
            onDetachCancel,
            onDetachEnd,
            onDetachMove,
            onDetachStart,
            shouldDetach,
            syncDraggedTab,
            stopEdgeScroll,
            tabs,
            updateEdgeScroll,
        ],
    );

    const handlePointerUp = useCallback(
        (
            pointerId?: number,
            screenCoords?: { screenX: number; screenY: number },
        ) => {
            detachCleanupRef.current?.();

            const session = sessionRef.current;

            if (detachActiveRef.current && session && screenCoords) {
                const tabId = session.tabId;
                finishDrag(pointerId, {
                    commit: false,
                    suppressClick: true,
                });
                void onDetachEnd?.(tabId, screenCoords);
                return;
            }

            finishDrag(pointerId);
        },
        [finishDrag, onDetachEnd],
    );

    useEffect(() => {
        handlePointerUpRef.current = handlePointerUp;
    }, [handlePointerUp]);

    const handleLostPointerCapture = useCallback(
        (pointerId: number) => {
            const session = sessionRef.current;
            if (!session || session.pointerId !== pointerId) return;

            // If actively dragging, ignore — pointer will be re-captured
            // in useLayoutEffect after React finishes DOM reconciliation.
            if (session.dragging) return;

            // Not dragging yet (pending state), end the session
            finishDrag(pointerId);
        },
        [finishDrag],
    );

    const consumeSuppressedClick = useCallback((tabId: string) => {
        if (suppressClickRef.current !== tabId) {
            return false;
        }

        suppressClickRef.current = null;
        return true;
    }, []);

    return {
        dragOffsetX,
        draggingTabId,
        detachPreviewActive,
        tabStripRef,
        visualTabs,
        registerTabNode,
        handlePointerDown,
        handlePointerMove,
        handlePointerUp,
        handleLostPointerCapture,
        consumeSuppressedClick,
    };
}
