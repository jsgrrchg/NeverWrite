import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type PointerEvent as ReactPointerEvent,
} from "react";
import { getCurrentWindow } from "@neverwrite/runtime";
import {
    DEFAULT_RIGHT_PANEL_WIDTH,
    DEFAULT_SIDEBAR_WIDTH,
    MIN_RIGHT_PANEL_WIDTH,
    MIN_SIDEBAR_WIDTH,
    useLayoutStore,
} from "../../app/store/layoutStore";
import { getDesktopPlatform } from "../../app/utils/platform";

// On macOS we let BrowserWindow "sidebar" vibrancy show through the left pane,
// so the sidebar region must stay transparent and not paint its own background
// or a hard 1px separator against the editor. Other platforms keep the
// existing opaque chrome.
const SIDEBAR_VIBRANCY_ENABLED = getDesktopPlatform() === "macos";

const RIGHT_COLLAPSE_TRIGGER_WIDTH = 168;
const LEFT_SNAP_POINTS = [DEFAULT_SIDEBAR_WIDTH];
const RIGHT_SNAP_POINTS = [DEFAULT_RIGHT_PANEL_WIDTH, 360, 500];
const SNAP_DISTANCE = 18;
const RESIZER_HITBOX_WIDTH = 10;
const RESIZER_VISIBLE_WIDTH = 1;
const RESIZER_OVERLAP = RESIZER_HITBOX_WIDTH / 2;
const MIN_CENTER_PEEK_WIDTH = 36;

interface HorizontalResizeSession {
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
    const leftPanelRef = useRef<HTMLDivElement>(null);
    const leftResizerRef = useRef<HTMLDivElement>(null);
    const leftSessionRef = useRef<HorizontalResizeSession | null>(null);
    const leftFrameRef = useRef<number | null>(null);

    // Arc-style overlay: when the sidebar is collapsed we show a thin hotspot
    // on the left edge; hovering it reveals the sidebar content as a floating
    // panel without pushing the editor. A short dismiss delay keeps the peek
    // stable while the cursor crosses gaps.
    const [sidebarOverlayVisible, setSidebarOverlayVisible] = useState(false);
    const overlayDismissTimerRef = useRef<number | null>(null);

    const clearOverlayDismissTimer = useCallback(() => {
        if (overlayDismissTimerRef.current !== null) {
            window.clearTimeout(overlayDismissTimerRef.current);
            overlayDismissTimerRef.current = null;
        }
    }, []);

    const showSidebarOverlay = useCallback(() => {
        clearOverlayDismissTimer();
        setSidebarOverlayVisible(true);
    }, [clearOverlayDismissTimer]);

    const scheduleHideSidebarOverlay = useCallback(() => {
        if (overlayDismissTimerRef.current !== null) return;
        overlayDismissTimerRef.current = window.setTimeout(() => {
            overlayDismissTimerRef.current = null;
            setSidebarOverlayVisible(false);
        }, 200);
    }, []);

    // Tear down the timer on unmount; also retract the overlay as soon as the
    // sidebar goes back to docked mode so we never leak a floating copy.
    useEffect(() => {
        return () => {
            clearOverlayDismissTimer();
        };
    }, [clearOverlayDismissTimer]);

    useEffect(() => {
        if (!sidebarCollapsed && sidebarOverlayVisible) {
            clearOverlayDismissTimer();
            const timer = window.setTimeout(() => {
                setSidebarOverlayVisible(false);
            }, 0);
            return () => window.clearTimeout(timer);
        }
    }, [clearOverlayDismissTimer, sidebarCollapsed, sidebarOverlayVisible]);

    // macOS: hide the native traffic-light buttons whenever the sidebar is
    // fully collapsed. They would otherwise float over the empty editor top
    // and break the immersive look. Restore them as soon as the sidebar is
    // docked again (whether via toggle or peek pin). Tauri and other runtimes
    // silently skip this because setTrafficLightsVisible is optional.
    useEffect(() => {
        if (!SIDEBAR_VIBRANCY_ENABLED) return;
        const win = getCurrentWindow();
        // Show while docked or while the peek overlay is up so the user can
        // still reach the buttons from within the revealed sidebar.
        const visible = !sidebarCollapsed || sidebarOverlayVisible;
        void win.setTrafficLightsVisible?.(visible);
    }, [sidebarCollapsed, sidebarOverlayVisible]);

