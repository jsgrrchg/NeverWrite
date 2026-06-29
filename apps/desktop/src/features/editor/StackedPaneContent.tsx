import React, {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { confirm } from "@neverwrite/runtime";
import {
    useEditorStore,
    selectEditorPaneState,
    selectEditorWorkspaceTabs,
    selectFocusedPaneId,
    type Tab,
    type TerminalTab,
} from "../../app/store/editorStore";
import { useChatStore } from "../ai/store/chatStore";
import {
    findActiveSessionsAffectedByClose,
    getCloseTabsConfirmationMessage,
} from "./tabClosePolicy";
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
import { renderEditorTabLeadingIcon } from "./editorTabIcons";
import { useWorkspaceTabDrag } from "./useWorkspaceTabDrag";

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

// Preferred reading width of each note panel. The pane scrolls horizontally
// between panels (Andy Matuschak "sliding panes" / Obsidian stacked tabs).
const PREFERRED_PANEL_WIDTH = 600;

// Width of a panel's vertical spine (rotated title).
const SPINE_WIDTH = 32;

// Floor for the panel width so a panel never collapses to (almost) nothing when
// the pane is very narrow.
const MIN_PANEL_WIDTH = 280;

// Keep a couple of recently-hidden columns alive so fast horizontal navigation
// does not destroy editor/PDF scroll state on every spine transition.
const EXTRA_KEEP_ALIVE_STACKED_COLUMNS = 2;

const SUPPORTS_RESIZE_OBSERVER = typeof ResizeObserver !== "undefined";

function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max);
}

