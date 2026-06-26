import React, {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from "react";
import {
    useEditorStore,
    selectEditorPaneState,
    selectFocusedPaneId,
    type Tab,
    type TerminalTab,
} from "../../app/store/editorStore";
import { canUseExcalidrawRuntime } from "../../app/utils/safeBrowser";
import { Editor } from "./Editor";
import { FileTabView } from "./FileTabView";
import { PdfTabView } from "../pdf/PdfTabView";
import { SearchView } from "../search/SearchView";
import { AIReviewView } from "../ai/components/AIReviewView";
import { AIChatHistoryWorkspaceView } from "../ai/components/AIChatHistoryWorkspaceView";
import { WorkspaceTerminalView } from "../terminal/WorkspaceTerminalView";
import { WorkspacePaneEmptyState } from "./WorkspacePaneEmptyState";
import { resolveEditorPanelView } from "./editorPanelView";

const LazyExcalidrawTabView = React.lazy(() =>
    import("../maps/ExcalidrawTabView").then((m) => ({
        default: m.ExcalidrawTabView,
    })),
);

const LazyGraphTabView = React.lazy(() =>
    import("../graph/GraphTabView").then((m) => ({
        default: m.GraphTabView,
    })),
);

const LazyAIChatSessionView = React.lazy(() =>
    import("../ai/components/AIChatSessionView").then((m) => ({
        default: m.AIChatSessionView,
    })),
);

const EXCALIDRAW_RUNTIME_SUPPORTED = canUseExcalidrawRuntime();

// Fixed reading width of each note panel. The pane scrolls horizontally between
// panels (Andy Matuschak "sliding panes" / Obsidian stacked tabs).
const PANEL_WIDTH = 700;

// Width of a panel's vertical spine (rotated title).
const SPINE_WIDTH = 32;

// How far a panel must scroll before it becomes a spine. With uniform panel
// widths the stack boundaries are deterministic from scrollLeft.
const SCROLL_PER_PANEL = PANEL_WIDTH - SPINE_WIDTH;

const SUPPORTS_RESIZE_OBSERVER = typeof ResizeObserver !== "undefined";

function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max);
}

interface StackedPaneContentProps {
    paneId?: string;
    emptyStateMessage?: string;
}

