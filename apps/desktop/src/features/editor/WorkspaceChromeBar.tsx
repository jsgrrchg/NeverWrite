import { useCallback, type MouseEvent as ReactMouseEvent } from "react";
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
import {
    getChromeIconButtonStyle,
    getChromeNavigationButtonStyle,
} from "./workspaceChromeControls";

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
            showLeadingInset
            showWindowControls
            onBackgroundMouseDown={handleBackgroundMouseDown}
            onBackgroundDoubleClick={() => toggleWindowMaximize()}
            onLeadingInsetMouseDown={handleBackgroundMouseDown}
            onLeadingInsetDoubleClick={() => toggleWindowMaximize()}
            shellStyle={{
                background:
                    "color-mix(in srgb, var(--bg-tertiary) 92%, transparent)",
                borderBottom: "1px solid var(--border)",
                backdropFilter: "blur(18px)",
                boxShadow: "0 1px 0 rgba(255,255,255,0.04)",
            }}
            barStyle={{ padding: "0 6px" }}
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
                    style={{
                        ...getChromeIconButtonStyle(!sidebarCollapsed),
                        marginLeft: 10,
                        marginRight: 2,
                    }}
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
                            ...getChromeNavigationButtonStyle(
                                "leading",
                                canGoBack,
                            ),
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
                            ...getChromeNavigationButtonStyle(
                                "trailing",
                                canGoForward,
                            ),
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

                <div aria-hidden="true" className="min-w-0 flex-1" />

                <div className="no-drag flex shrink-0 items-center gap-1">
                    <button
                        type="button"
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={() => activateRightView("chat")}
                        title="AI Chat"
                        className="no-drag"
                        style={getChromeIconButtonStyle(
                            !rightPanelCollapsed && rightPanelView === "chat",
                        )}
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
                            <path d="M14 10a2 2 0 0 1-2 2H5l-3 3V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z" />
                        </svg>
                    </button>
                    <button
                        type="button"
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={() => activateRightView("outline")}
                        title="Outline"
                        className="no-drag"
                        style={getChromeIconButtonStyle(
                            !rightPanelCollapsed &&
                                rightPanelView === "outline",
                        )}
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
                            <path d="M3 3.5h10" />
                            <path d="M5.5 8h7.5" />
                            <path d="M8 12.5h5" />
                            <path d="M3 8h.01" />
                            <path d="M5.5 12.5h.01" />
                        </svg>
                    </button>
                    <button
                        type="button"
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={() => activateRightView("links")}
                        title="Links"
                        className="no-drag"
                        style={getChromeIconButtonStyle(
                            !rightPanelCollapsed && rightPanelView === "links",
                        )}
                    >
                        <svg
                            width="14"
                            height="14"
                            viewBox="0 0 16 16"
                            fill="none"
                        >
                            <rect
                                x="11"
                                y="2"
                                width="4"
                                height="12"
                                rx="1"
                                fill="currentColor"
                            />
                            <rect
                                x="1"
                                y="2"
                                width="8"
                                height="2"
                                rx="1"
                                fill="currentColor"
                            />
                            <rect
                                x="1"
                                y="7"
                                width="8"
                                height="2"
                                rx="1"
                                fill="currentColor"
                            />
                            <rect
                                x="1"
                                y="12"
                                width="8"
                                height="2"
                                rx="1"
                                fill="currentColor"
                            />
                        </svg>
                    </button>
                </div>
            </div>
        </WindowChrome>
    );
}