function areStringArraysEqual(left: readonly string[], right: readonly string[]) {
    if (left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
}

// Panels never exceed the available width, so a usable content panel always
// fits (otherwise a wide fixed panel in a narrow pane shows only spines).
function resolvePanelWidth(viewport: number) {
    if (viewport <= 0) return PREFERRED_PANEL_WIDTH;
    return clamp(viewport, MIN_PANEL_WIDTH, PREFERRED_PANEL_WIDTH);
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
    const chatSessionsById = useChatStore((state) => state.sessionsById);
    const switchTab = useEditorStore((state) => state.switchTab);
    const closeTab = useEditorStore((state) => state.closeTab);
    const reorderPaneTabs = useEditorStore((state) => state.reorderPaneTabs);
    const moveTabToPane = useEditorStore((state) => state.moveTabToPane);
    const moveTabToPaneDropTarget = useEditorStore(
        (state) => state.moveTabToPaneDropTarget,
    );

    const tabs = pane.tabs;
    const tabCount = tabs.length;
    const activeTabId = pane.activeTabId;
    const activeIndex = tabs.findIndex((t) => t.id === activeTabId);
    const isPaneFocused = paneId ? focusedPaneId === paneId : true;

    const scrollRef = useRef<HTMLDivElement>(null);
    const tabCountRef = useRef(tabCount);
    const previousBaseMountedTabIdsRef = useRef<string[]>([]);
    const [warmMountedTabIds, setWarmMountedTabIds] = useState<string[]>([]);
    tabCountRef.current = tabCount;

    // How many panels are stacked as spines on each edge. Derived from scroll
    // position so left and right behave identically (no per-panel sticky, so no
    // z-index races or handoff gaps — the rails simply cover panels that have
    // scrolled underneath them).
    const [stack, setStack] = useState<{
        left: number;
        right: number;
        panelWidth: number;
    }>({
        left: 0,
        right: 0,
        panelWidth: PREFERRED_PANEL_WIDTH,
    });

    const recomputeStack = useCallback(() => {
        const container = scrollRef.current;
        if (!container) return;
        const count = tabCountRef.current;
        if (count === 0) return;
        const viewport = container.clientWidth;
        const panelWidth = resolvePanelWidth(viewport);
        const scrollPerPanel = panelWidth - SPINE_WIDTH;
        const scrollLeft = container.scrollLeft;
        const maxScroll = Math.max(0, count * panelWidth - viewport);

        // Panel i is left-stacked once scrolled past it: scrollLeft >= (i+1)*step.
        let left = Math.floor(scrollLeft / scrollPerPanel + 0.0001);
        // Panel (count-1-j) is right-stacked symmetrically from the far edge.
        let right = Math.floor(
            (maxScroll - scrollLeft) / scrollPerPanel + 0.0001,
        );
        left = clamp(left, 0, count - 1);
        right = clamp(right, 0, count - 1);
        // Always keep at least one panel revealed between the rails.
        if (left + right > count - 1) {
            right = count - 1 - left;
        }

        setStack((prev) =>
            prev.left === left &&
            prev.right === right &&
            prev.panelWidth === panelWidth
                ? prev
                : { left, right, panelWidth },
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

    // Reveal the active panel ONLY when it isn't already visible — i.e. when it
    // is collapsed into a spine rail (off-screen). If the active column is
    // already an open content column, leave the scroll position alone so that
    // clicking one visible column doesn't shove its neighbours into the rails.
    // (This still reveals on activation from the quick switcher, links, search,
    // etc. when the target is off-screen.)
    useLayoutEffect(() => {
        const container = scrollRef.current;
        if (container && activeIndex >= 0) {
            const viewport = container.clientWidth;
            const panelWidth = resolvePanelWidth(viewport);
            const scrollPerPanel = panelWidth - SPINE_WIDTH;
            const maxScroll = Math.max(0, tabCount * panelWidth - viewport);
            const scrollLeft = container.scrollLeft;

            // Rail counts at the current scroll position.
            const left = clamp(
                Math.floor(scrollLeft / scrollPerPanel + 0.0001),
                0,
                tabCount - 1,
            );
            let right = clamp(
                Math.floor((maxScroll - scrollLeft) / scrollPerPanel + 0.0001),
                0,
                tabCount - 1,
            );
            if (left + right > tabCount - 1) {
                right = tabCount - 1 - left;
            }

            const alreadyVisible =
                activeIndex >= left && activeIndex <= tabCount - 1 - right;
            if (!alreadyVisible) {
                container.scrollLeft = clamp(
                    activeIndex * scrollPerPanel,
                    0,
                    maxScroll,
                );
            }
        }
        recomputeStack();
    }, [activeIndex, tabCount, recomputeStack]);

    // Pointer-based drag shared with the normal tab strip: lets a column be
    // reordered within the pane AND dragged out to other panes / new splits,
    // using the same drop-target resolution as the classic strip.
    const {
        dragPreviewNodeRef,
        dragPreviewTabId,
        draggingTabId,
        projectedDropIndex,
        tabStripRef,
        registerTabNode,
        handlePointerDown,
        handlePointerMove,
        handlePointerUp,
        handleLostPointerCapture,
        consumeSuppressedClick,
    } = useWorkspaceTabDrag({
        tabs,
        sourcePaneId: paneId,
        onCommitReorder: (fromIndex, toIndex) => {
            if (paneId) reorderPaneTabs(paneId, fromIndex, toIndex);
        },
        onCommitWorkspaceDrop: (tabId, target) => {
            if (target.type === "strip") {
                moveTabToPane(tabId, target.paneId, target.index);
                return;
            }
            if (target.type === "pane-center") {
                if (target.paneId !== paneId) {
                    moveTabToPane(tabId, target.paneId);
                }
                return;
            }
            moveTabToPaneDropTarget(tabId, target.paneId, target.direction);
        },
        onActivate: switchTab,
        liveReorder: false,
    });

    // The horizontal column row is both the stack scroll container and the drag
    // hook's geometry container, so both refs point at the same node.
    const setScrollContainer = useCallback(
        (node: HTMLDivElement | null) => {
            scrollRef.current = node;
            (tabStripRef as React.MutableRefObject<HTMLDivElement | null>).current =
                node;
        },
        [tabStripRef],
    );

    const handleSpineClick = useCallback(
        (tabId: string) => {
            if (consumeSuppressedClick(tabId)) return;
            switchTab(tabId);
        },
        [consumeSuppressedClick, switchTab],
    );

    // Same close flow as the normal tab strip: warn before closing tabs tied to
    // active chat sessions, then close.
    const requestCloseTab = useCallback(
        async (tabId: string) => {
            const tab = selectEditorWorkspaceTabs(
                useEditorStore.getState(),
            ).find((candidate) => candidate.id === tabId);
            if (!tab) return;
            const affected = findActiveSessionsAffectedByClose(
                [tab],
                useChatStore.getState().sessionsById,
            );
            const confirmationMessage =
                getCloseTabsConfirmationMessage(affected);
            if (
                confirmationMessage !== null &&
                !(await confirm(confirmationMessage))
            ) {
                return;
            }
            closeTab(tab.id);
        },
        [closeTab],
    );

    const dragPreviewTab =
        dragPreviewTabId === null
            ? null
            : (tabs.find((tab) => tab.id === dragPreviewTabId) ?? null);

    // Insertion indicator for reordering columns within this pane. (Dragging a
    // column to ANOTHER pane is previewed by the global cross-pane overlay.)
    const draggingOriginalIndex = draggingTabId
        ? tabs.findIndex((tab) => tab.id === draggingTabId)
        : -1;
    const insertionIndicatorIndex =
        draggingOriginalIndex === -1 || projectedDropIndex == null
            ? null
            : projectedDropIndex > draggingOriginalIndex
              ? projectedDropIndex + 1
              : projectedDropIndex;
    const insertionIndicatorRef = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const indicator = insertionIndicatorRef.current;
        if (!indicator) return;
        const strip = scrollRef.current;
        if (insertionIndicatorIndex === null || !strip) {
            indicator.style.display = "none";
            return;
        }
        const columnNodes = Array.from(
            strip.querySelectorAll<HTMLElement>("[data-pane-tab-id]"),
        );
        if (columnNodes.length === 0) {
            indicator.style.display = "none";
            return;
        }
        let left: number;
        if (insertionIndicatorIndex < columnNodes.length) {
            left = columnNodes[insertionIndicatorIndex].offsetLeft;
        } else {
            const last = columnNodes[columnNodes.length - 1];
            left = last.offsetLeft + last.offsetWidth;
        }
        indicator.style.display = "";
        indicator.style.transform = `translateX(${left - 1}px)`;
    }, [insertionIndicatorIndex]);

    const firstContent = stack.left;
    const lastContent = tabCount - 1 - stack.right;
    const leftStackTabs = tabs.slice(0, stack.left);
    const rightStackTabs = stack.right > 0 ? tabs.slice(lastContent + 1) : [];
    const tabIds = useMemo(() => tabs.map((tab) => tab.id), [tabs]);
    const baseMountedTabIds = useMemo(
        () =>
            tabs
                .filter((tab, index) => {
                    if (tab.id === activeTabId) return true;
                    return index >= firstContent && index <= lastContent;
                })
                .map((tab) => tab.id),
        [activeTabId, firstContent, lastContent, tabs],
    );
    const openTabIdSet = useMemo(() => new Set(tabIds), [tabIds]);
    const baseMountedTabIdSet = useMemo(
        () => new Set(baseMountedTabIds),
        [baseMountedTabIds],
    );
    const previousHiddenBaseTabIds = useMemo(
        () =>
            previousBaseMountedTabIdsRef.current.filter(
                (tabId) =>
                    openTabIdSet.has(tabId) &&
                    !baseMountedTabIdSet.has(tabId),
            ),
        [baseMountedTabIdSet, openTabIdSet],
    );
    const keepAliveTabIdSet = useMemo(
        () =>
            new Set([
                ...baseMountedTabIds,
                ...warmMountedTabIds,
                ...previousHiddenBaseTabIds,
            ]),
        [baseMountedTabIds, previousHiddenBaseTabIds, warmMountedTabIds],
    );

    useLayoutEffect(() => {
        const demotedTabIds = previousBaseMountedTabIdsRef.current.filter(
            (tabId) =>
                openTabIdSet.has(tabId) && !baseMountedTabIdSet.has(tabId),
        );

        setWarmMountedTabIds((current) => {
            const demotedSet = new Set(demotedTabIds);
            const carriedTabIds = current.filter(
                (tabId) =>
                    openTabIdSet.has(tabId) &&
                    !baseMountedTabIdSet.has(tabId) &&
                    !demotedSet.has(tabId),
            );
            const next = [...demotedTabIds, ...carriedTabIds].slice(
                0,
                EXTRA_KEEP_ALIVE_STACKED_COLUMNS,
            );
            return areStringArraysEqual(current, next) ? current : next;
        });

        previousBaseMountedTabIdsRef.current = baseMountedTabIds;
    }, [
        baseMountedTabIds,
        baseMountedTabIdSet,
        openTabIdSet,
    ]);

    if (tabCount === 0) {
        if (paneId) {
            return <WorkspacePaneEmptyState paneId={paneId} />;
        }
        return null;
    }

    return (
        <div
            ref={setScrollContainer}
            role="tablist"
            aria-orientation="horizontal"
            aria-label="Stacked tabs"
            // data-pane-tab-strip lets the shared drop resolver treat this
            // column row as a drop target, so tabs from other panes land here
            // (inserted at a column position) just like the classic tab strip.
            data-pane-tab-strip={paneId}
            // isolate: keep the sticky spine rails' z-index contained so they
            // can't paint over sibling overlays (e.g. the right peek panel).
            className="isolate relative flex-1 min-h-0 min-w-0 w-full flex flex-row overflow-x-auto overflow-y-hidden"
        >
            {/* Left spine rail: a zero-width sticky anchor whose opaque spines
                cover panels that have scrolled underneath it. */}
            <SpineRail side="left" count={stack.left}>
                {leftStackTabs.map((tab) => (
                    <SpineButton
                        key={tab.id}
                        tab={tab}
                        isActive={tab.id === activeTabId}
                        icon={renderEditorTabLeadingIcon(
                            tab,
                            chatSessionsById,
                        )}
                        onClick={() => switchTab(tab.id)}
                        onRequestClose={() => void requestCloseTab(tab.id)}
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
                        index={index}
                        isActive={isActive}
                        isPaneFocused={isPaneFocused}
                        isContent={isContent}
                        leftStackWidth={stack.left * SPINE_WIDTH}
                        panelWidth={stack.panelWidth}
                        shouldMount={keepAliveTabIdSet.has(tab.id)}
                        emptyStateMessage={emptyStateMessage}
                        isDragging={draggingTabId === tab.id}
                        icon={renderEditorTabLeadingIcon(
                            tab,
                            chatSessionsById,
                        )}
                        registerTabNode={registerTabNode}
                        onSpineClick={() => handleSpineClick(tab.id)}
                        onRequestClose={() => void requestCloseTab(tab.id)}
                        onActivate={() => switchTab(tab.id)}
                        onPointerDown={handlePointerDown}
                        onPointerMove={handlePointerMove}
                        onPointerUp={handlePointerUp}
                        onLostPointerCapture={handleLostPointerCapture}
                    />
                );
            })}

            <SpineRail side="right" count={stack.right}>
                {rightStackTabs.map((tab) => (
                    <SpineButton
                        key={tab.id}
                        tab={tab}
                        isActive={tab.id === activeTabId}
                        icon={renderEditorTabLeadingIcon(
                            tab,
                            chatSessionsById,
                        )}
                        onClick={() => switchTab(tab.id)}
                        onRequestClose={() => void requestCloseTab(tab.id)}
                    />
                ))}
            </SpineRail>

            {/* Insertion indicator for in-pane column reordering. Absolutely
                positioned in content coordinates so it scrolls with the columns;
                the effect above sets its transform and visibility. */}
            <div
                ref={insertionIndicatorRef}
                aria-hidden="true"
                style={{
                    position: "absolute",
                    top: 0,
                    bottom: 0,
                    left: 0,
                    width: 2,
                    background: "var(--accent)",
                    boxShadow:
                        "0 0 0 1px color-mix(in srgb, var(--accent) 24%, transparent)",
                    pointerEvents: "none",
                    zIndex: 60,
                    display: "none",
                }}
            />

            {dragPreviewTab
                ? createPortal(
                      <div
                          ref={dragPreviewNodeRef}
                          data-pane-tab-drag-preview="true"
                          style={{
                              position: "fixed",
                              left: 0,
                              top: 0,
                              maxWidth: 240,
                              height: 28,
                              padding: "0 10px",
                              display: "flex",
                              alignItems: "center",
                              borderRadius: 4,
                              border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
                              background: "var(--bg-primary)",
                              color: "var(--text-primary)",
                              boxShadow:
                                  "inset 0 -2px 0 0 var(--accent), 0 10px 24px rgba(15, 23, 42, 0.15)",
                              pointerEvents: "none",
                              zIndex: 9999,
                              willChange: "transform",
                          }}
                      >
                          <span
                              style={{
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                  fontSize: 12,
                                  fontWeight: 600,
                              }}
                          >
                              {dragPreviewTab.title}
                          </span>
                      </div>,
                      document.body,
                  )
                : null}
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

// Close affordance shared by both spine kinds — mirrors the normal tab strip's
// close button (icon, hover/active states). Shown on every spine (not just the
// active one) so any stacked tab can be closed at a glance.
function SpineCloseButton({
    title,
    onRequestClose,
}: {
    title: string;
    onRequestClose: () => void;
}) {
    return (
        <button
            type="button"
            title={`Close ${title}`}
            aria-label={`Close ${title}`}
            onClick={(event) => {
                event.stopPropagation();
                onRequestClose();
            }}
            // Don't let a click/drag on the X start a column drag or activate.
            onPointerDown={(event) => event.stopPropagation()}
            className="inline-flex shrink-0 items-center justify-center rounded-md opacity-60 transition-[background-color,opacity,transform] duration-150 ease-out hover:bg-gray-500/30 hover:opacity-100 active:bg-gray-500/55 active:scale-90"
            style={{ width: 20, height: 20, color: "var(--text-secondary)" }}
        >
            <svg
                width={13}
                height={13}
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.1"
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                <path d="M4 4l8 8M4 12l8-8" />
            </svg>
        </button>
    );
}

function SpineIcon({ icon }: { icon: ReactNode }) {
    if (!icon) return null;
    return (
        <div className="mt-1 flex shrink-0 items-center justify-center">
            {icon}
        </div>
    );
}

function SpineTitle({ title }: { title: string }) {
    return (
        <div className="flex min-h-0 flex-1 items-center justify-center">
            <span
                style={{
                    fontSize: 12,
                    fontWeight: 600,
                    writingMode: "vertical-rl",
                    transform: "rotate(180deg)",
                    maxHeight: "100%",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                }}
            >
                {title}
            </span>
        </div>
    );
}

function SpineButton({
    tab,
    isActive,
    icon,
    onClick,
    onRequestClose,
}: {
    tab: Tab;
    isActive: boolean;
    icon: ReactNode;
    onClick: () => void;
    onRequestClose: () => void;
}) {
    return (
        <div
            role="tab"
            tabIndex={0}
            aria-selected={isActive}
            onClick={onClick}
            onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onClick();
                }
            }}
            title={tab.title}
            className="group pointer-events-auto flex h-full flex-col items-center py-2"
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
            <SpineCloseButton
                title={tab.title}
                onRequestClose={onRequestClose}
            />
            <SpineIcon icon={icon} />
            <SpineTitle title={tab.title} />
        </div>
    );
}

