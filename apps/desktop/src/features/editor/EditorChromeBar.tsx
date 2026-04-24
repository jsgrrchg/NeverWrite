import {
    useCallback,
    type CSSProperties,
    type MouseEvent as ReactMouseEvent,
} from "react";
import { getCurrentWindow } from "@neverwrite/runtime";
import { useLayoutStore } from "../../app/store/layoutStore";
import {
    getDesktopPlatform,
    getTrafficLightSpacerWidth,
    getWindowChromeLayout,
} from "../../app/utils/platform";
import { getChromeIconButtonStyle } from "./workspaceChromeControls";
import { WorkspacePanelControls } from "./WorkspacePanelControls";

// Compact bar that sits directly above the editor and carries only
// content-oriented chrome (chat / outline / links panel toggles).
//
// Unlike the old horizontal WorkspaceChromeBar, this bar is bounded by the
// editor column and never crosses the sidebar — which is what lets the
// sidebar feel like a separate translucent surface on macOS.
//
// It still has to hold drag regions so the window can be moved from the top
// strip, and it has to reserve space for native controls:
//   - macOS, sidebar collapsed: leading inset for the traffic lights
//   - Windows: trailing inset for the titleBarOverlay controls

const PLATFORM = getDesktopPlatform();
const IS_MACOS = PLATFORM === "macos";
const IS_WINDOWS = PLATFORM === "windows";
const TRAFFIC_LIGHT_SPACER = IS_MACOS ? getTrafficLightSpacerWidth() : 0;
const WINDOWS_CONTROLS_RESERVED = IS_WINDOWS ? 140 : 0;

function startWindowDrag(event: ReactMouseEvent<HTMLElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    void getCurrentWindow()
        .startDragging()
        .catch(() => {});
}

function toggleWindowMaximize() {
    if (!IS_WINDOWS) return;
    const appWindow = getCurrentWindow();
    if (typeof appWindow.toggleMaximize !== "function") return;
    void appWindow.toggleMaximize().catch(() => {});
}

export function EditorChromeBar() {
    const sidebarCollapsed = useLayoutStore((state) => state.sidebarCollapsed);
    const toggleSidebar = useLayoutStore((state) => state.toggleSidebar);
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

    const layout = getWindowChromeLayout();
    // Only pay the traffic-light padding cost when the sidebar is collapsed —
    // otherwise the sidebar carries the inset and the editor starts flush
    // against the sidebar resizer.
    const leadingInset = sidebarCollapsed ? TRAFFIC_LIGHT_SPACER : 0;

    return (
        <div
            data-editor-chrome-bar
            data-window-platform={layout.platform}
            onMouseDown={handleBackgroundMouseDown}
            onDoubleClick={toggleWindowMaximize}
            style={{
                paddingTop: layout.titlebarPaddingTop,
                flexShrink: 0,
                WebkitAppRegion: "drag",
            } as CSSProperties}
        >
            <div
                className="flex items-stretch select-none"
                style={{
                    height: 34,
                    padding: "0 6px",
                    cursor: "default",
                }}
            >
                {leadingInset > 0 && (
                    <div
                        data-editor-chrome-leading-inset="true"
                        onMouseDown={handleBackgroundMouseDown}
                        style={{
                            width: leadingInset,
                            flexShrink: 0,
                        }}
                    />
                )}

                {/* Show the sidebar-expand button only while the sidebar is
                    collapsed. When it's visible, its own collapse button in
                    the SidebarShell header is the authoritative control. */}
                {sidebarCollapsed && (
                    <button
                        type="button"
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={toggleSidebar}
                        title="Show sidebar"
                        className="no-drag flex items-center justify-center shrink-0"
                        style={{
                            ...getChromeIconButtonStyle(false),
                            marginLeft: leadingInset > 0 ? 2 : 0,
                            marginRight: 2,
                            alignSelf: "center",
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
                            <rect
                                x="2.5"
                                y="2.5"
                                width="11"
                                height="11"
                                rx="2"
                            />
                            <path d="M6 2.5v11" />
                        </svg>
                    </button>
                )}

                <div aria-hidden="true" className="flex-1 min-w-0" />

                <div className="no-drag flex shrink-0 items-center self-center">
                    <WorkspacePanelControls
                        rightPanelCollapsed={rightPanelCollapsed}
                        rightPanelView={rightPanelView}
                        activateRightView={activateRightView}
                    />
                </div>

                {/* Reserve space on Windows for the titleBarOverlay native
                    controls so panel controls don't slide under them. */}
                {WINDOWS_CONTROLS_RESERVED > 0 && (
                    <div
                        aria-hidden="true"
                        style={{
                            width: WINDOWS_CONTROLS_RESERVED,
                            flexShrink: 0,
                        }}
                    />
                )}
            </div>
        </div>
    );
}
