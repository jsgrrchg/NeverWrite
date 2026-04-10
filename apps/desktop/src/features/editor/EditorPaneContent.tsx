import React, { useEffect, useState } from "react";
import {
    useEditorStore,
    isFileTab,
    isGraphTab,
    isMapTab,
    isNoteTab,
    isPdfTab,
    isReviewTab,
    selectEditorPaneActiveTab,
    selectEditorPaneState,
} from "../../app/store/editorStore";
import { perfCount } from "../../app/utils/perfInstrumentation";
import { canUseExcalidrawRuntime } from "../../app/utils/safeBrowser";
import { Editor } from "./Editor";
import { FileTabView } from "./FileTabView";
import { NewTabView } from "./NewTabView";
import { SearchView } from "../search/SearchView";
import { PdfTabView } from "../pdf/PdfTabView";
import { AIReviewView } from "../ai/components/AIReviewView";

type EditorPanelView =
    | "pdf"
    | "file"
    | "new"
    | "search"
    | "ai-review"
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

const GRAPH_KEEP_ALIVE_MS = 15 * 60 * 1000;
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
        case "map":
            if (!EXCALIDRAW_RUNTIME_SUPPORTED) {
                return <UnsupportedMapView />;
            }
            return (
                <React.Suspense fallback={null}>
                    <LazyExcalidrawTabView />
                </React.Suspense>
            );
        case "new":
            return <NewTabView />;
        case "search":
            return <SearchView />;
        case "graph":
            return null;
        default:
            return <Editor paneId={paneId} emptyStateMessage={emptyStateMessage} />;
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
    const view = useEditorStore((state): EditorPanelView => {
        const tab = selectEditorPaneActiveTab(state, paneId);
        if (!tab) return "editor";
        if (isPdfTab(tab)) return "pdf";
        if (isFileTab(tab)) return "file";
        if (isReviewTab(tab)) return "ai-review";
        if (isMapTab(tab)) return "map";
        if (isGraphTab(tab)) return "graph";
        if (!isNoteTab(tab)) return "editor";
        if (tab.noteId === "") return "new";
        if (tab.noteId === "__search__") return "search";
        return "editor";
    });
    const paneTabs = useEditorStore((state) =>
        selectEditorPaneState(state, paneId).tabs,
    );
    const hasGraphTab = paneTabs.some((tab) => isGraphTab(tab));
    const isGraphActive = view === "graph";
    const [keepAlive, setKeepAlive] = useState(false);
    const [prevIsGraphActive, setPrevIsGraphActive] = useState(isGraphActive);
    const [prevHasGraphTab, setPrevHasGraphTab] = useState(hasGraphTab);

    if (
        prevIsGraphActive !== isGraphActive ||
        prevHasGraphTab !== hasGraphTab
    ) {
        setPrevIsGraphActive(isGraphActive);
        setPrevHasGraphTab(hasGraphTab);
        if (!hasGraphTab) {
            if (keepAlive) setKeepAlive(false);
        } else if (prevIsGraphActive && !isGraphActive) {
            if (!keepAlive) setKeepAlive(true);
        } else if (isGraphActive && keepAlive) {
            setKeepAlive(false);
        }
    }

    useEffect(() => {
        if (!keepAlive) return;
        const timeoutId = window.setTimeout(() => {
            perfCount("graph.lifecycle.keepAliveExpired");
            setKeepAlive(false);
        }, GRAPH_KEEP_ALIVE_MS);
        return () => window.clearTimeout(timeoutId);
    }, [keepAlive]);

    const keepGraphMounted = hasGraphTab && (isGraphActive || keepAlive);

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
            {!isGraphActive &&
                renderEditorPanelView(view, paneId, emptyStateMessage)}
        </div>
    );
}