export function StackedPaneContent({
    paneId,
    emptyStateMessage,
}: StackedPaneContentProps) {
    const pane = useEditorStore((state) => selectEditorPaneState(state, paneId));
    const focusedPaneId = useEditorStore(selectFocusedPaneId);
    const switchTab = useEditorStore((state) => state.switchTab);
    const reorderPaneTabs = useEditorStore((state) => state.reorderPaneTabs);

    const tabs = pane.tabs;
    const tabCount = tabs.length;
    const activeTabId = pane.activeTabId;
    const activeIndex = tabs.findIndex((t) => t.id === activeTabId);
    const isPaneFocused = paneId ? focusedPaneId === paneId : true;

    const scrollRef = useRef<HTMLDivElement>(null);
    const tabCountRef = useRef(tabCount);
    tabCountRef.current = tabCount;

    // How many panels are stacked as spines on each edge. Derived from scroll
    // position so left and right behave identically (no per-panel sticky, so no
    // z-index races or handoff gaps — the rails simply cover panels that have
    // scrolled underneath them).
    const [stack, setStack] = useState<{ left: number; right: number }>({
        left: 0,
        right: 0,
    });

    const recomputeStack = useCallback(() => {
        const container = scrollRef.current;
        if (!container) return;
        const count = tabCountRef.current;
        if (count === 0) return;
        const viewport = container.clientWidth;
        const scrollLeft = container.scrollLeft;
        const maxScroll = Math.max(0, count * PANEL_WIDTH - viewport);

        // Panel i is left-stacked once scrolled past it: scrollLeft >= (i+1)*step.
        let left = Math.floor(scrollLeft / SCROLL_PER_PANEL + 0.0001);
        // Panel (count-1-j) is right-stacked symmetrically from the far edge.
        let right = Math.floor(
            (maxScroll - scrollLeft) / SCROLL_PER_PANEL + 0.0001,
        );
        left = clamp(left, 0, count - 1);
        right = clamp(right, 0, count - 1);
        // Always keep at least one panel revealed between the rails.
        if (left + right > count - 1) {
            right = count - 1 - left;
        }

        setStack((prev) =>
            prev.left === left && prev.right === right
                ? prev
                : { left, right },
        );
    }, []);

    useEffect(() => {
        const container = scrollRef.current;
        if (!container) return;
        let raf = 0;
        const schedule = () => {
            if (typeof requestAnimationFrame === "undefined") {
                recomputeStack();
                return;
            }
            if (raf) return;
            raf = requestAnimationFrame(() => {
                raf = 0;
                recomputeStack();
            });
        };
        container.addEventListener("scroll", schedule, { passive: true });
        let resizeObserver: ResizeObserver | null = null;
        if (SUPPORTS_RESIZE_OBSERVER) {
            resizeObserver = new ResizeObserver(() => recomputeStack());
            resizeObserver.observe(container);
        }
        recomputeStack();
        return () => {
            container.removeEventListener("scroll", schedule);
            resizeObserver?.disconnect();
            if (raf && typeof cancelAnimationFrame !== "undefined") {
                cancelAnimationFrame(raf);
            }
        };
    }, [recomputeStack]);

    // Reveal the active panel: scroll so it becomes the leading content panel
    // just right of the left spine stack. Covers clicks, quick switcher, links
    // and search. Recompute the stack right after so rails update in the same
    // frame.
    useLayoutEffect(() => {
        const container = scrollRef.current;
        if (container && activeIndex >= 0) {
            const viewport = container.clientWidth;
            const maxScroll = Math.max(0, tabCount * PANEL_WIDTH - viewport);
            container.scrollLeft = clamp(
                activeIndex * SCROLL_PER_PANEL,
                0,
                maxScroll,
            );
        }
        recomputeStack();
    }, [activeIndex, tabCount, recomputeStack]);

    // Column reorder via spine drag. MVP scope: within the same pane only.
    const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
    const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
    const handleColumnDrop = useCallback(
        (targetTabId: string) => {
            const sourceTabId = draggingTabId;
            setDraggingTabId(null);
            setDragOverTabId(null);
            if (!paneId || !sourceTabId || sourceTabId === targetTabId) {
                return;
            }
            const currentTabs = pane.tabs;
            const fromIndex = currentTabs.findIndex(
                (t) => t.id === sourceTabId,
            );
            const toIndex = currentTabs.findIndex((t) => t.id === targetTabId);
            if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) {
                return;
            }
            reorderPaneTabs(paneId, fromIndex, toIndex);
        },
        [draggingTabId, pane.tabs, paneId, reorderPaneTabs],
    );

    if (tabCount === 0) {
        if (paneId) {
            return <WorkspacePaneEmptyState paneId={paneId} />;
        }
        return null;
    }

    const firstContent = stack.left;
    const lastContent = tabCount - 1 - stack.right;
    const leftStackTabs = tabs.slice(0, stack.left);
    const rightStackTabs = stack.right > 0 ? tabs.slice(lastContent + 1) : [];

    return (
        <div
            ref={scrollRef}
            role="tablist"
            aria-orientation="horizontal"
            aria-label="Stacked tabs"
            className="relative flex-1 min-h-0 min-w-0 w-full flex flex-row overflow-x-auto overflow-y-hidden"
        >
            {/* Left spine rail: a zero-width sticky anchor whose opaque spines
                cover panels that have scrolled underneath it. */}
            <SpineRail side="left" count={stack.left}>
                {leftStackTabs.map((tab) => (
                    <SpineButton
                        key={tab.id}
                        tab={tab}
                        isActive={tab.id === activeTabId}
                        onClick={() => switchTab(tab.id)}
                    />
                ))}
            </SpineRail>

            {tabs.map((tab, index) => {
                const isActive = tab.id === activeTabId;
                const isContent =
                    index >= firstContent && index <= lastContent;
                return (
                    <StackedColumn
                        key={tab.id}
                        tab={tab}
                        paneId={paneId}
                        isActive={isActive}
                        isPaneFocused={isPaneFocused}
                        isContent={isContent}
                        leftStackWidth={stack.left * SPINE_WIDTH}
                        shouldMount={isActive || isContent}
                        emptyStateMessage={emptyStateMessage}
                        isDragging={draggingTabId === tab.id}
                        isDragOver={
                            dragOverTabId === tab.id &&
                            draggingTabId !== null &&
                            draggingTabId !== tab.id
                        }
                        onActivate={() => switchTab(tab.id)}
                        onDragStart={() => setDraggingTabId(tab.id)}
                        onDragEnter={() => {
                            if (draggingTabId && draggingTabId !== tab.id) {
                                setDragOverTabId(tab.id);
                            }
                        }}
                        onDrop={() => handleColumnDrop(tab.id)}
                        onDragEnd={() => {
                            setDraggingTabId(null);
                            setDragOverTabId(null);
                        }}
                    />
                );
            })}

            <SpineRail side="right" count={stack.right}>
                {rightStackTabs.map((tab) => (
                    <SpineButton
                        key={tab.id}
                        tab={tab}
                        isActive={tab.id === activeTabId}
                        onClick={() => switchTab(tab.id)}
                    />
                ))}
            </SpineRail>
        </div>
    );
}

