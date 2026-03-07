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
}

interface UseTabDragReorderOptions {
    tabs: Tab[];
    onCommitReorder: (fromIndex: number, toIndex: number) => void;
    shouldDetach?: (clientX: number, clientY: number) => boolean;
    onDetach?: (
        tabId: string,
        coords: { screenX: number; screenY: number },
    ) => Promise<void> | void;
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
    onDetach,
}: UseTabDragReorderOptions) {
    const tabStripRef = useRef<HTMLDivElement>(null);
    const tabRefs = useRef<Record<string, HTMLDivElement | null>>({});
    const sessionRef = useRef<TabDragSession | null>(null);
    const previewOrderRef = useRef<string[] | null>(null);
    const previousPositionsRef = useRef<Record<string, number>>({});
    const suppressClickRef = useRef<string | null>(null);
    const detachInProgressRef = useRef(false);
    const latestPointerXRef = useRef(0);
    const edgeScrollDirectionRef = useRef(-1 as -1 | 0 | 1);
    const edgeScrollFrameRef = useRef<number | null>(null);
    const domShiftRef = useRef(0);

    const [previewOrder, setPreviewOrder] = useState<string[] | null>(null);
    const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
    const [dragOffsetX, setDragOffsetX] = useState(0);

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

    const runEdgeScroll = useCallback(() => {
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

        edgeScrollFrameRef.current =
            window.requestAnimationFrame(runEdgeScroll);
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
                edgeScrollFrameRef.current =
                    window.requestAnimationFrame(runEdgeScroll);
            }
        },
        [runEdgeScroll, stopEdgeScroll],
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
            document.body.classList.remove("dragging-tab");

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
    }, [draggingTabId, visualTabs]);

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

            if (
                shouldDetach?.(event.clientX, event.clientY) &&
                onDetach &&
                !detachInProgressRef.current
            ) {
                detachInProgressRef.current = true;
                finishDrag(event.pointerId, {
                    commit: false,
                    suppressClick: true,
                });

                void Promise.resolve(
                    onDetach(tabId, {
                        screenX: event.screenX,
                        screenY: event.screenY,
                    }),
                ).finally(() => {
                    detachInProgressRef.current = false;
                });
                return;
            }

            updateEdgeScroll(event.clientX);
            syncDraggedTab(event.clientX);
        },
        [
            finishDrag,
            onDetach,
            shouldDetach,
            syncDraggedTab,
            tabs,
            updateEdgeScroll,
        ],
    );

    const handlePointerUp = useCallback(
        (pointerId?: number) => {
            finishDrag(pointerId);
        },
        [finishDrag],
    );

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
        dragSession: sessionRef.current,
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
