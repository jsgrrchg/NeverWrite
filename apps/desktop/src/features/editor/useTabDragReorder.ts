import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type PointerEvent as ReactPointerEvent,
} from "react";

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

interface DragTabLike {
    id: string;
}

interface UseTabDragReorderOptions<TTab extends DragTabLike> {
    tabs: TTab[];
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

export function useTabDragReorder<TTab extends DragTabLike>({
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
}: UseTabDragReorderOptions<TTab>) {
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
    const onDragCancelRef = useRef(onDragCancel);
    const processPointerMoveRef = useRef<
        (
            tabId: string,
            pointerId: number,
            coords: {
                clientX: number;
                clientY: number;
                screenX: number;
                screenY: number;
                buttons?: number;
            },
        ) => void
    >(() => {});
    const processPointerUpRef = useRef<
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
    const globalPointerTrackingRef = useRef(false);

    const [previewOrder, setPreviewOrder] = useState<string[] | null>(null);
    const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
    const [dragOffsetX, setDragOffsetX] = useState(0);
    const [detachPreviewActive, setDetachPreviewActive] = useState(false);
    const [projectedDropIndex, setProjectedDropIndex] = useState<number | null>(
        null,
    );
    const [activePointerId, setActivePointerId] = useState<number | null>(null);

    const tabsById = useMemo(
        () => Object.fromEntries(tabs.map((tab) => [tab.id, tab])),
        [tabs],
    );
    const visualOrder = liveReorder
        ? (previewOrder ?? tabs.map((tab) => tab.id))
        : tabs.map((tab) => tab.id);
    const visualTabs = visualOrder
        .map((tabId) => tabsById[tabId])
        .filter((tab): tab is TTab => Boolean(tab));

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

    useEffect(() => {
        onDragCancelRef.current = onDragCancel;
    }, [onDragCancel]);

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
                if (liveReorder) {
                    syncDraggedTab(latestPointerXRef.current);
                } else {
                    setProjectedDropIndex(
                        computeDropIndex(latestPointerXRef.current),
                    );
                }
            }

