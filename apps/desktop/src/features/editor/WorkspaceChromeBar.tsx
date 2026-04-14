import { useCallback, type MouseEvent as ReactMouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WindowChrome } from "../../components/layout/WindowChrome";
import { useLayoutStore } from "../../app/store/layoutStore";
import { getDesktopPlatform } from "../../app/utils/platform";
import { getChromeIconButtonStyle } from "./workspaceChromeControls";
import { WorkspacePanelControls } from "./WorkspacePanelControls";

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

                <div aria-hidden="true" className="min-w-0 flex-1" />

                <div className="no-drag flex shrink-0 items-center">
                    <WorkspacePanelControls
                        rightPanelCollapsed={rightPanelCollapsed}
                        rightPanelView={rightPanelView}
                        activateRightView={activateRightView}
                    />
                </div>
            </div>
        </WindowChrome>
    );
}
