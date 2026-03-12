import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type PointerEvent as ReactPointerEvent,
} from "react";
import {
    DEFAULT_RIGHT_PANEL_WIDTH,
    DEFAULT_SIDEBAR_WIDTH,
    MIN_RIGHT_PANEL_WIDTH,
    MIN_SIDEBAR_WIDTH,
    useLayoutStore,
} from "../../app/store/layoutStore";

const COLLAPSE_TRIGGER_WIDTH = 168;
const LEFT_SNAP_POINTS = [DEFAULT_SIDEBAR_WIDTH, 320];
const RIGHT_SNAP_POINTS = [DEFAULT_RIGHT_PANEL_WIDTH, 360, 500];
const SNAP_DISTANCE = 18;
const RESIZER_HITBOX_WIDTH = 10;
const RESIZER_VISIBLE_WIDTH = 1;
const MIN_CENTER_PEEK_WIDTH = 36;

interface ResizeSession {
    pointerId: number;
    startX: number;
    startWidth: number;
    pendingWidth: number;
}

interface AppLayoutProps {
    left: React.ReactNode;
    center: React.ReactNode;
    right?: React.ReactNode;
}

export function AppLayout({ left, center, right }: AppLayoutProps) {
    const sidebarCollapsed = useLayoutStore((s) => s.sidebarCollapsed);
    const sidebarWidth = useLayoutStore((s) => s.sidebarWidth);
    const collapseSidebarToWidth = useLayoutStore(
        (s) => s.collapseSidebarToWidth,
    );
    const showSidebarAtWidth = useLayoutStore((s) => s.showSidebarAtWidth);
    const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);
    const rightPanelCollapsed = useLayoutStore((s) => s.rightPanelCollapsed);
    const rightPanelExpanded = useLayoutStore((s) => s.rightPanelExpanded);
    const rightPanelWidth = useLayoutStore((s) => s.rightPanelWidth);
    const collapseRightPanelToWidth = useLayoutStore(
        (s) => s.collapseRightPanelToWidth,
    );
    const showRightPanelAtWidth = useLayoutStore(
        (s) => s.showRightPanelAtWidth,
    );
    const toggleRightPanel = useLayoutStore((s) => s.toggleRightPanel);
    const rootRef = useRef<HTMLDivElement>(null);
    const [layoutWidth, setLayoutWidth] = useState(0);

    // --- Left panel ---
    const [isResizingLeft, setIsResizingLeft] = useState(false);
    const [collapsePreviewLeft, setCollapsePreviewLeft] = useState(false);
    const leftPanelRef = useRef<HTMLDivElement>(null);
    const leftResizerRef = useRef<HTMLDivElement>(null);
    const leftSessionRef = useRef<ResizeSession | null>(null);
    const leftFrameRef = useRef<number | null>(null);
    const leftCollapsePreviewRef = useRef(false);

    // --- Right panel ---
    const [isResizingRight, setIsResizingRight] = useState(false);
    const [collapsePreviewRight, setCollapsePreviewRight] = useState(false);
    const rightPanelRef = useRef<HTMLDivElement>(null);
    const rightResizerRef = useRef<HTMLDivElement>(null);
    const rightSessionRef = useRef<ResizeSession | null>(null);
    const rightFrameRef = useRef<number | null>(null);
    const rightCollapsePreviewRef = useRef(false);
    const effectiveLeft = sidebarCollapsed ? 0 : sidebarWidth;
    const effectiveRightForLeftCalc = rightPanelCollapsed ? 0 : rightPanelWidth;
    const maxLeftWidthForLayout = Math.max(
        MIN_SIDEBAR_WIDTH,
        layoutWidth -
            effectiveRightForLeftCalc -
            RESIZER_HITBOX_WIDTH * 2 -
            MIN_CENTER_PEEK_WIDTH,
    );
    const maxRightWidthForLayout = Math.max(
        MIN_RIGHT_PANEL_WIDTH,
        layoutWidth -
            effectiveLeft -
            RESIZER_HITBOX_WIDTH * 2 -
            MIN_CENTER_PEEK_WIDTH,
    );
    const effectiveRight = rightPanelCollapsed
        ? 0
        : rightPanelExpanded
          ? maxRightWidthForLayout
          : Math.min(rightPanelWidth, maxRightWidthForLayout);

    // ---- Left resize logic ----

    const applyLeftWidth = useCallback((width: number) => {
        const panel = leftPanelRef.current;
        if (!panel) return;
        panel.style.width = `${width}px`;
        panel.style.borderRight =
            width > 0 ? "1px solid var(--border)" : "none";
    }, []);

    const syncLeftPreview = useCallback((next: boolean) => {
        if (leftCollapsePreviewRef.current === next) return;
        leftCollapsePreviewRef.current = next;
        setCollapsePreviewLeft(next);
    }, []);

    const flushLeftWidth = useCallback(() => {
        leftFrameRef.current = null;
        const s = leftSessionRef.current;
        if (!s) return;
        applyLeftWidth(s.pendingWidth);
        syncLeftPreview(s.pendingWidth < COLLAPSE_TRIGGER_WIDTH);
    }, [applyLeftWidth, syncLeftPreview]);

    const scheduleLeftWidth = useCallback(() => {
        if (leftFrameRef.current !== null) return;
        leftFrameRef.current = window.requestAnimationFrame(flushLeftWidth);
    }, [flushLeftWidth]);

    const finishLeftResize = useCallback(
        (pointerId?: number) => {
            const s = leftSessionRef.current;
            if (!s) return;
            if (pointerId !== undefined && s.pointerId !== pointerId) return;

            if (leftFrameRef.current !== null) {
                window.cancelAnimationFrame(leftFrameRef.current);
                leftFrameRef.current = null;
            }
            const resizer = leftResizerRef.current;
            if (
                resizer &&
                pointerId !== undefined &&
                resizer.hasPointerCapture(pointerId)
            ) {
                resizer.releasePointerCapture(pointerId);
            }
            applyLeftWidth(s.pendingWidth);
            document.body.classList.remove("resizing-sidebar");
            leftSessionRef.current = null;
            syncLeftPreview(false);
            setIsResizingLeft(false);

            if (s.pendingWidth < COLLAPSE_TRIGGER_WIDTH) {
                collapseSidebarToWidth(MIN_SIDEBAR_WIDTH);
                return;
            }
            const clamped = Math.max(
                MIN_SIDEBAR_WIDTH,
                Math.min(maxLeftWidthForLayout, s.pendingWidth),
            );
            const snapped =
                LEFT_SNAP_POINTS.find(
                    (p) => Math.abs(p - clamped) <= SNAP_DISTANCE,
                ) ?? clamped;
            showSidebarAtWidth(snapped);
        },
        [
            applyLeftWidth,
            collapseSidebarToWidth,
            maxLeftWidthForLayout,
            showSidebarAtWidth,
            syncLeftPreview,
        ],
    );

    useEffect(() => {
        if (!isResizingLeft) return;
        const stop = () => finishLeftResize();
        window.addEventListener("pointerup", stop);
        window.addEventListener("pointercancel", stop);
        window.addEventListener("mouseup", stop);
        window.addEventListener("blur", stop);
        const onVis = () => {
            if (document.visibilityState !== "visible") stop();
        };
        document.addEventListener("visibilitychange", onVis);
        return () => {
            window.removeEventListener("pointerup", stop);
            window.removeEventListener("pointercancel", stop);
            window.removeEventListener("mouseup", stop);
            window.removeEventListener("blur", stop);
            document.removeEventListener("visibilitychange", onVis);
        };
    }, [finishLeftResize, isResizingLeft]);

    useEffect(
        () => () => {
            if (leftFrameRef.current !== null)
                window.cancelAnimationFrame(leftFrameRef.current);
            document.body.classList.remove("resizing-sidebar");
        },
        [],
    );

    const onLeftDown = useCallback(
        (e: ReactPointerEvent<HTMLDivElement>) => {
            if (e.button !== 0) return;
            const startWidth = sidebarCollapsed ? 0 : sidebarWidth;
            leftSessionRef.current = {
                pointerId: e.pointerId,
                startX: e.clientX,
                startWidth,
                pendingWidth: startWidth,
            };
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            document.body.classList.add("resizing-sidebar");
            syncLeftPreview(false);
            setIsResizingLeft(true);
            applyLeftWidth(startWidth);
        },
        [applyLeftWidth, sidebarCollapsed, sidebarWidth, syncLeftPreview],
    );

    const onLeftMove = useCallback(
        (e: ReactPointerEvent<HTMLDivElement>) => {
            const s = leftSessionRef.current;
            if (!s || s.pointerId !== e.pointerId) return;
            s.pendingWidth = Math.max(
                0,
                Math.min(
                    maxLeftWidthForLayout,
                    s.startWidth + e.clientX - s.startX,
                ),
            );
            scheduleLeftWidth();
        },
        [maxLeftWidthForLayout, scheduleLeftWidth],
    );

    const onLeftUp = useCallback(
        (e: ReactPointerEvent<HTMLDivElement>) => finishLeftResize(e.pointerId),
        [finishLeftResize],
    );

    // ---- Right resize logic ----

    const applyRightWidth = useCallback((width: number) => {
        const panel = rightPanelRef.current;
        if (!panel) return;
        panel.style.width = `${width}px`;
        panel.style.borderLeft = width > 0 ? "1px solid var(--border)" : "none";
    }, []);

    const syncRightPreview = useCallback((next: boolean) => {
        if (rightCollapsePreviewRef.current === next) return;
        rightCollapsePreviewRef.current = next;
        setCollapsePreviewRight(next);
    }, []);

    const flushRightWidth = useCallback(() => {
        rightFrameRef.current = null;
        const s = rightSessionRef.current;
        if (!s) return;
        applyRightWidth(s.pendingWidth);
        syncRightPreview(s.pendingWidth < COLLAPSE_TRIGGER_WIDTH);
    }, [applyRightWidth, syncRightPreview]);

    const scheduleRightWidth = useCallback(() => {
        if (rightFrameRef.current !== null) return;
        rightFrameRef.current = window.requestAnimationFrame(flushRightWidth);
    }, [flushRightWidth]);

    const finishRightResize = useCallback(
        (pointerId?: number) => {
            const s = rightSessionRef.current;
            if (!s) return;
            if (pointerId !== undefined && s.pointerId !== pointerId) return;

            if (rightFrameRef.current !== null) {
                window.cancelAnimationFrame(rightFrameRef.current);
                rightFrameRef.current = null;
            }
            const resizer = rightResizerRef.current;
            if (
                resizer &&
                pointerId !== undefined &&
                resizer.hasPointerCapture(pointerId)
            ) {
                resizer.releasePointerCapture(pointerId);
            }
            applyRightWidth(s.pendingWidth);
            document.body.classList.remove("resizing-sidebar");
            rightSessionRef.current = null;
            syncRightPreview(false);
            setIsResizingRight(false);

            if (s.pendingWidth < COLLAPSE_TRIGGER_WIDTH) {
                collapseRightPanelToWidth(MIN_RIGHT_PANEL_WIDTH);
                return;
            }
            const clamped = Math.max(
                MIN_RIGHT_PANEL_WIDTH,
                Math.min(maxRightWidthForLayout, s.pendingWidth),
            );
            const snapped =
                RIGHT_SNAP_POINTS.find(
                    (p) => Math.abs(p - clamped) <= SNAP_DISTANCE,
                ) ?? clamped;
            showRightPanelAtWidth(snapped);
        },
        [
            applyRightWidth,
            collapseRightPanelToWidth,
            maxRightWidthForLayout,
            showRightPanelAtWidth,
            syncRightPreview,
        ],
    );

    useEffect(() => {
        if (!isResizingRight) return;
        const stop = () => finishRightResize();
        window.addEventListener("pointerup", stop);
        window.addEventListener("pointercancel", stop);
        window.addEventListener("mouseup", stop);
        window.addEventListener("blur", stop);
        const onVis = () => {
            if (document.visibilityState !== "visible") stop();
        };
        document.addEventListener("visibilitychange", onVis);
        return () => {
            window.removeEventListener("pointerup", stop);
            window.removeEventListener("pointercancel", stop);
            window.removeEventListener("mouseup", stop);
            window.removeEventListener("blur", stop);
            document.removeEventListener("visibilitychange", onVis);
        };
    }, [finishRightResize, isResizingRight]);

    useEffect(
        () => () => {
            if (rightFrameRef.current !== null)
                window.cancelAnimationFrame(rightFrameRef.current);
        },
        [],
    );

    useEffect(() => {
        const el = rootRef.current;
        if (!el) return;
        setLayoutWidth(el.clientWidth);
        const ro = new ResizeObserver(([entry]) => {
            setLayoutWidth(Math.round(entry.contentRect.width));
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const onRightDown = useCallback(
        (e: ReactPointerEvent<HTMLDivElement>) => {
            if (e.button !== 0) return;
            const startWidth = rightPanelCollapsed ? 0 : effectiveRight;
            rightSessionRef.current = {
                pointerId: e.pointerId,
                startX: e.clientX,
                startWidth,
                pendingWidth: startWidth,
            };
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            document.body.classList.add("resizing-sidebar");
            syncRightPreview(false);
            setIsResizingRight(true);
            applyRightWidth(startWidth);
        },
        [
            applyRightWidth,
            effectiveRight,
            rightPanelCollapsed,
            syncRightPreview,
        ],
    );

    const onRightMove = useCallback(
        (e: ReactPointerEvent<HTMLDivElement>) => {
            const s = rightSessionRef.current;
            if (!s || s.pointerId !== e.pointerId) return;
            // Inverted: drag left = expand right panel
            s.pendingWidth = Math.max(
                0,
                Math.min(
                    maxRightWidthForLayout,
                    s.startWidth - (e.clientX - s.startX),
                ),
            );
            scheduleRightWidth();
        },
        [maxRightWidthForLayout, scheduleRightWidth],
    );

    const onRightUp = useCallback(
        (e: ReactPointerEvent<HTMLDivElement>) =>
            finishRightResize(e.pointerId),
        [finishRightResize],
    );

    const onRightDoubleClick = useCallback(() => {
        if (rightPanelCollapsed) {
            showRightPanelAtWidth(DEFAULT_RIGHT_PANEL_WIDTH);
        } else {
            toggleRightPanel();
        }
    }, [rightPanelCollapsed, showRightPanelAtWidth, toggleRightPanel]);

    const isResizing = isResizingLeft || isResizingRight;

    return (
        <div
            ref={rootRef}
            className="relative flex h-full overflow-hidden"
            style={{ backgroundColor: "var(--bg-primary)" }}
        >
            {/* Left sidebar */}
            <div
                ref={leftPanelRef}
                style={{
                    width: effectiveLeft,
                    flexShrink: 0,
                    overflow: "hidden",
                    backgroundColor: "var(--bg-secondary)",
                    borderRight: sidebarCollapsed
                        ? "none"
                        : "1px solid var(--border)",
                    transition: isResizingLeft
                        ? "none"
                        : "width 160ms cubic-bezier(0.22, 1, 0.36, 1)",
                }}
            >
                {left}
            </div>

            {/* Left resizer */}
            <div
                ref={leftResizerRef}
                className="relative flex-shrink-0 cursor-col-resize touch-none"
                style={{ width: RESIZER_HITBOX_WIDTH }}
                onPointerDown={onLeftDown}
                onPointerMove={onLeftMove}
                onPointerUp={onLeftUp}
                onPointerCancel={onLeftUp}
                onLostPointerCapture={onLeftUp}
                onDoubleClick={() => {
                    if (sidebarCollapsed)
                        showSidebarAtWidth(DEFAULT_SIDEBAR_WIDTH);
                    else toggleSidebar();
                }}
            >
                <div
                    className="pointer-events-none absolute bottom-0 top-0 left-1/2 -translate-x-1/2 rounded-full transition-all duration-150"
                    style={{
                        width: RESIZER_VISIBLE_WIDTH,
                        backgroundColor: collapsePreviewLeft
                            ? "color-mix(in srgb, var(--accent) 65%, #ef4444 35%)"
                            : isResizingLeft
                              ? "var(--accent)"
                              : "transparent",
                        boxShadow: isResizingLeft
                            ? "0 0 0 2px color-mix(in srgb, var(--accent) 20%, transparent)"
                            : "none",
                    }}
                />
            </div>

            {/* Center */}
            <div
                className="flex-1 flex flex-col overflow-hidden min-w-0"
                style={{
                    minWidth: rightPanelExpanded ? MIN_CENTER_PEEK_WIDTH : 0,
                }}
            >
                {center}
            </div>

            {/* Right resizer */}
            {right && (
                <div
                    ref={rightResizerRef}
                    className="relative flex-shrink-0 cursor-col-resize touch-none"
                    style={{ width: RESIZER_HITBOX_WIDTH }}
                    onPointerDown={onRightDown}
                    onPointerMove={onRightMove}
                    onPointerUp={onRightUp}
                    onPointerCancel={onRightUp}
                    onLostPointerCapture={onRightUp}
                    onDoubleClick={onRightDoubleClick}
                >
                    <div
                        className="pointer-events-none absolute bottom-0 top-0 left-1/2 -translate-x-1/2 rounded-full transition-all duration-150"
                        style={{
                            width: RESIZER_VISIBLE_WIDTH,
                            backgroundColor: collapsePreviewRight
                                ? "color-mix(in srgb, var(--accent) 65%, #ef4444 35%)"
                                : isResizingRight
                                  ? "var(--accent)"
                                  : "transparent",
                            boxShadow: isResizingRight
                                ? "0 0 0 2px color-mix(in srgb, var(--accent) 20%, transparent)"
                                : "none",
                        }}
                    />
                </div>
            )}

            {/* Right panel */}
            {right && (
                <div
                    ref={rightPanelRef}
                    style={{
                        width: effectiveRight,
                        flexShrink: 0,
                        overflow: "hidden",
                        backgroundColor: "var(--bg-secondary)",
                        borderLeft: rightPanelCollapsed
                            ? "none"
                            : "1px solid var(--border)",
                        transition: isResizingRight
                            ? "none"
                            : "width 160ms cubic-bezier(0.22, 1, 0.36, 1)",
                    }}
                >
                    {right}
                </div>
            )}

            {isResizing && (
                <div className="pointer-events-none absolute inset-0 z-10 cursor-col-resize" />
            )}
        </div>
    );
}
