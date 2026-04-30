import React from "react";
import {
    useEditorStore,
    isChatTab,
    isChatHistoryTab,
    isFileTab,
    isGraphTab,
    isMapTab,
    isNoteTab,
    isPdfTab,
    isReviewTab,
    isTerminalTab,
    selectEditorPaneState,
    selectFocusedPaneId,
    type EditorPaneState,
    type EditorWorkspaceState,
    type TerminalTab,
} from "../../app/store/editorStore";
import { canUseExcalidrawRuntime } from "../../app/utils/safeBrowser";
import { Editor } from "./Editor";
import { FileTabView } from "./FileTabView";
import { SearchView } from "../search/SearchView";
import { isSearchTab } from "../search/searchTab";
import { PdfTabView } from "../pdf/PdfTabView";
import { AIChatHistoryWorkspaceView } from "../ai/components/AIChatHistoryWorkspaceView";
import { AIReviewView } from "../ai/components/AIReviewView";
import { WorkspacePaneEmptyState } from "./WorkspacePaneEmptyState";
import { WorkspaceTerminalView } from "../terminal/WorkspaceTerminalView";

type EditorPanelView =
    | "pdf"
    | "file"
    | "search"
    | "ai-review"
    | "ai-chat"
    | "ai-chat-history"
    | "editor"
    | "terminal"
    | "map"
    | "graph";

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

function selectRenderablePane(
    state: EditorWorkspaceState,
    paneId?: string,
): EditorPaneState {
    if (paneId) {
        return selectEditorPaneState(state, paneId);
    }

    const activePane =
        state.activeTabId && state.panes.length > 1
            ? (state.panes.find((pane) =>
                  pane.tabs.some((tab) => tab.id === state.activeTabId),
              ) ?? null)
            : null;

    return activePane ?? selectEditorPaneState(state);
}

function UnsupportedMapView() {
    return (
        <div
            className="h-full flex items-center justify-center p-6"
            style={{ color: "var(--text-secondary)" }}
        >
            <div
                className="max-w-xl rounded-xl p-5"
                style={{
                    border: "1px solid var(--border)",
                    background: "var(--bg-secondary)",
                }}
            >
                <div
                    className="text-sm font-semibold"
                    style={{ color: "var(--text-primary)" }}
                >
                    Map view is unavailable in this hardened build
                </div>
                <div className="mt-2 text-sm leading-6">
                    The current release disables dynamic code execution required
                    by Excalidraw. Existing map tabs are preserved in session
                    data, but they are not restored automatically and cannot be
                    rendered until a CSP-compatible runtime is wired in.
                </div>
            </div>
        </div>
    );
}

function renderEditorPanelView(
    view: EditorPanelView,
    paneId?: string,
    emptyStateMessage?: string,
    activeTabId?: string,
) {
    switch (view) {
        case "pdf":
            return <PdfTabView paneId={paneId} />;
        case "file":
            return <FileTabView paneId={paneId} />;
        case "ai-review":
            return <AIReviewView paneId={paneId} />;
        case "ai-chat":
            return (
                <React.Suspense fallback={null}>
                    <LazyAIChatSessionView paneId={paneId} />
                </React.Suspense>
            );
        case "ai-chat-history":
            return <AIChatHistoryWorkspaceView />;
        case "map":
            if (!EXCALIDRAW_RUNTIME_SUPPORTED) {
                return <UnsupportedMapView />;
            }
            return (
                <React.Suspense fallback={null}>
                    <LazyExcalidrawTabView paneId={paneId} />
                </React.Suspense>
            );
        case "search":
            return activeTabId ? (
                <SearchView key={activeTabId} tabId={activeTabId} />
            ) : null;
        case "graph":
            return null;
        case "terminal":
            return null;
        default:
            return (
                <Editor paneId={paneId} emptyStateMessage={emptyStateMessage} />
            );
    }
}

interface EditorPaneContentProps {
    paneId?: string;
    emptyStateMessage?: string;
}

export function EditorPaneContent({
    paneId,
    emptyStateMessage,
}: EditorPaneContentProps) {
    const pane = useEditorStore((state) => selectRenderablePane(state, paneId));
    const activeTab =
        pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? null;
    const view: EditorPanelView = (() => {
        const tab = activeTab;
        if (!tab) return "editor";
        if (isPdfTab(tab)) return "pdf";
        if (isFileTab(tab)) return "file";
        if (isReviewTab(tab)) return "ai-review";
        if (isChatTab(tab)) return "ai-chat";
        if (isChatHistoryTab(tab)) return "ai-chat-history";
        if (isMapTab(tab)) return "map";
        if (isGraphTab(tab)) return "graph";
        if (isTerminalTab(tab)) return "terminal";
        if (!isNoteTab(tab)) return "editor";
        if (isSearchTab(tab)) return "search";
        return "editor";
    })();
    const paneTabs = pane.tabs;
    const focusedPaneId = useEditorStore(selectFocusedPaneId);
    const activePane = paneId ? focusedPaneId === paneId : true;
    const terminalTabs = paneTabs.filter(
        (tab): tab is TerminalTab => isTerminalTab(tab),
    );
    const isTerminalActive = activeTab ? isTerminalTab(activeTab) : false;
    const hasGraphTab = paneTabs.some((tab) => isGraphTab(tab));
    const isGraphActive = view === "graph";
    const keepGraphMounted = hasGraphTab;
    const isEditorActive = view === "editor";
    const hasEditableNoteTab = paneTabs.some(
        (tab) => isNoteTab(tab) && !isSearchTab(tab),
    );
    // Keep CodeMirror alive behind agent/review tabs so note-local scroll,
    // selection, and undo state survive the round trip back to the editor.
    const keepEditorMounted = isEditorActive || hasEditableNoteTab;

    // Workspace panes own their own empty states so the last empty pane can
    // offer quick actions without leaking workspace chrome into note windows.
    if (!activeTab && paneId && paneTabs.length === 0) {
        return <WorkspacePaneEmptyState paneId={paneId} />;
    }

    return (
        <div className="relative flex-1 min-h-0 min-w-0 w-full overflow-hidden">
            {keepEditorMounted && (
                <div
                    style={{
                        position: "absolute",
                        inset: 0,
                        visibility: isEditorActive ? "visible" : "hidden",
                        pointerEvents: isEditorActive ? "auto" : "none",
                    }}
                >
                    <Editor
                        paneId={paneId}
                        emptyStateMessage={emptyStateMessage}
                        isVisible={isEditorActive}
                    />
                </div>
            )}
            {keepGraphMounted && (
                <div
                    style={{
                        position: "absolute",
                        inset: 0,
                        visibility: isGraphActive ? "visible" : "hidden",
                        pointerEvents: isGraphActive ? "auto" : "none",
                    }}
                >
                    <React.Suspense fallback={null}>
                        <LazyGraphTabView isVisible={isGraphActive} />
                    </React.Suspense>
                </div>
            )}
            {terminalTabs.map((tab) => (
                <WorkspaceTerminalView
                    key={tab.id}
                    tab={tab}
                    active={tab.id === activeTab?.id}
                    activePane={activePane}
                />
            ))}
            {!isEditorActive &&
                !isGraphActive &&
                !isTerminalActive &&
                renderEditorPanelView(
                    view,
                    paneId,
                    emptyStateMessage,
                    activeTab?.id,
                )}
        </div>
    );
}
