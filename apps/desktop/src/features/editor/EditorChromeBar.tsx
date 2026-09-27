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

// Thin top strip above the editor. It keeps the tabs below the 34px native
// title bar overlay, regardless of which side Linux places its controls on.
//
// On macOS the component collapses to `null`: the traffic lights are handled
// entirely by the window adapter (`setTrafficLightsVisible`) and the sidebar
// header carries their leading inset, so a dedicated chrome strip above the
// editor is pure dead space.

const PLATFORM = getDesktopPlatform();
const IS_WINDOWS = PLATFORM === "windows";
const IS_LINUX = PLATFORM === "linux";
const USES_NATIVE_TITLEBAR_OVERLAY = IS_WINDOWS || IS_LINUX;

function startWindowDrag(event: ReactMouseEvent<HTMLElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    void getCurrentWindow()
        .startDragging()
        .catch(() => {});
}

function toggleWindowMaximize() {
    if (!USES_NATIVE_TITLEBAR_OVERLAY) return;
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
    if (!USES_NATIVE_TITLEBAR_OVERLAY) return null;

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
                // Match the sidebar's theme tint so the strip reads as a
                // continuation of the native titlebar overlay surface.
                backgroundColor: "var(--sidebar-vibrancy-tint)",
            } as CSSProperties}
        >
            <div aria-hidden="true" style={{ height: 34, cursor: "default" }} />
        </div>
    );
}