interface DragCoords {
    clientX: number;
    clientY: number;
    screenX: number;
    screenY: number;
}

interface StackedColumnProps {
    tab: Tab;
    paneId?: string;
    index: number;
    isActive: boolean;
    isPaneFocused: boolean;
    isContent: boolean;
    leftStackWidth: number;
    panelWidth: number;
    shouldMount: boolean;
    emptyStateMessage?: string;
    isDragging: boolean;
    icon: ReactNode;
    registerTabNode: (tabId: string, node: HTMLDivElement | null) => void;
    onSpineClick: () => void;
    onRequestClose: () => void;
    onActivate: () => void;
    onPointerDown: (
        tabId: string,
        index: number,
        event: React.PointerEvent<HTMLDivElement>,
    ) => void;
    onPointerMove: (
        tabId: string,
        event: React.PointerEvent<HTMLDivElement>,
    ) => void;
    onPointerUp: (pointerId?: number, coords?: DragCoords) => void;
    onLostPointerCapture: (pointerId: number) => void;
}

function StackedColumn({
    tab,
    paneId,
    index,
    isActive,
    isPaneFocused,
    isContent,
    leftStackWidth,
    panelWidth,
    shouldMount,
    emptyStateMessage,
    isDragging,
    icon,
    registerTabNode,
    onSpineClick,
    onRequestClose,
    onActivate,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onLostPointerCapture,
}: StackedColumnProps) {
    const tabId = tab.id;
    const setColumnRef = useCallback(
        (node: HTMLDivElement | null) => registerTabNode(tabId, node),
        [registerTabNode, tabId],
    );

    return (
        <div
            ref={setColumnRef}
            data-stacked-column-id={tabId}
            data-pane-tab-id={tabId}
            data-stacked-column-active={isActive ? "true" : undefined}
            // No overflow:hidden here — it would become the sticky containing
            // block and stop the in-flow spine from pinning. Content clipping is
            // handled by the inner content wrapper instead.
            className="relative flex h-full min-h-0"
            style={{
                width: panelWidth,
                flexShrink: 0,
                background: "var(--bg-primary)",
                borderRight: "1px solid var(--border)",
                opacity: isDragging ? 0.5 : 1,
            }}
        >
            {/* The in-flow spine only renders while the panel is content; once it
                is fully scrolled under a rail, the rail's duplicate represents
                it. It is sticky so the leading panel's spine stays pinned at the
                rail edge as the content scrolls (this is what keeps the very
                first panel from sliding away when no rail covers it yet). It is
                also the drag handle: dragging it reorders within the pane or
                moves the column to another pane. */}
            {isContent && (
                <StackedColumnSpine
                    title={tab.title}
                    isActive={isActive}
                    stickyLeft={leftStackWidth}
                    icon={icon}
                    onClick={onSpineClick}
                    onRequestClose={onRequestClose}
                    onPointerDown={(event) =>
                        onPointerDown(tabId, index, event)
                    }
                    onPointerMove={(event) => onPointerMove(tabId, event)}
                    onPointerUp={(event) =>
                        onPointerUp(event.pointerId, {
                            clientX: event.clientX,
                            clientY: event.clientY,
                            screenX: event.screenX,
                            screenY: event.screenY,
                        })
                    }
                    onLostPointerCapture={(event) =>
                        onLostPointerCapture(event.pointerId)
                    }
                />
            )}
            <div
                className="absolute inset-y-0 right-0 overflow-hidden"
                data-stacked-column-mounted={shouldMount ? "true" : "false"}
                style={{ left: SPINE_WIDTH }}
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
        </div>
    );
}

