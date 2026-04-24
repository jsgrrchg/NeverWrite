import {
    useCallback,
    type CSSProperties,
    type MouseEvent as ReactMouseEvent,
} from "react";
import { getCurrentWindow } from "@neverwrite/runtime";
import {
    getDesktopPlatform,
    getWindowChromeLayout,
} from "../../app/utils/platform";

// Thin top strip above the editor. It exists only to reserve the trailing
// 140px that Windows' `titleBarOverlay` paints native caption controls on
// top of — without the spacer, the tab strip would slide under min/max/close.
//
// On macOS the component collapses to `null`: the traffic lights are handled
// entirely by the window adapter (`setTrafficLightsVisible`) and the sidebar
// header carries their leading inset, so a dedicated chrome strip above the
// editor is pure dead space.

const PLATFORM = getDesktopPlatform();
const IS_WINDOWS = PLATFORM === "windows";
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
    const handleBackgroundMouseDown = useCallback(
        (event: ReactMouseEvent<HTMLElement>) => {
            startWindowDrag(event);
        },
        [],
    );

    // macOS no longer needs this strip — the sidebar owns the traffic-light
    // inset and the pane bars sit flush against the top of the window.
    if (!IS_WINDOWS) return null;

    const layout = getWindowChromeLayout();

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
                // Match the sidebar's frosted tint so the strip reads as a
                // continuation of the Windows acrylic surface.
                backgroundColor: "var(--sidebar-vibrancy-tint)",
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
                <div aria-hidden="true" className="flex-1 min-w-0" />

                {/* Reserve space for the titleBarOverlay native controls so
                    chrome controls don't slide under them. */}
                <div
                    aria-hidden="true"
                    style={{
                        width: WINDOWS_CONTROLS_RESERVED,
                        flexShrink: 0,
                    }}
                />
            </div>
        </div>
    );
}