// A zero-width sticky anchor pinned to one edge; its absolutely-positioned,
// opaque child row of spines overlays panels scrolling underneath without
// taking layout space (so it never shifts the scrollable content).
function SpineRail({
    side,
    count,
    children,
}: {
    side: "left" | "right";
    count: number;
    children: React.ReactNode;
}) {
    if (count <= 0) return null;
    return (
        <div
            className="pointer-events-none sticky top-0 self-stretch"
            style={{ [side]: 0, width: 0, zIndex: 50 } as React.CSSProperties}
        >
            <div
                className="absolute inset-y-0 flex flex-row"
                style={{ [side]: 0 } as React.CSSProperties}
            >
                {children}
            </div>
        </div>
    );
}

function SpineButton({
    tab,
    isActive,
    onClick,
}: {
    tab: Tab;
    isActive: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={onClick}
            title={tab.title}
            className="pointer-events-auto flex h-full items-center justify-center py-3"
            style={{
                width: SPINE_WIDTH,
                flexShrink: 0,
                cursor: "pointer",
                background: isActive
                    ? "var(--bg-primary)"
                    : "var(--bg-secondary)",
                borderRight: "1px solid var(--border)",
                color: isActive
                    ? "var(--text-primary)"
                    : "var(--text-secondary)",
            }}
        >
            <span
                className="truncate text-[12px] font-medium"
                style={{
                    writingMode: "vertical-rl",
                    transform: "rotate(180deg)",
                    maxHeight: "100%",
                }}
            >
                {tab.title}
            </span>
        </button>
    );
}

interface StackedColumnProps {
    tab: Tab;
    paneId?: string;
    isActive: boolean;
    isPaneFocused: boolean;
    isContent: boolean;
    leftStackWidth: number;
    shouldMount: boolean;
    emptyStateMessage?: string;
    isDragging: boolean;
    isDragOver: boolean;
    onActivate: () => void;
    onDragStart: () => void;
    onDragEnter: () => void;
    onDrop: () => void;
    onDragEnd: () => void;
}

function StackedColumn({
    tab,
    paneId,
    isActive,
    isPaneFocused,
    isContent,
    leftStackWidth,
    shouldMount,
    emptyStateMessage,
    isDragging,
    isDragOver,
    onActivate,
    onDragStart,
    onDragEnter,
    onDrop,
    onDragEnd,
}: StackedColumnProps) {
    const dropTargetProps = {
        onDragEnter,
        onDragOver: (event: React.DragEvent) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
        },
        onDrop: (event: React.DragEvent) => {
            event.preventDefault();
            onDrop();
        },
    };

    return (
        <div
            data-stacked-column-id={tab.id}
            data-stacked-column-active={isActive ? "true" : undefined}
            // No overflow:hidden here — it would become the sticky containing
            // block and stop the in-flow spine from pinning. Content clipping is
            // handled by the inner content wrapper instead.
            className="relative flex h-full min-h-0"
            style={{
                width: PANEL_WIDTH,
                flexShrink: 0,
                background: "var(--bg-primary)",
                borderRight: "1px solid var(--border)",
                opacity: isDragging ? 0.5 : 1,
            }}
            onMouseDownCapture={() => {
                if (!isActive) onActivate();
            }}
            {...dropTargetProps}
        >
            {/* The in-flow spine only renders while the panel is content; once it
                is fully scrolled under a rail, the rail's duplicate represents
                it. It is sticky so the leading panel's spine stays pinned at the
                rail edge as the content scrolls (this is what keeps the very
                first panel from sliding away when no rail covers it yet). */}
            {isContent && (
                <StackedColumnSpine
                    title={tab.title}
                    isActive={isActive}
                    isDragOver={isDragOver}
                    stickyLeft={leftStackWidth}
                    onClick={onActivate}
                    onDragStart={onDragStart}
                    onDragEnd={onDragEnd}
                />
            )}
            <div
                className="absolute inset-y-0 right-0 overflow-hidden"
                style={{ left: SPINE_WIDTH }}
            >
                {shouldMount ? (
                    <StackedColumnBody
                        paneId={paneId}
                        tab={tab}
                        isActive={isActive}
                        isPaneFocused={isPaneFocused}
                        emptyStateMessage={emptyStateMessage}
                    />
                ) : (
                    <StackedColumnSkeleton />
                )}
            </div>
        </div>
    );
}