// The canonical, in-flow spine for a panel (role=tab) and the column's drag
// handle. When the panel scrolls under a rail this spine is covered by the
// rail's opaque duplicate. Rendered as a div (not a button) so its pointer
// events match the shared drag hook's element type.
function StackedColumnSpine({
    title,
    isActive,
    stickyLeft,
    icon,
    onClick,
    onRequestClose,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onLostPointerCapture,
}: {
    title: string;
    isActive: boolean;
    stickyLeft: number;
    icon: ReactNode;
    onClick: () => void;
    onRequestClose: () => void;
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
    onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
    onLostPointerCapture: (event: React.PointerEvent<HTMLDivElement>) => void;
}) {
    return (
        <div
            role="tab"
            tabIndex={0}
            aria-selected={isActive}
            title={title}
            onClick={onClick}
            onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onClick();
                }
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onLostPointerCapture={onLostPointerCapture}
            className="no-drag group z-20 flex shrink-0 flex-col items-center py-2 self-stretch"
            style={{
                position: "sticky",
                left: stickyLeft,
                width: SPINE_WIDTH,
                cursor: "grab",
                background: isActive
                    ? "var(--bg-primary)"
                    : "var(--bg-secondary)",
                borderRight: "1px solid var(--border)",
                boxShadow: isActive ? "inset 2px 0 0 var(--accent)" : "none",
                color: isActive
                    ? "var(--text-primary)"
                    : "var(--text-secondary)",
            }}
        >
            <SpineCloseButton
                title={title}
                onRequestClose={onRequestClose}
            />
            <SpineIcon icon={icon} />
            <SpineTitle title={title} />
        </div>
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
                    isVisible
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
        // tabId-aware AI views: each column renders its own session/review
        // independently, so they work even when not the active column.
        case "ai-chat":
            return (
                <React.Suspense fallback={null}>
                    <LazyAIChatSessionView paneId={paneId} tabId={tab.id} />
                </React.Suspense>
            );
        case "ai-review":
            return <AIReviewView paneId={paneId} tabId={tab.id} />;
        // Singleton view (only one chat-history tab can exist), so it is safe to
        // render directly in its column.
        case "ai-chat-history":
            return <AIChatHistoryWorkspaceView />;
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
