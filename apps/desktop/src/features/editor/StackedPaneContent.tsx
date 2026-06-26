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

// Width of an expanded stacked column. Columns keep a fixed width and the pane
// scrolls horizontally between them, mirroring Obsidian's stacked tabs.
const STACKED_COLUMN_WIDTH = 640;

// Width of a collapsed column spine (rotated title only).
const COLLAPSED_COLUMN_WIDTH = 34;

// Pre-mount columns within this horizontal margin of the viewport so scrolling
// reveals ready content instead of a skeleton.
const COLUMN_PREFETCH_MARGIN_PX = 800;

const SUPPORTS_INTERSECTION_OBSERVER =
    typeof IntersectionObserver !== "undefined";

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
    const isPaneFocused = paneId ? focusedPaneId === paneId : true;

    const scrollRef = useRef<HTMLDivElement>(null);
    const observerRef = useRef<IntersectionObserver | null>(null);
    const columnElsRef = useRef(new Map<string, HTMLElement>());
    const [visibleTabIds, setVisibleTabIds] = useState<ReadonlySet<string>>(
        () => new Set(),
    );

    // Heavy column bodies (CodeMirror, PDF, etc.) only mount while near the
    // viewport. The fixed column width bounds how many intersect at once, which
    // caps the number of simultaneously live editor instances.
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
                setVisibleTabIds((prev) => {
                    const next = new Set(prev);
                    let changed = false;
                    for (const entry of entries) {
                        const id = (entry.target as HTMLElement).dataset
                            .stackedColumnId;
                        if (!id) continue;
                        if (entry.isIntersecting) {
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
                rootMargin: `0px ${COLUMN_PREFETCH_MARGIN_PX}px`,
                threshold: 0,
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

    // Ephemeral per-pane collapse state. The active column is always expanded
    // (derived in StackedColumn), so this only tracks user-collapsed columns.
    const [collapsedTabIds, setCollapsedTabIds] = useState<ReadonlySet<string>>(
        () => new Set(),
    );
    const collapseColumn = useCallback((tabId: string) => {
        setCollapsedTabIds((prev) => {
            if (prev.has(tabId)) return prev;
            const next = new Set(prev);
            next.add(tabId);
            return next;
        });
    }, []);
    const expandColumn = useCallback((tabId: string) => {
        setCollapsedTabIds((prev) => {
            if (!prev.has(tabId)) return prev;
            const next = new Set(prev);
            next.delete(tabId);
            return next;
        });
    }, []);

    // Reveal the active column horizontally whenever it changes — covers both
    // in-pane clicks and external activation (quick switcher, links, search).
    useEffect(() => {
        if (!activeTabId) return;
        const el = columnElsRef.current.get(activeTabId);
        el?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }, [activeTabId]);

    // Column reorder via header drag. MVP scope: within the same pane only.
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

    return (
        <div
            ref={scrollRef}
            className="relative flex-1 min-h-0 min-w-0 w-full flex flex-row overflow-x-auto overflow-y-hidden"
        >
            {tabs.map((tab) => {
                const isActive = tab.id === activeTabId;
                // The active column is always expanded.
                const isCollapsed =
                    !isActive && collapsedTabIds.has(tab.id);
                // Mount the heavy body only when expanded and (active or near
                // the viewport). Mount everything when IO is unavailable.
                const shouldMount =
                    !isCollapsed &&
                    (!SUPPORTS_INTERSECTION_OBSERVER ||
                        isActive ||
                        visibleTabIds.has(tab.id));
                return (
                    <StackedColumn
                        key={tab.id}
                        tab={tab}
                        paneId={paneId}
                        isActive={isActive}
                        isPaneFocused={isPaneFocused}
                        isCollapsed={isCollapsed}
                        shouldMount={shouldMount}
                        emptyStateMessage={emptyStateMessage}
                        isDragging={draggingTabId === tab.id}
                        isDragOver={
                            dragOverTabId === tab.id &&
                            draggingTabId !== null &&
                            draggingTabId !== tab.id
                        }
                        onActivate={() => switchTab(tab.id)}
                        onCollapse={() => collapseColumn(tab.id)}
                        onExpand={() => {
                            expandColumn(tab.id);
                            switchTab(tab.id);
                        }}
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
        </div>
    );
}

interface StackedColumnProps {
    tab: Tab;
    paneId?: string;
    isActive: boolean;
    isPaneFocused: boolean;
    isCollapsed: boolean;
    shouldMount: boolean;
    emptyStateMessage?: string;
    isDragging: boolean;
    isDragOver: boolean;
    onActivate: () => void;
    onCollapse: () => void;
    onExpand: () => void;
    onDragStart: () => void;
    onDragEnter: () => void;
    onDrop: () => void;
    onDragEnd: () => void;
    registerColumn: (tabId: string, el: HTMLElement | null) => void;
}

function StackedColumn({
    tab,
    paneId,
    isActive,
    isPaneFocused,
    isCollapsed,
    shouldMount,
    emptyStateMessage,
    isDragging,
    isDragOver,
    onActivate,
    onCollapse,
    onExpand,
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

    // Drop-target wiring shared by collapsed and expanded columns.
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
    const dragOverBorder = isDragOver
        ? "2px solid var(--accent)"
        : "1px solid var(--border)";

    if (isCollapsed) {
        return (
            <div
                ref={setRef}
                data-stacked-column-id={tabId}
                data-stacked-column-collapsed="true"
                className="relative flex h-full min-h-0 flex-col overflow-hidden"
                style={{
                    width: COLLAPSED_COLUMN_WIDTH,
                    minWidth: COLLAPSED_COLUMN_WIDTH,
                    flexShrink: 0,
                    borderLeft: dragOverBorder,
                    borderRight: "1px solid var(--border)",
                    background: "var(--bg-secondary)",
                    opacity: isDragging ? 0.5 : 1,
                }}
                {...dropTargetProps}
            >
                <StackedColumnSpine
                    title={tab.title}
                    onExpand={onExpand}
                    onDragStart={onDragStart}
                    onDragEnd={onDragEnd}
                />
            </div>
        );
    }

    return (
        <div
            ref={setRef}
            data-stacked-column-id={tabId}
            data-stacked-column-active={isActive ? "true" : undefined}
            className="relative flex h-full min-h-0 flex-col overflow-hidden"
            style={{
                width: STACKED_COLUMN_WIDTH,
                minWidth: STACKED_COLUMN_WIDTH,
                flexShrink: 0,
                borderLeft: dragOverBorder,
                borderRight: "1px solid var(--border)",
                background: "var(--bg-primary)",
                opacity: isDragging ? 0.5 : 1,
            }}
            {...dropTargetProps}
        >
            <StackedColumnHeader
                title={tab.title}
                isActive={isActive}
                onActivate={onActivate}
                onCollapse={onCollapse}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
            />
            <div className="relative flex-1 min-h-0 min-w-0 overflow-hidden">
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

function StackedColumnSpine({
    title,
    onExpand,
    onDragStart,
    onDragEnd,
}: {
    title: string;
    onExpand: () => void;
    onDragStart: () => void;
    onDragEnd: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onExpand}
            draggable
            onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                onDragStart();
            }}
            onDragEnd={onDragEnd}
            aria-label={`Expand ${title}`}
            title={title}
            className="flex h-full w-full items-center justify-center py-2"
            style={{ background: "var(--bg-secondary)", cursor: "grab" }}
        >
            <span
                className="truncate text-[12px] font-medium"
                style={{
                    color: "var(--text-secondary)",
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

function StackedColumnHeader({
    title,
    isActive,
    onActivate,
    onCollapse,
    onDragStart,
    onDragEnd,
}: {
    title: string;
    isActive: boolean;
    onActivate: () => void;
    onCollapse: () => void;
    onDragStart: () => void;
    onDragEnd: () => void;
}) {
    return (
        <div
            className="flex shrink-0 items-center"
            style={{
                height: 33,
                minHeight: 33,
                boxSizing: "border-box",
                borderBottom: "1px solid var(--border)",
                background: isActive
                    ? "var(--bg-primary)"
                    : "var(--bg-secondary)",
                boxShadow: isActive ? "inset 0 2px 0 var(--accent)" : "none",
            }}
        >
            <button
                type="button"
                onClick={onActivate}
                draggable
                onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    onDragStart();
                }}
                onDragEnd={onDragEnd}
                className="flex min-w-0 flex-1 items-center px-3 text-left"
                title={title}
                style={{ height: "100%", cursor: "grab" }}
            >
                <span
                    className="min-w-0 flex-1 truncate text-[12px] font-medium"
                    style={{
                        color: isActive
                            ? "var(--text-primary)"
                            : "var(--text-secondary)",
                    }}
                >
                    {title}
                </span>
            </button>
            <button
                type="button"
                onClick={onCollapse}
                aria-label={`Collapse ${title}`}
                title="Collapse"
                className="flex shrink-0 items-center justify-center px-2"
                style={{ height: "100%", color: "var(--text-secondary)" }}
            >
                <svg
                    width="12"
                    height="12"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                >
                    <path d="M10 3L5 8l5 5" />
                </svg>
            </button>
        </div>
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
