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
    onActivate?: (tabId: string) => void;
    liveReorder?: boolean;
    shouldDetach?: (clientX: number, clientY: number) => boolean;
    shouldCommitDrag?: (
        tabId: string,
        coords: {
            clientX: number;
            clientY: number;
            screenX: number;
            screenY: number;
        },
    ) => boolean;
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
    onDragStart?: (
        tabId: string,
        coords: {
            clientX: number;
            clientY: number;
            screenX: number;
            screenY: number;
        },
    ) => void;
    onDragMove?: (
        tabId: string,
        coords: {
            clientX: number;
            clientY: number;
            screenX: number;
            screenY: number;
        },
    ) => void;
    onDragEnd?: (
        tabId: string,
        coords: {
            clientX: number;
            clientY: number;
            screenX: number;
            screenY: number;
        },
    ) => void;
    onDragCancel?: (tabId: string) => void;
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
    onActivate,
    liveReorder = true,
    shouldDetach,
    shouldCommitDrag,
    onDetachStart,
    onDetachMove,
    onDetachEnd,
    onDetachCancel,
    onDragStart,
    onDragMove,
    onDragEnd,
    onDragCancel,
}: UseTabDragReorderOptions) {
    const tabStripRef = useRef<HTMLDivElement>(null);
    const tabRefs = useRef<Record<string, HTMLDivElement | null>>({});
    const sessionRef = useRef<TabDragSession | null>(null);
    const previewOrderRef = useRef<string[] | null>(null);
    const previousPositionsRef = useRef<Record<string, number>>({});
    const suppressClickRef = useRef<string | null>(null);
    const detachActiveRef = useRef(false);
    const detachCleanupRef = useRef<(() => void) | null>(null);
    const detachTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const latestScreenCoordsRef = useRef({ screenX: 0, screenY: 0 });
    const handlePointerUpRef = useRef<
        (
            pointerId?: number,
            coords?: {
                clientX: number;
                clientY: number;
                screenX: number;
                screenY: number;
            },
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
    const visualOrder = liveReorder
        ? (previewOrder ?? tabs.map((tab) => tab.id))
        : tabs.map((tab) => tab.id);
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

    const computeDropIndex = useCallback(
        (clientX: number) => {
            const session = sessionRef.current;
            const strip = tabStripRef.current;
            if (!session || !strip) return session?.originalIndex ?? -1;

            const nextOrder = tabs
                .map((tab) => tab.id)
                .filter((id) => id !== session.tabId);
            const stripRect = strip.getBoundingClientRect();
            const pointerInContent =
                clientX - stripRect.left + strip.scrollLeft;

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

            return insertAt;
        },
        [tabs],
    );

    const syncDraggedTab = useCallback(
        (clientX: number) => {
            if (!liveReorder) {
                return;
            }

            setDragOffsetX(computeDragOffset(clientX) - domShiftRef.current);

            const nextOrder = buildPreviewOrder(clientX);
            const currentOrder =
                previewOrderRef.current ?? tabs.map((tab) => tab.id);

            if (nextOrder && !arraysEqual(nextOrder, currentOrder)) {
                previewOrderRef.current = nextOrder;
                setPreviewOrder(nextOrder);
            }
        },
        [buildPreviewOrder, computeDragOffset, liveReorder, tabs],
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
            options?: {
                commit?: boolean;
                suppressClick?: boolean;
                clientX?: number;
            },
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
            if (detachTimerRef.current !== null) {
                clearTimeout(detachTimerRef.current);
                detachTimerRef.current = null;
            }
            document.body.classList.remove("dragging-tab");
            setDetachPreviewActive(false);

            const commit = options?.commit ?? true;
            const suppressClick = options?.suppressClick ?? session.dragging;

            if (suppressClick) {
                suppressClickRef.current = session.tabId;
            }

            if (commit) {
                const finalIndex = liveReorder
                    ? (previewOrderRef.current?.indexOf(session.tabId) ?? -1)
                    : options?.clientX !== undefined
                      ? computeDropIndex(options.clientX)
                      : session.originalIndex;
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
        [computeDropIndex, liveReorder, onCommitReorder, stopEdgeScroll],
    );

    useEffect(() => {
        return () => {
            const session = sessionRef.current;
            if (session?.dragging) {
                onDragCancel?.(session.tabId);
            }
            stopEdgeScroll();
            document.body.classList.remove("dragging-tab");
            setDetachPreviewActive(false);
        };
    }, [onDragCancel, stopEdgeScroll]);

    useLayoutEffect(() => {
        if (!liveReorder) {
            return;
        }

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
                            onDragCancel?.(session.tabId);
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
    }, [draggingTabId, finishDrag, liveReorder, onDragCancel, visualTabs]);

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

            // Prevent browser text-selection gesture from starting on mousedown.
            // Without this, dragging a tab selects text underneath the pointer.
            event.preventDefault();

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
                try {
                    event.currentTarget.setPointerCapture(event.pointerId);
                } catch {
                    // Ignore capture failures and continue with best-effort drag.
                }
                if (previewOrderRef.current === null) {
                    const initialOrder = tabs.map((tab) => tab.id);
                    previewOrderRef.current = initialOrder;
                    setPreviewOrder(initialOrder);
                }
                setDraggingTabId(tabId);
                document.body.classList.add("dragging-tab");
                onDragStart?.(tabId, {
                    clientX: event.clientX,
                    clientY: event.clientY,
                    screenX: event.screenX,
                    screenY: event.screenY,
                });
            }

            onDragMove?.(tabId, {
                clientX: event.clientX,
                clientY: event.clientY,
                screenX: event.screenX,
                screenY: event.screenY,
            });

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
                latestScreenCoordsRef.current = {
                    screenX: event.screenX,
                    screenY: event.screenY,
                };

                setDetachPreviewActive(true);
                stopEdgeScroll();
                setDragOffsetX(
                    computeDragOffset(event.clientX) - domShiftRef.current,
                );

                // Enter ghost mode once the hysteresis threshold is met.
                // This helper is shared between the pointermove fast-path
                // and the setTimeout fallback (for when WebKit stops
                // delivering events outside the window).
                const enterGhostMode = (s: TabDragSession) => {
                    if (detachActiveRef.current) return;
                    detachActiveRef.current = true;

                    if (detachTimerRef.current !== null) {
                        clearTimeout(detachTimerRef.current);
                        detachTimerRef.current = null;
                    }

                    // Install document-level pointerup as fallback
                    // (WebKit may not deliver pointerup to captured
                    // elements outside the window).
                    const onDocPointerUp = (e: PointerEvent) => {
                        if (e.pointerId !== s.pointerId) return;
                        cleanup();
                        handlePointerUpRef.current(e.pointerId, {
                            clientX: e.clientX,
                            clientY: e.clientY,
                            screenX: e.screenX,
                            screenY: e.screenY,
                        });
                    };
                    const cleanup = () => {
                        document.removeEventListener(
                            "pointerup",
                            onDocPointerUp,
                        );
                        detachCleanupRef.current = null;
                    };
                    detachCleanupRef.current = cleanup;
                    document.addEventListener("pointerup", onDocPointerUp);

                    void onDetachStart(s.tabId, {
                        ...latestScreenCoordsRef.current,
                    });
                };

                if (session.detachArmedAt === null) {
                    session.detachArmedAt = window.performance.now();

                    // Fallback timer: fires even if no more pointermove
                    // events arrive (e.g. pointer outside window on macOS).
                    detachTimerRef.current = setTimeout(() => {
                        detachTimerRef.current = null;
                        const s = sessionRef.current;
                        if (!s || !s.dragging) return;
                        if (s.detachArmedAt === null) return;
                        enterGhostMode(s);
                    }, TAB_DETACH_HYSTERESIS_MS);
                } else if (
                    window.performance.now() - session.detachArmedAt >=
                    TAB_DETACH_HYSTERESIS_MS
                ) {
                    // Fast-path: pointermove arrived after threshold elapsed.
                    enterGhostMode(session);
                }

                return;
            }

            // Pointer returned to window while ghost was active
            if (!wantsDetach && detachActiveRef.current) {
                // Button was already released outside the window (missed
                // pointerup — common on macOS/WebKit). Complete the detach
                // using the last known screen coordinates.
                if (event.buttons === 0) {
                    const tid = session.tabId;
                    const coords = { ...latestScreenCoordsRef.current };
                    finishDrag(event.pointerId, {
                        commit: false,
                        suppressClick: true,
                    });
                    void onDetachEnd?.(tid, coords);
                    return;
                }

                // Still holding — cancel ghost and resume normal drag.
                detachActiveRef.current = false;
                detachCleanupRef.current?.();
                onDetachCancel?.();
                setDetachPreviewActive(false);
                session.detachArmedAt = null;
                syncDraggedTab(event.clientX);
                updateEdgeScroll(event.clientX);
                return;
            }

            if (session.detachArmedAt !== null) {
                session.detachArmedAt = null;
                if (detachTimerRef.current !== null) {
                    clearTimeout(detachTimerRef.current);
                    detachTimerRef.current = null;
                }
            }
            if (detachPreviewActive) {
                setDetachPreviewActive(false);
            }

            if (liveReorder) {
                updateEdgeScroll(event.clientX);
                syncDraggedTab(event.clientX);
                return;
            }

            updateEdgeScroll(event.clientX);
        },
        [
            computeDragOffset,
            detachPreviewActive,
            finishDrag,
            liveReorder,
            onDragMove,
            onDragStart,
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
            coords?: {
                clientX: number;
                clientY: number;
                screenX: number;
                screenY: number;
            },
        ) => {
            detachCleanupRef.current?.();

            const session = sessionRef.current;

            if (session && !session.dragging) {
                onActivate?.(session.tabId);
                finishDrag(pointerId, {
                    commit: false,
                    suppressClick: true,
                });
                return;
            }

            if (detachActiveRef.current && session && coords) {
                const tabId = session.tabId;
                if (session.dragging) {
                    onDragEnd?.(tabId, coords);
                }
                finishDrag(pointerId, {
                    commit: false,
                    suppressClick: true,
                });
                void onDetachEnd?.(tabId, {
                    screenX: coords.screenX,
                    screenY: coords.screenY,
                });
                return;
            }

            if (session?.dragging && coords) {
                onDragEnd?.(session.tabId, coords);
            }

            finishDrag(pointerId, {
                commit: coords
                    ? session
                        ? (shouldCommitDrag?.(session.tabId, coords) ?? true)
                        : true
                    : true,
                clientX: coords?.clientX,
            });
        },
        [finishDrag, onActivate, onDetachEnd, onDragEnd, shouldCommitDrag],
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
