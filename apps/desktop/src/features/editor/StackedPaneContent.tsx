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

// Width of the expanded content panel that sits to the right of a column's
// spine. The pane scrolls horizontally between columns, mirroring Obsidian's
// stacked tabs.
const STACKED_COLUMN_WIDTH = 620;

// Width of a column's always-visible vertical spine (rotated title). Spines
// stack like an accordion; clicking one expands its content panel.
const SPINE_WIDTH = 32;

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

    // Ephemeral per-pane accordion state. A column is expanded when it is the
    // active one OR the user explicitly expanded it; everything else shows just
    // its vertical spine (Obsidian-style accordion). So by default only the
    // active column is open and the rest are collapsed spines.
    const [expandedTabIds, setExpandedTabIds] = useState<ReadonlySet<string>>(
        () => new Set(),
    );
    const expandColumn = useCallback((tabId: string) => {
        setExpandedTabIds((prev) => {
            if (prev.has(tabId)) return prev;
            const next = new Set(prev);
            next.add(tabId);
            return next;
        });
    }, []);
    const collapseColumn = useCallback((tabId: string) => {
        setExpandedTabIds((prev) => {
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
            role="tablist"
            aria-orientation="horizontal"
            aria-label="Stacked tabs"
            className="relative flex-1 min-h-0 min-w-0 w-full flex flex-row overflow-x-auto overflow-y-hidden"
        >
            {tabs.map((tab) => {
                const isActive = tab.id === activeTabId;
                // Expanded when active or explicitly expanded by the user.
                const isExpanded = isActive || expandedTabIds.has(tab.id);
                // Mount the heavy body only when expanded and (active or near
                // the viewport). Mount everything when IO is unavailable.
                const shouldMount =
                    isExpanded &&
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
                        isExpanded={isExpanded}
                        shouldMount={shouldMount}
                        emptyStateMessage={emptyStateMessage}
                        isDragging={draggingTabId === tab.id}
                        isDragOver={
                            dragOverTabId === tab.id &&
                            draggingTabId !== null &&
                            draggingTabId !== tab.id
                        }
                        onSpineClick={() => {
                            if (isExpanded && !isActive) {
                                // Toggle an already-open, non-active column shut.
                                collapseColumn(tab.id);
                            } else {
                                // Open and activate a collapsed column.
                                expandColumn(tab.id);
                                switchTab(tab.id);
                            }
                        }}
                        onActivate={() => {
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
    isExpanded: boolean;
    shouldMount: boolean;
    emptyStateMessage?: string;
    isDragging: boolean;
    isDragOver: boolean;
    onSpineClick: () => void;
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
    isActive,
    isPaneFocused,
    isExpanded,
    shouldMount,
    emptyStateMessage,
    isDragging,
    isDragOver,
    onSpineClick,
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
            data-stacked-column-expanded={isExpanded ? "true" : undefined}
            className="relative flex h-full min-h-0 flex-row overflow-hidden"
            style={{
                flexShrink: 0,
                borderLeft: isDragOver
                    ? "2px solid var(--accent)"
                    : "1px solid var(--border)",
                opacity: isDragging ? 0.5 : 1,
            }}
            {...dropTargetProps}
        >
            <StackedColumnSpine
                title={tab.title}
                isActive={isActive}
                isExpanded={isExpanded}
                onClick={onSpineClick}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
            />
            {isExpanded && (
                <div
                    className="relative h-full min-h-0 overflow-hidden"
                    style={{
                        width: STACKED_COLUMN_WIDTH,
                        minWidth: STACKED_COLUMN_WIDTH,
                        flexShrink: 0,
                        borderLeft: "1px solid var(--border)",
                        background: "var(--bg-primary)",
                    }}
                    onMouseDownCapture={() => {
                        if (!isActive) onActivate();
                    }}
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
            )}
        </div>
    );
}

// Always-visible vertical spine carrying the rotated tab title. Spines from
// every column stack side-by-side like an accordion; clicking one toggles its
// content panel open/closed.
function StackedColumnSpine({
    title,
    isActive,
    isExpanded,
    onClick,
    onDragStart,
    onDragEnd,
}: {
    title: string;
    isActive: boolean;
    isExpanded: boolean;
    onClick: () => void;
    onDragStart: () => void;
    onDragEnd: () => void;
}) {
    return (
        <button
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-expanded={isExpanded}
            onClick={onClick}
            draggable
            onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                onDragStart();
            }}
            onDragEnd={onDragEnd}
            title={title}
            className="flex h-full items-center justify-center py-2"
            style={{
                width: SPINE_WIDTH,
                minWidth: SPINE_WIDTH,
                flexShrink: 0,
                cursor: "grab",
                background: isActive
                    ? "var(--bg-primary)"
                    : "var(--bg-secondary)",
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
