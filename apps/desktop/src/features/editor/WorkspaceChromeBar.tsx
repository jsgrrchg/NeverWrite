import {
    useCallback,
    type CSSProperties,
    type MouseEvent as ReactMouseEvent,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WindowChrome } from "../../components/layout/WindowChrome";
import {
    isFileTab,
    isNoteTab,
    isPdfTab,
    selectFocusedEditorTab,
    useEditorStore,
} from "../../app/store/editorStore";
import { useLayoutStore } from "../../app/store/layoutStore";
import { useSettingsStore } from "../../app/store/settingsStore";
import { getDesktopPlatform } from "../../app/utils/platform";

function getAppWindow() {
    return getCurrentWindow();
}

function startWindowDrag(event: ReactMouseEvent<HTMLElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    void getAppWindow()
        .startDragging()
        .catch(() => {});
}

function toggleWindowMaximize() {
    if (getDesktopPlatform() !== "windows") return;
    const appWindow = getAppWindow();
    if (typeof appWindow.toggleMaximize !== "function") return;
    void appWindow.toggleMaximize().catch(() => {});
}

function getIconButtonStyle(active = false): CSSProperties {
    return {
        width: 30,
        height: 30,
        borderRadius: 9,
        border: active
            ? "1px solid color-mix(in srgb, var(--accent) 20%, var(--border))"
            : "1px solid transparent",
        backgroundColor: active
            ? "color-mix(in srgb, var(--accent) 12%, var(--bg-primary))"
            : "transparent",
        color: active ? "var(--text-primary)" : "var(--text-secondary)",
        opacity: active ? 1 : 0.82,
    };
}

export function WorkspaceChromeBar() {
    const toggleSidebar = useLayoutStore((state) => state.toggleSidebar);
    const sidebarCollapsed = useLayoutStore((state) => state.sidebarCollapsed);
    const rightPanelCollapsed = useLayoutStore(
        (state) => state.rightPanelCollapsed,
    );
    const rightPanelView = useLayoutStore((state) => state.rightPanelView);
    const activateRightView = useLayoutStore(
        (state) => state.activateRightView,
    );
    const goBack = useEditorStore((state) => state.goBack);
    const goForward = useEditorStore((state) => state.goForward);
    const tabOpenBehavior = useSettingsStore((state) => state.tabOpenBehavior);
    const canGoBack = useEditorStore((state) => {
        if (tabOpenBehavior === "history") {
            const tab = selectFocusedEditorTab(state);
            return tab && (isNoteTab(tab) || isFileTab(tab) || isPdfTab(tab))
                ? tab.historyIndex > 0
                : false;
        }
        if (state.tabNavigationIndex <= 0) return false;
        return state.tabNavigationHistory
            .slice(0, state.tabNavigationIndex)
            .some((tabId) => state.tabs.some((tab) => tab.id === tabId));
    });
    const canGoForward = useEditorStore((state) => {
        if (tabOpenBehavior === "history") {
            const tab = selectFocusedEditorTab(state);
            return tab && (isNoteTab(tab) || isFileTab(tab) || isPdfTab(tab))
                ? tab.historyIndex < tab.history.length - 1
                : false;
        }
        if (state.tabNavigationIndex >= state.tabNavigationHistory.length - 1) {
            return false;
        }
        return state.tabNavigationHistory
            .slice(state.tabNavigationIndex + 1)
            .some((tabId) => state.tabs.some((tab) => tab.id === tabId));
    });

    const handleBackgroundMouseDown = useCallback(
        (event: ReactMouseEvent<HTMLElement>) => {
            startWindowDrag(event);
        },
        [],
    );

    return (
        <WindowChrome
            onBackgroundMouseDown={handleBackgroundMouseDown}
            onBackgroundDoubleClick={() => toggleWindowMaximize()}
        >
            <div
                className="flex min-w-0 flex-1 items-center gap-2 px-2"
                onMouseDown={startWindowDrag}
            >
                <button
                    type="button"
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={toggleSidebar}
                    title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
                    className="no-drag flex items-center justify-center shrink-0"
                    style={getIconButtonStyle(!sidebarCollapsed)}
                >
                    <svg
                        width="14"
                        height="14"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
                        <path d="M6 2.5v11" />
                    </svg>
                </button>

                <div className="flex items-center">
                    <button
                        type="button"
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={goBack}
                        disabled={!canGoBack}
                        title="Go back"
                        className="no-drag flex items-center justify-center shrink-0"
                        style={{
                            ...getIconButtonStyle(false),
                            borderRadius: "9px 0 0 9px",
                            opacity: canGoBack ? 0.82 : 0.34,
                        }}
                    >
                        <svg
                            width="14"
                            height="14"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <path d="M9.5 3L4.5 8l5 5" />
                        </svg>
                    </button>
                    <button
                        type="button"
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={goForward}
                        disabled={!canGoForward}
                        title="Go forward"
                        className="no-drag flex items-center justify-center shrink-0"
                        style={{
                            ...getIconButtonStyle(false),
                            borderRadius: "0 9px 9px 0",
                            opacity: canGoForward ? 0.82 : 0.34,
                        }}
                    >
                        <svg
                            width="14"
                            height="14"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <path d="M6.5 3L11.5 8l-5 5" />
                        </svg>
                    </button>
                </div>

                <div
                    className="min-w-0 flex-1 px-2 text-xs font-medium uppercase tracking-[0.14em]"
                    style={{ color: "var(--text-secondary)" }}
                >
                    Multi-pane workspace
                </div>

                <div className="no-drag flex items-center gap-1">
                    <button
                        type="button"
                        onClick={() => activateRightView("chat")}
                        title="AI Chat"
                        style={getIconButtonStyle(
                            !rightPanelCollapsed && rightPanelView === "chat",
                        )}
                    >
                        Chat
                    </button>
                    <button
                        type="button"
                        onClick={() => activateRightView("outline")}
                        title="Outline"
                        style={getIconButtonStyle(
                            !rightPanelCollapsed &&
                                rightPanelView === "outline",
                        )}
                    >
                        Outline
                    </button>
                    <button
                        type="button"
                        onClick={() => activateRightView("links")}
                        title="Links"
                        style={getIconButtonStyle(
                            !rightPanelCollapsed && rightPanelView === "links",
                        )}
                    >
                        Links
                    </button>
                </div>
            </div>
        </WindowChrome>
    );
}
