import React from "react";
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

    const tabs = pane.tabs;
    const activeTabId = pane.activeTabId;
    const isPaneFocused = paneId ? focusedPaneId === paneId : true;

    if (tabs.length === 0) {
        if (paneId) {
            return <WorkspacePaneEmptyState paneId={paneId} />;
        }
        return null;
    }

    return (
        <div className="relative flex-1 min-h-0 min-w-0 w-full flex flex-row overflow-x-auto overflow-y-hidden">
            {tabs.map((tab) => {
                const isActive = tab.id === activeTabId;
                return (
                    <div
                        key={tab.id}
                        data-stacked-column-id={tab.id}
                        data-stacked-column-active={
                            isActive ? "true" : undefined
                        }
                        className="relative flex h-full min-h-0 flex-col overflow-hidden"
                        style={{
                            width: STACKED_COLUMN_WIDTH,
                            minWidth: STACKED_COLUMN_WIDTH,
                            flexShrink: 0,
                            borderRight: "1px solid var(--border)",
                            background: "var(--bg-primary)",
                        }}
                    >
                        <StackedColumnHeader
                            title={tab.title}
                            isActive={isActive}
                            onActivate={() => switchTab(tab.id)}
                        />
                        <div className="relative flex-1 min-h-0 min-w-0 overflow-hidden">
                            <StackedColumnBody
                                paneId={paneId}
                                tab={tab}
                                isActive={isActive}
                                isPaneFocused={isPaneFocused}
                                emptyStateMessage={emptyStateMessage}
                            />
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

function StackedColumnHeader({
    title,
    isActive,
    onActivate,
}: {
    title: string;
    isActive: boolean;
    onActivate: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onActivate}
            className="flex shrink-0 items-center gap-2 px-3 text-left"
            style={{
                height: 33,
                minHeight: 33,
                boxSizing: "border-box",
                borderBottom: "1px solid var(--border)",
                background: isActive
                    ? "var(--bg-primary)"
                    : "var(--bg-secondary)",
                boxShadow: isActive
                    ? "inset 0 2px 0 var(--accent)"
                    : "none",
            }}
            title={title}
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