// The canonical, in-flow spine for a panel (role=tab). When the panel scrolls
// under a rail this spine is covered by the rail's opaque duplicate.
function StackedColumnSpine({
    title,
    isActive,
    isDragOver,
    stickyLeft,
    onClick,
    onDragStart,
    onDragEnd,
}: {
    title: string;
    isActive: boolean;
    isDragOver: boolean;
    stickyLeft: number;
    onClick: () => void;
    onDragStart: () => void;
    onDragEnd: () => void;
}) {
    return (
        <button
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={onClick}
            draggable
            onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                onDragStart();
            }}
            onDragEnd={onDragEnd}
            title={title}
            className="z-20 flex shrink-0 items-center justify-center py-3 self-stretch"
            style={{
                position: "sticky",
                left: stickyLeft,
                width: SPINE_WIDTH,
                cursor: "grab",
                background: isActive
                    ? "var(--bg-primary)"
                    : "var(--bg-secondary)",
                borderRight: isDragOver
                    ? "2px solid var(--accent)"
                    : "1px solid var(--border)",
                boxShadow: isActive ? "inset 2px 0 0 var(--accent)" : "none",
                color: isActive
                    ? "var(--text-primary)"
                    : "var(--text-secondary)",
            }}
        >
            <span
                className="truncate text-[12px] font-medium"
                style={{
                    writingMode: "vertical-rl",
                    transform: "rotate(180deg)",
                    maxHeight: "100%",
                }}
            >
                {title}
            </span>
        </button>
    );
}

function StackedColumnSkeleton() {
    return (
        <div
            className="h-full w-full"
            aria-hidden="true"
            style={{ background: "var(--bg-primary)" }}
        />
    );
}

interface StackedColumnBodyProps {
    paneId?: string;
    tab: Tab;
    isActive: boolean;
    isPaneFocused: boolean;
    emptyStateMessage?: string;
}

function StackedColumnBody({
    paneId,
    tab,
    isActive,
    isPaneFocused,
    emptyStateMessage,
}: StackedColumnBodyProps) {
    const view = resolveEditorPanelView(tab);

    switch (view) {
        // tabId-aware views: every column renders its own content independently.
        case "editor":
            return (
                <Editor
                    paneId={paneId}
                    tabId={tab.id}
                    emptyStateMessage={emptyStateMessage}
                    isVisible={isActive}
                />
            );
        case "file":
            return <FileTabView paneId={paneId} tabId={tab.id} />;
        case "pdf":
            return <PdfTabView paneId={paneId} tabId={tab.id} />;
        case "search":
            return <SearchView key={tab.id} tabId={tab.id} />;
        case "terminal":
            return (
                <WorkspaceTerminalView
                    tab={tab as TerminalTab}
                    active={isActive}
                    activePane={isPaneFocused}
                />
            );
        // Views that still resolve the pane's active tab. They only show real
        // content for the active column; inactive columns show a lightweight
        // placeholder until activated. (Cross-instance support is a follow-up.)
        case "ai-chat":
            return isActive ? (
                <React.Suspense fallback={null}>
                    <LazyAIChatSessionView paneId={paneId} />
                </React.Suspense>
            ) : (
                <StackedColumnPlaceholder tab={tab} />
            );
        case "ai-review":
            return isActive ? (
                <AIReviewView paneId={paneId} />
            ) : (
                <StackedColumnPlaceholder tab={tab} />
            );
        case "ai-chat-history":
            return isActive ? (
                <AIChatHistoryWorkspaceView />
            ) : (
                <StackedColumnPlaceholder tab={tab} />
            );
        case "graph":
            return isActive ? (
                <React.Suspense fallback={null}>
                    <LazyGraphTabView isVisible={isActive} />
                </React.Suspense>
            ) : (
                <StackedColumnPlaceholder tab={tab} />
            );
        case "map":
            if (!EXCALIDRAW_RUNTIME_SUPPORTED) {
                return <StackedColumnPlaceholder tab={tab} />;
            }
            return isActive ? (
                <React.Suspense fallback={null}>
                    <LazyExcalidrawTabView paneId={paneId} />
                </React.Suspense>
            ) : (
                <StackedColumnPlaceholder tab={tab} />
            );
        default:
            return <StackedColumnPlaceholder tab={tab} />;
    }
}

function StackedColumnPlaceholder({ tab }: { tab: Tab }) {
    return (
        <div
            className="h-full w-full flex items-center justify-center p-6 text-center text-[12px]"
            style={{ color: "var(--text-secondary)" }}
        >
            <span className="truncate">{tab.title}</span>
        </div>
    );
}
