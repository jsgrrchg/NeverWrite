import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type PointerEvent as ReactPointerEvent,
} from "react";
import {
    DEFAULT_SIDEBAR_WIDTH,
    MAX_SIDEBAR_WIDTH,
    MIN_SIDEBAR_WIDTH,
    useLayoutStore,
} from "../../app/store/layoutStore";

const COLLAPSE_TRIGGER_WIDTH = 168;
const SNAP_POINTS = [DEFAULT_SIDEBAR_WIDTH, 320];
const SNAP_DISTANCE = 18;
const RESIZER_HITBOX_WIDTH = 10;
const RESIZER_VISIBLE_WIDTH = 1;

function clampPreviewWidth(width: number) {
    return Math.max(0, Math.min(MAX_SIDEBAR_WIDTH, width));
}

function snapSidebarWidth(width: number) {
    const clamped = Math.max(
        MIN_SIDEBAR_WIDTH,
        Math.min(MAX_SIDEBAR_WIDTH, width),
    );

    const snapTarget = SNAP_POINTS.find(
        (point) => Math.abs(point - clamped) <= SNAP_DISTANCE,
    );

    return snapTarget ?? clamped;
}

interface ResizeSession {
    pointerId: number;
    startX: number;
    startWidth: number;
    pendingWidth: number;
}

interface AppLayoutProps {
    left: React.ReactNode;
    center: React.ReactNode;
}

