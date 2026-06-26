import React, { useCallback, useEffect, useRef, useState } from "react";
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

// A panel's body only counts as "revealed" (worth mounting its heavy editor)
// once more than its spine plus this buffer is visible.
const CONTENT_REVEAL_BUFFER_PX = 64;

const SUPPORTS_INTERSECTION_OBSERVER =
    typeof IntersectionObserver !== "undefined";
const SUPPORTS_RESIZE_OBSERVER = typeof ResizeObserver !== "undefined";

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
    const activeTabId = pane.activeTabId;
    const activeIndex = tabs.findIndex((t) => t.id === activeTabId);
    const isPaneFocused = paneId ? focusedPaneId === paneId : true;

    const scrollRef = useRef<HTMLDivElement>(null);
    const observerRef = useRef<IntersectionObserver | null>(null);
    const columnElsRef = useRef(new Map<string, HTMLElement>());
    // Tabs whose content panel (beyond the spine) is actually revealed.
    const [revealedTabIds, setRevealedTabIds] = useState<ReadonlySet<string>>(
        () => new Set(),
    );
    // Tabs currently scrolled off the right edge — rendered as a stacked spine
    // overlay pinned to the right (left spines accumulate naturally via sticky).
    const [rightSpineIds, setRightSpineIds] = useState<readonly string[]>([]);

    const tabsRef = useRef(tabs);
    tabsRef.current = tabs;

    // Heavy panel bodies (CodeMirror, PDF, etc.) only mount once their content
    // is scrolled into view. Left-pinned spines keep the panel technically on
    // screen, so we gate on how much of the panel is visible, not intersection.
    useEffect(() => {
        if (!SUPPORTS_INTERSECTION_OBSERVER) {
            return;
        }
        const root = scrollRef.current;
        if (!root) {
            return;
        }
        const observer = new IntersectionObserver(
            (entries) => {
                setRevealedTabIds((prev) => {
                    const next = new Set(prev);
                    let changed = false;
                    for (const entry of entries) {
                        const id = (entry.target as HTMLElement).dataset
                            .stackedColumnId;
                        if (!id) continue;
                        const revealed =
                            entry.isIntersecting &&
                            entry.intersectionRect.width >
                                SPINE_WIDTH + CONTENT_REVEAL_BUFFER_PX;
                        if (revealed) {
                            if (!next.has(id)) {
                                next.add(id);
                                changed = true;
                            }
                        } else if (next.has(id)) {
                            next.delete(id);
                            changed = true;
                        }
                    }
                    return changed ? next : prev;
                });
            },
            {
                root,
                threshold: Array.from({ length: 11 }, (_, i) => i / 10),
            },
        );
        observerRef.current = observer;
        for (const el of columnElsRef.current.values()) {
            observer.observe(el);
        }
        return () => {
            observer.disconnect();
            observerRef.current = null;
        };
    }, []);

    const registerColumn = useCallback(
        (tabId: string, el: HTMLElement | null) => {
            const map = columnElsRef.current;
            const observer = observerRef.current;
            const previous = map.get(tabId);
            if (previous && previous !== el) {
                observer?.unobserve(previous);
            }
            if (el) {
                map.set(tabId, el);
                observer?.observe(el);
            } else {
                map.delete(tabId);
            }
        },
        [],
    );

    // Panels scrolled off the right edge become a stacked spine overlay on the
    // right. Computed imperatively from geometry on every scroll frame.
    const recomputeRightSpines = useCallback(() => {
        const container = scrollRef.current;
        if (!container) return;
        const containerRect = container.getBoundingClientRect();
        const ids: string[] = [];
        for (const tab of tabsRef.current) {
            const el = columnElsRef.current.get(tab.id);
            if (!el) continue;
            const rect = el.getBoundingClientRect();
            // The panel's content has slid past the right edge (only a spine's
            // worth would remain), so represent it in the right overlay.
            if (rect.left >= containerRect.right - SPINE_WIDTH) {
                ids.push(tab.id);
            }
        }
        setRightSpineIds((prev) =>
            prev.length === ids.length &&
            prev.every((id, i) => id === ids[i])
                ? prev
                : ids,
        );
    }, []);

    useEffect(() => {
        const container = scrollRef.current;
        if (!container) return;
        let raf = 0;
        const schedule = () => {
            if (typeof requestAnimationFrame === "undefined") {
                recomputeRightSpines();
                return;
            }
            if (raf) return;
            raf = requestAnimationFrame(() => {
                raf = 0;
                recomputeRightSpines();
            });
        };
        container.addEventListener("scroll", schedule, { passive: true });
        let resizeObserver: ResizeObserver | null = null;
        if (SUPPORTS_RESIZE_OBSERVER) {
            resizeObserver = new ResizeObserver(() => recomputeRightSpines());
            resizeObserver.observe(container);
        }
        recomputeRightSpines();
        return () => {
            container.removeEventListener("scroll", schedule);
            resizeObserver?.disconnect();
            if (raf && typeof cancelAnimationFrame !== "undefined") {
                cancelAnimationFrame(raf);
            }
        };
    }, [recomputeRightSpines]);

    // Reveal the active panel by scrolling its content out from under the left
    // spine stack — covers clicks, quick switcher, links and search.
    useEffect(() => {
        if (!activeTabId) return;
        const container = scrollRef.current;
        const el = columnElsRef.current.get(activeTabId);
        if (!container || !el) return;
        const leftSpines = Math.max(0, activeIndex) * SPINE_WIDTH;
        container.scrollLeft = Math.max(0, el.offsetLeft - leftSpines);
        recomputeRightSpines();
    }, [activeTabId, activeIndex, recomputeRightSpines]);

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

    if (tabs.length === 0) {
        if (paneId) {
            return <WorkspacePaneEmptyState paneId={paneId} />;
        }
        return null;
    }

    const rightSpineTabs = rightSpineIds
        .map((id) => tabs.find((t) => t.id === id))
        .filter((t): t is Tab => Boolean(t));

    return (
        <div
            ref={scrollRef}
            role="tablist"
            aria-orientation="horizontal"
            aria-label="Stacked tabs"
            className="relative flex-1 min-h-0 min-w-0 w-full flex flex-row overflow-x-auto overflow-y-hidden"
        >
            {tabs.map((tab, index) => {
                const isActive = tab.id === activeTabId;
                // Mount the heavy body when its content is revealed (or always,
                // when IntersectionObserver is unavailable, e.g. tests). The
                // active panel always mounts so it stays interactive.
                const shouldMount =
                    !SUPPORTS_INTERSECTION_OBSERVER ||
                    isActive ||
                    revealedTabIds.has(tab.id);
                return (
                    <StackedColumn
                        key={tab.id}
                        tab={tab}
                        paneId={paneId}
                        index={index}
                        isActive={isActive}
                        isPaneFocused={isPaneFocused}
                        shouldMount={shouldMount}
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
                        registerColumn={registerColumn}
                    />
                );
            })}

            {rightSpineTabs.length > 0 && (
                <div
                    aria-hidden="true"
                    className="pointer-events-none sticky top-0 flex h-full flex-row self-stretch"
                    style={{ right: 0, zIndex: 2000 }}
                >
                    {rightSpineTabs.map((tab) => (
                        <button
                            key={tab.id}
                            type="button"
                            tabIndex={-1}
                            onClick={() => switchTab(tab.id)}
                            title={tab.title}
                            className="pointer-events-auto flex h-full items-center justify-center py-3"
                            style={{
                                width: SPINE_WIDTH,
                                flexShrink: 0,
                                cursor: "pointer",
                                background: "var(--bg-secondary)",
                                borderLeft: "1px solid var(--border)",
                                color: "var(--text-secondary)",
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
                    ))}
                </div>
            )}
        </div>
    );
}

interface StackedColumnProps {
    tab: Tab;
    paneId?: string;
    index: number;
    isActive: boolean;
    isPaneFocused: boolean;
    shouldMount: boolean;
    emptyStateMessage?: string;
    isDragging: boolean;
    isDragOver: boolean;
    onActivate: () => void;
    onDragStart: () => void;
    onDragEnter: () => void;
    onDrop: () => void;
    onDragEnd: () => void;
    registerColumn: (tabId: string, el: HTMLElement | null) => void;
}

function StackedColumn({
    tab,
    paneId,
    index,
    isActive,
    isPaneFocused,
    shouldMount,
    emptyStateMessage,
    isDragging,
    isDragOver,
    onActivate,
    onDragStart,
    onDragEnter,
    onDrop,
    onDragEnd,
    registerColumn,
}: StackedColumnProps) {
    const tabId = tab.id;
    const setRef = useCallback(
        (el: HTMLElement | null) => registerColumn(tabId, el),
        [registerColumn, tabId],
    );

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
            ref={setRef}
            data-stacked-column-id={tabId}
            data-stacked-column-active={isActive ? "true" : undefined}
            className="relative h-full min-h-0 overflow-hidden"
            style={{
                width: PANEL_WIDTH,
                flexShrink: 0,
                // Sticky panels pin their left spine as they scroll off-screen;
                // offsetting each by index * spine width makes the spines stack
                // side-by-side at the left edge instead of overlapping.
                position: "sticky",
                left: index * SPINE_WIDTH,
                zIndex: index,
                background: "var(--bg-primary)",
                borderRight: "1px solid var(--border)",
                boxShadow: "-8px 0 16px -12px rgba(0, 0, 0, 0.35)",
                opacity: isDragging ? 0.5 : 1,
            }}
            onMouseDownCapture={() => {
                if (!isActive) onActivate();
            }}
            {...dropTargetProps}
        >
            <StackedColumnSpine
                title={tab.title}
                isActive={isActive}
                isDragOver={isDragOver}
                onClick={onActivate}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
            />
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

// Always-visible vertical spine carrying the rotated tab title. Pinned at the
// panel's left edge; clicking it scrolls/activates the panel.
function StackedColumnSpine({
    title,
    isActive,
    isDragOver,
    onClick,
    onDragStart,
    onDragEnd,
}: {
    title: string;
    isActive: boolean;
    isDragOver: boolean;
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
            className="absolute inset-y-0 left-0 z-10 flex items-center justify-center py-3"
            style={{
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
