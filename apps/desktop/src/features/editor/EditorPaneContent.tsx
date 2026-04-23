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
    selectEditorPaneActiveTab,
    selectEditorPaneState,
    selectFocusedPaneId,
    type TerminalTab,
} from "../../app/store/editorStore";
import { canUseExcalidrawRuntime } from "../../app/utils/safeBrowser";
import { Editor } from "./Editor";
import { FileTabView } from "./FileTabView";
import { SearchView } from "../search/SearchView";
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
                    <LazyExcalidrawTabView />
                </React.Suspense>
            );
        case "search":
            return <SearchView />;
        case "graph":
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
    const activeTab = useEditorStore((state) =>
        selectEditorPaneActiveTab(state, paneId),
    );
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
        if (!isNoteTab(tab)) return "editor";
        if (tab.noteId === "__search__") return "search";
        return "editor";
    })();
    const paneTabs = useEditorStore(
        (state) => selectEditorPaneState(state, paneId).tabs,
    );
    const focusedPaneId = useEditorStore(selectFocusedPaneId);
    const activePane = paneId ? focusedPaneId === paneId : true;
    const terminalTabs = paneTabs.filter(
        (tab): tab is TerminalTab => isTerminalTab(tab),
    );
    const isTerminalActive = activeTab ? isTerminalTab(activeTab) : false;
    const hasGraphTab = paneTabs.some((tab) => isGraphTab(tab));
    const isGraphActive = view === "graph";
    const keepGraphMounted = hasGraphTab;

    // Workspace panes own their own empty states so the last empty pane can
    // offer quick actions without leaking workspace chrome into note windows.
    if (!activeTab && paneId && paneTabs.length === 0) {
        return <WorkspacePaneEmptyState paneId={paneId} />;
    }

    return (
        <div className="relative flex-1 min-h-0 min-w-0 w-full overflow-hidden">
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
            {!isGraphActive &&
                !isTerminalActive &&
                renderEditorPanelView(view, paneId, emptyStateMessage)}
        </div>
    );
}