            edgeScrollFrameRef.current = window.requestAnimationFrame(() => {
                runEdgeScrollRef.current();
            });
        };
    }, [computeDropIndex, liveReorder, stopEdgeScroll, syncDraggedTab]);

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
                typeof draggedNode.hasPointerCapture === "function" &&
                draggedNode.hasPointerCapture(pointerId)
            ) {
                if (typeof draggedNode.releasePointerCapture === "function") {
                    draggedNode.releasePointerCapture(pointerId);
                }
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
            setProjectedDropIndex(null);
            setActivePointerId(null);
        },
        [computeDropIndex, liveReorder, onCommitReorder, stopEdgeScroll],
    );

    useEffect(() => {
        return () => {
            const session = sessionRef.current;
            if (session?.dragging) {
                onDragCancelRef.current?.(session.tabId);
            }
            stopEdgeScroll();
            document.body.classList.remove("dragging-tab");
            setDetachPreviewActive(false);
        };
    }, [stopEdgeScroll]);

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
                    // Best-effort pointer capture keeps element-local pointer
                    // events alive, but window listeners remain the source of
                    // truth for the gesture if capture cannot be restored.
                    if (!node.hasPointerCapture(session.pointerId)) {
                        try {
                            node.setPointerCapture(session.pointerId);
                        } catch {
                            // Ignore capture failures and keep the drag alive.
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
            // Use setTimeout to ensure the browser registers the change from "none" to "transform".
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
            setActivePointerId(event.pointerId);
        },
        [tabs],
    );

    const processPointerMove = useCallback(
        (
            tabId: string,
            pointerId: number,
            coords: {
                clientX: number;
                clientY: number;
                screenX: number;
                screenY: number;
                buttons?: number;
            },
            captureTarget?: HTMLDivElement | null,
        ) => {
            const session = sessionRef.current;
            if (!session || session.pointerId !== pointerId) return;
            if (session.tabId !== tabId) return;

            latestPointerXRef.current = coords.clientX;

            const deltaX = coords.clientX - session.startX;
            const deltaY = coords.clientY - session.startY;

            if (
                !session.dragging &&
                Math.hypot(deltaX, deltaY) < TAB_REORDER_THRESHOLD
            ) {
                return;
            }

            if (!session.dragging) {
                session.dragging = true;
                const captureNode = captureTarget ?? tabRefs.current[tabId];
                try {
                    captureNode?.setPointerCapture(pointerId);
                } catch {
                    // Ignore capture failures and continue with best-effort drag.
                }
                if (previewOrderRef.current === null) {
                    const initialOrder = tabs.map((tab) => tab.id);
                    previewOrderRef.current = initialOrder;
                    setPreviewOrder(initialOrder);
                }
                if (!liveReorder) {
                    setProjectedDropIndex(session.originalIndex);
                }
                setDraggingTabId(tabId);
                document.body.classList.add("dragging-tab");
                onDragStart?.(tabId, {
                    clientX: coords.clientX,
                    clientY: coords.clientY,
                    screenX: coords.screenX,
                    screenY: coords.screenY,
                });
            }

            onDragMove?.(tabId, {
                clientX: coords.clientX,
                clientY: coords.clientY,
                screenX: coords.screenX,
                screenY: coords.screenY,
            });

            const wantsDetach = shouldDetach?.(coords.clientX, coords.clientY);
            const pointerButtons = coords.buttons ?? 1;

            // Already in ghost mode — check if button was released (missed pointerup)
            if (wantsDetach && detachActiveRef.current) {
                if (pointerButtons === 0) {
                    const tid = session.tabId;
                    const detachCoords = {
                        screenX: coords.screenX,
                        screenY: coords.screenY,
                    };
                    finishDrag(pointerId, {
                        commit: false,
                        suppressClick: true,
                    });
                    void onDetachEnd?.(tid, detachCoords);
                    return;
                }
                onDetachMove?.({
                    screenX: coords.screenX,
                    screenY: coords.screenY,
                });
                return;
            }

            // Pointer wants to detach — arm hysteresis
            if (wantsDetach && onDetachStart) {
                latestScreenCoordsRef.current = {
                    screenX: coords.screenX,
                    screenY: coords.screenY,
                };

                setDetachPreviewActive(true);
                stopEdgeScroll();
                setDragOffsetX(
                    computeDragOffset(coords.clientX) - domShiftRef.current,
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
                if (pointerButtons === 0) {
                    const tid = session.tabId;
                    const detachCoords = { ...latestScreenCoordsRef.current };
                    finishDrag(pointerId, {
                        commit: false,
                        suppressClick: true,
                    });
                    void onDetachEnd?.(tid, detachCoords);
                    return;
                }

                // Still holding — cancel ghost and resume normal drag.
                detachActiveRef.current = false;
                detachCleanupRef.current?.();
                onDetachCancel?.();
                setDetachPreviewActive(false);
                session.detachArmedAt = null;
                syncDraggedTab(coords.clientX);
                updateEdgeScroll(coords.clientX);
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
                updateEdgeScroll(coords.clientX);
                syncDraggedTab(coords.clientX);
                return;
            }

            updateEdgeScroll(coords.clientX);
            setProjectedDropIndex(computeDropIndex(coords.clientX));
        },
        [
            computeDropIndex,
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

    const handlePointerMove = useCallback(
        (tabId: string, event: ReactPointerEvent<HTMLDivElement>) => {
            if (globalPointerTrackingRef.current) {
                return;
            }

            processPointerMove(
                tabId,
                event.pointerId,
                {
                    clientX: event.clientX,
                    clientY: event.clientY,
                    screenX: event.screenX,
                    screenY: event.screenY,
                    buttons: event.buttons,
                },
                event.currentTarget,
            );
        },
        [processPointerMove],
    );

    const processPointerUp = useCallback(
        (
            pointerId?: number,
            coords?: {
                clientX: number;
                clientY: number;
                screenX: number;
                screenY: number;
            },
            options?: {
                fromElement?: boolean;
            },
        ) => {
            detachCleanupRef.current?.();

            const session = sessionRef.current;

            if (session && !session.dragging) {
                const tabNode = tabRefs.current[session.tabId];
                const shouldActivate =
                    options?.fromElement === true ||
                    (tabNode !== undefined &&
                        tabNode !== null &&
                        coords !== undefined &&
                        isPointInsideRect(
                            coords,
                            tabNode.getBoundingClientRect(),
                        ));
                if (shouldActivate) {
                    onActivate?.(session.tabId);
                }
                finishDrag(pointerId, {
                    commit: false,
                    suppressClick: shouldActivate,
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
            processPointerUp(pointerId, coords, { fromElement: true });
        },
        [processPointerUp],
    );

    useEffect(() => {
        processPointerMoveRef.current = processPointerMove;
    }, [processPointerMove]);

    useEffect(() => {
        processPointerUpRef.current = processPointerUp;
    }, [processPointerUp]);

    useEffect(() => {
        if (activePointerId === null) {
            globalPointerTrackingRef.current = false;
            return;
        }

        globalPointerTrackingRef.current = true;

        const handleWindowPointerMove = (event: PointerEvent) => {
            const session = sessionRef.current;
            if (!session) {
                return;
            }

            processPointerMoveRef.current(session.tabId, event.pointerId, {
                clientX: event.clientX,
                clientY: event.clientY,
                screenX: event.screenX,
                screenY: event.screenY,
                buttons: event.buttons,
            });
        };
        const handleWindowPointerUp = (event: PointerEvent) => {
            processPointerUpRef.current(event.pointerId, {
                clientX: event.clientX,
                clientY: event.clientY,
                screenX: event.screenX,
                screenY: event.screenY,
            });
        };
        const handleWindowPointerCancel = (event: PointerEvent) => {
            processPointerUpRef.current(event.pointerId, {
                clientX: event.clientX,
                clientY: event.clientY,
                screenX: event.screenX,
                screenY: event.screenY,
            });
        };

        window.addEventListener("pointermove", handleWindowPointerMove);
        window.addEventListener("pointerup", handleWindowPointerUp);
        window.addEventListener("pointercancel", handleWindowPointerCancel);

        return () => {
            globalPointerTrackingRef.current = false;
            window.removeEventListener("pointermove", handleWindowPointerMove);
            window.removeEventListener("pointerup", handleWindowPointerUp);
            window.removeEventListener(
                "pointercancel",
                handleWindowPointerCancel,
            );
        };
    }, [activePointerId]);

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
        projectedDropIndex,
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

function isPointInsideRect(
    point: { clientX: number; clientY: number },
    rect: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
) {
    return (
        point.clientX >= rect.left &&
        point.clientX <= rect.right &&
        point.clientY >= rect.top &&
        point.clientY <= rect.bottom
    );
}