export function AppLayout({ left, center }: AppLayoutProps) {
    const {
        sidebarCollapsed,
        sidebarWidth,
        collapseSidebarToWidth,
        showSidebarAtWidth,
        toggleSidebar,
    } = useLayoutStore();
    const [isResizing, setIsResizing] = useState(false);
    const [collapsePreview, setCollapsePreview] = useState(false);

    const leftPanelRef = useRef<HTMLDivElement>(null);
    const resizerRef = useRef<HTMLDivElement>(null);
    const resizeSessionRef = useRef<ResizeSession | null>(null);
    const previewFrameRef = useRef<number | null>(null);
    const collapsePreviewRef = useRef(false);

    const applyPanelWidth = useCallback((width: number) => {
        const panel = leftPanelRef.current;
        if (!panel) return;

        panel.style.width = `${width}px`;
        panel.style.borderRight =
            width > 0 ? "1px solid var(--border)" : "none";
    }, []);

    const syncCollapsePreview = useCallback((next: boolean) => {
        if (collapsePreviewRef.current === next) return;
        collapsePreviewRef.current = next;
        setCollapsePreview(next);
    }, []);

    const flushPreviewWidth = useCallback(() => {
        previewFrameRef.current = null;
        const session = resizeSessionRef.current;
        if (!session) return;

        applyPanelWidth(session.pendingWidth);
        syncCollapsePreview(session.pendingWidth < COLLAPSE_TRIGGER_WIDTH);
    }, [applyPanelWidth, syncCollapsePreview]);

    const schedulePreviewWidth = useCallback(() => {
        if (previewFrameRef.current !== null) return;
        previewFrameRef.current =
            window.requestAnimationFrame(flushPreviewWidth);
    }, [flushPreviewWidth]);

    const finishResize = useCallback(
        (pointerId?: number) => {
            const session = resizeSessionRef.current;
            if (!session) return;
            if (pointerId !== undefined && session.pointerId !== pointerId) {
                return;
            }

            if (previewFrameRef.current !== null) {
                window.cancelAnimationFrame(previewFrameRef.current);
                previewFrameRef.current = null;
            }

            const resizer = resizerRef.current;
            if (
                resizer &&
                pointerId !== undefined &&
                resizer.hasPointerCapture(pointerId)
            ) {
                resizer.releasePointerCapture(pointerId);
            }

            applyPanelWidth(session.pendingWidth);
            document.body.classList.remove("resizing-sidebar");
            resizeSessionRef.current = null;
            syncCollapsePreview(false);
            setIsResizing(false);

            if (session.pendingWidth < COLLAPSE_TRIGGER_WIDTH) {
                collapseSidebarToWidth(MIN_SIDEBAR_WIDTH);
                return;
            }

            showSidebarAtWidth(snapSidebarWidth(session.pendingWidth));
        },
        [
            applyPanelWidth,
            collapseSidebarToWidth,
            showSidebarAtWidth,
            syncCollapsePreview,
        ],
    );

    useEffect(() => {
        if (!isResizing) return;

        const stopResize = () => finishResize();

        window.addEventListener("pointerup", stopResize);
        window.addEventListener("pointercancel", stopResize);
        window.addEventListener("mouseup", stopResize);
        window.addEventListener("blur", stopResize);

        const handleVisibilityChange = () => {
            if (document.visibilityState !== "visible") {
                stopResize();
            }
        };

        document.addEventListener("visibilitychange", handleVisibilityChange);

        return () => {
            window.removeEventListener("pointerup", stopResize);
            window.removeEventListener("pointercancel", stopResize);
            window.removeEventListener("mouseup", stopResize);
            window.removeEventListener("blur", stopResize);
            document.removeEventListener(
                "visibilitychange",
                handleVisibilityChange,
            );
        };
    }, [finishResize, isResizing]);

    useEffect(() => {
        return () => {
            if (previewFrameRef.current !== null) {
                window.cancelAnimationFrame(previewFrameRef.current);
            }
            document.body.classList.remove("resizing-sidebar");
        };
    }, []);

    const handleResizePointerDown = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            if (event.button !== 0) return;

            const startWidth = sidebarCollapsed ? 0 : sidebarWidth;
            resizeSessionRef.current = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startWidth,
                pendingWidth: startWidth,
            };

            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            document.body.classList.add("resizing-sidebar");
            syncCollapsePreview(false);
            setIsResizing(true);
            applyPanelWidth(startWidth);
        },
        [applyPanelWidth, sidebarCollapsed, sidebarWidth, syncCollapsePreview],
    );

    const handleResizePointerMove = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            const session = resizeSessionRef.current;
            if (!session || session.pointerId !== event.pointerId) return;

            session.pendingWidth = clampPreviewWidth(
                session.startWidth + event.clientX - session.startX,
            );
            schedulePreviewWidth();
        },
        [schedulePreviewWidth],
    );

    const handleResizePointerUp = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            finishResize(event.pointerId);
        },
        [finishResize],
    );

    const handleResizePointerCancel = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            finishResize(event.pointerId);
        },
        [finishResize],
    );

    const handleResizeDoubleClick = useCallback(() => {
        if (sidebarCollapsed) {
            showSidebarAtWidth(DEFAULT_SIDEBAR_WIDTH);
            return;
        }

        toggleSidebar();
    }, [showSidebarAtWidth, sidebarCollapsed, toggleSidebar]);

    const effectiveLeft = sidebarCollapsed ? 0 : sidebarWidth;

    return (
        <div
            className="relative flex h-full overflow-hidden"
            style={{ backgroundColor: "var(--bg-primary)" }}
        >
            {/* Panel izquierdo (sidebar) */}
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
                    transition: isResizing
                        ? "none"
                        : "width 160ms cubic-bezier(0.22, 1, 0.36, 1)",
                }}
            >
                {left}
            </div>

            {/* Resizer */}
            <div
                ref={resizerRef}
                className="relative flex-shrink-0 cursor-col-resize touch-none"
                style={{ width: RESIZER_HITBOX_WIDTH }}
                onPointerDown={handleResizePointerDown}
                onPointerMove={handleResizePointerMove}
                onPointerUp={handleResizePointerUp}
                onPointerCancel={handleResizePointerCancel}
                onLostPointerCapture={handleResizePointerCancel}
                onDoubleClick={handleResizeDoubleClick}
            >
                <div
                    className="pointer-events-none absolute bottom-0 top-0 left-1/2 -translate-x-1/2 rounded-full transition-all duration-150"
                    style={{
                        width: RESIZER_VISIBLE_WIDTH,
                        backgroundColor: collapsePreview
                            ? "color-mix(in srgb, var(--accent) 65%, #ef4444 35%)"
                            : isResizing
                              ? "var(--accent)"
                              : "transparent",
                        boxShadow: isResizing
                            ? "0 0 0 2px color-mix(in srgb, var(--accent) 20%, transparent)"
                            : "none",
                    }}
                />
            </div>

            {/* Panel central */}
            <div className="flex-1 flex flex-col overflow-hidden">{center}</div>

            {isResizing && (
                <div className="pointer-events-none absolute inset-0 z-10 cursor-col-resize" />
            )}
        </div>
    );
}