    // Ensure the traffic lights are restored if the layout unmounts while
    // they were hidden (e.g. window swap during vault change).
    useEffect(() => {
        return () => {
            if (!SIDEBAR_VIBRANCY_ENABLED) return;
            void getCurrentWindow().setTrafficLightsVisible?.(true);
        };
    }, []);

    // --- Right panel ---
    const [isResizingRight, setIsResizingRight] = useState(false);
    const [collapsePreviewRight, setCollapsePreviewRight] = useState(false);
    const rightPanelRef = useRef<HTMLDivElement>(null);
    const rightResizerRef = useRef<HTMLDivElement>(null);
    const rightSessionRef = useRef<HorizontalResizeSession | null>(null);
    const rightFrameRef = useRef<number | null>(null);
    const rightCollapsePreviewRef = useRef(false);

    const effectiveLeft = sidebarCollapsed ? 0 : sidebarWidth;
    const effectiveRightForLeftCalc = rightPanelCollapsed ? 0 : rightPanelWidth;
    const maxLeftWidthForLayout = Math.max(
        MIN_SIDEBAR_WIDTH,
        layoutWidth - effectiveRightForLeftCalc - MIN_CENTER_PEEK_WIDTH,
    );
    const maxRightWidthForLayout = Math.max(
        MIN_RIGHT_PANEL_WIDTH,
        layoutWidth - effectiveLeft - MIN_CENTER_PEEK_WIDTH,
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
        // Only draw a hairline separator when vibrancy is off. With vibrancy,
        // the border fights the native material and reads as a hard seam.
        panel.style.borderRight =
            !SIDEBAR_VIBRANCY_ENABLED && width > 0
                ? "1px solid var(--border)"
                : "none";
    }, []);

    const flushLeftWidth = useCallback(() => {
        leftFrameRef.current = null;
        const s = leftSessionRef.current;
        if (!s) return;
        applyLeftWidth(s.pendingWidth);
    }, [applyLeftWidth]);

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
            setIsResizingLeft(false);

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
        [applyLeftWidth, maxLeftWidthForLayout, showSidebarAtWidth],
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
            setIsResizingLeft(true);
            applyLeftWidth(startWidth);
        },
        [applyLeftWidth, sidebarCollapsed, sidebarWidth],
    );

    const onLeftMove = useCallback(
        (e: ReactPointerEvent<HTMLDivElement>) => {
            const s = leftSessionRef.current;
            if (!s || s.pointerId !== e.pointerId) return;
            s.pendingWidth = Math.max(
                MIN_SIDEBAR_WIDTH,
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
        syncRightPreview(s.pendingWidth < RIGHT_COLLAPSE_TRIGGER_WIDTH);
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

            if (s.pendingWidth < RIGHT_COLLAPSE_TRIGGER_WIDTH) {
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
            className="relative flex h-full min-w-0 w-full flex-1 overflow-hidden"
            style={{
                // With vibrancy we must not paint an opaque background here —
                // the center column paints its own bg below. Otherwise we
                // would cover the native material in the sidebar region.
                backgroundColor: SIDEBAR_VIBRANCY_ENABLED
                    ? "transparent"
                    : "var(--bg-primary)",
            }}
        >
            {/* Left sidebar. When
                the sidebar is collapsed we remove the docked copy entirely so
                the peek overlay is the only instance on screen (prevents
                duplicate DOM + double focus traps). */}
            {!sidebarCollapsed && (
                <div
                    ref={leftPanelRef}
                    style={{
                        width: effectiveLeft,
                        flexShrink: 0,
                        overflow: "hidden",
                        // Under vibrancy, paint a translucent tint
                        // (Comando-style 82%/85%) so the native material
                        // still reads through but hover/selection highlights
                        // don't feel harsh.
                        backgroundColor: SIDEBAR_VIBRANCY_ENABLED
                            ? "var(--sidebar-vibrancy-tint)"
                            : "var(--bg-secondary)",
                        borderRight: SIDEBAR_VIBRANCY_ENABLED
                            ? "none"
                            : "1px solid var(--border)",
                        transition: isResizingLeft
                            ? "none"
                            : "width 160ms cubic-bezier(0.22, 1, 0.36, 1)",
                    }}
                >
                    {left}
                </div>
            )}

            {/* Left resizer — hidden while collapsed; the edge hotspot takes
                over to reveal the overlay instead. */}
            {!sidebarCollapsed && (
                <div
                    className="relative shrink-0 cursor-col-resize touch-none"
                    style={{
                        width: RESIZER_HITBOX_WIDTH,
                        marginLeft: -RESIZER_OVERLAP,
                        marginRight: -RESIZER_OVERLAP,
                        zIndex: 2,
                    }}
                    ref={leftResizerRef}
                    onPointerDown={onLeftDown}
                    onPointerMove={onLeftMove}
                    onPointerUp={onLeftUp}
                    onPointerCancel={onLeftUp}
                    onLostPointerCapture={onLeftUp}
                    onDoubleClick={() => {
                        toggleSidebar();
                    }}
                >
                    <div
                        className="pointer-events-none absolute bottom-0 top-0 left-1/2 -translate-x-1/2 rounded-full transition-all duration-150"
                        style={{
                            width: RESIZER_VISIBLE_WIDTH,
                            backgroundColor: isResizingLeft
                                ? "var(--accent)"
                                : "transparent",
                            boxShadow: isResizingLeft
                                ? "0 0 0 2px color-mix(in srgb, var(--accent) 20%, transparent)"
                                : "none",
                        }}
                    />
                </div>
            )}

            {/* Center column + right panel. */}
            <div
                className="flex min-w-0 flex-1 overflow-hidden"
                style={{
                    // Keep the editor surface opaque even when the sidebar
                    // region is translucent — vibrancy is sidebar-only.
                    backgroundColor: "var(--bg-primary)",
                }}
            >
                <div
                    className="flex min-w-0 flex-1 flex-col overflow-hidden"
                    data-testid="app-layout-center-column"
                >
                    <div
                        className="flex min-h-0 flex-1 flex-col overflow-hidden"
                        style={{
                            minWidth: rightPanelExpanded
                                ? MIN_CENTER_PEEK_WIDTH
                                : 0,
                        }}
                    >
                        {center}
                    </div>
                </div>

                {/* Right resizer */}
                {right && (
                    <div
                        ref={rightResizerRef}
                        className="relative shrink-0 cursor-col-resize touch-none"
                        style={{
                            width: RESIZER_HITBOX_WIDTH,
                            marginLeft: -RESIZER_OVERLAP,
                            marginRight: -RESIZER_OVERLAP,
                            zIndex: 2,
                        }}
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
                        data-testid="app-layout-right-panel"
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
            </div>

            {isResizing && (
                <div
                    className="pointer-events-none absolute inset-0 z-10"
                    style={{
                        cursor: "col-resize",
                    }}
                />
            )}

            {/* Arc-style peek: an invisible 8px hotspot on the left edge
                reveals the sidebar as a floating overlay while collapsed.
                The overlay collapses its own hotspot once visible so the
                cursor can cross freely into the panel without retriggering
                the enter handler. */}
            {sidebarCollapsed && (
                <div
                    data-testid="sidebar-peek-hotspot"
                    style={{
                        position: "absolute",
                        left: 0,
                        top: 0,
                        bottom: 0,
                        width: sidebarOverlayVisible ? 0 : 8,
                        zIndex: 15,
                    }}
                    onMouseEnter={showSidebarOverlay}
                />
            )}
            {sidebarCollapsed && sidebarOverlayVisible && (
                <div
                    data-testid="sidebar-peek-overlay"
                    style={{
                        position: "absolute",
                        left: 0,
                        top: 0,
                        bottom: 0,
                        width: sidebarWidth,
                        zIndex: 20,
                        overflow: "hidden",
                        // The peek overlay paints a fully opaque surface so it
                        // reads as a solid floating panel above the editor —
                        // vibrancy is only appropriate for the docked pane,
                        // where it blends with the macOS window material.
                        backgroundColor: "var(--bg-secondary)",
                        borderRight: "1px solid var(--border)",
                        boxShadow:
                            "4px 0 24px rgba(0, 0, 0, 0.22), 1px 0 6px rgba(0, 0, 0, 0.10)",
                    }}
                    onMouseEnter={showSidebarOverlay}
                    onMouseLeave={scheduleHideSidebarOverlay}
                >
                    {left}
                </div>
            )}
        </div>
    );
}
