export type DesktopPlatform = "macos" | "windows";

export interface WindowChromeLayout {
    platform: DesktopPlatform;
    leadingInsetWidth: number;
    titlebarPaddingTop: number;
    windowControlsSide: "left" | "right";
}

export interface ManagedWindowChromeOptions {
    decorations?: boolean;
    titleBarStyle?: "overlay";
    hiddenTitle?: boolean;
    trafficLightPosition?: { x: number; y: number };
}

/**
 * The desktop app currently has two supported shells. Treat everything that is
 * not explicitly Windows as macOS so existing chrome stays stable in tests and
 * non-Windows developer environments.
 */
export function getDesktopPlatform(): DesktopPlatform {
    if (typeof navigator === "undefined") return "macos";

    const platformHints = [
        navigator.userAgent,
        navigator.platform,
        // userAgentData is not typed consistently across environments.
        (navigator as Navigator & { userAgentData?: { platform?: string } })
            .userAgentData?.platform,
    ]
        .filter((value): value is string => typeof value === "string")
        .join(" ");

    return /windows/i.test(platformHints) ? "windows" : "macos";
}

/**
 * Synchronous macOS version detection from WKWebView user-agent.
 * Works immediately at render time — no async IPC needed for layout.
 */
function detectMacOSMajorVersionSync(): number {
    if (typeof navigator === "undefined") return 15;
    const match = navigator.userAgent.match(/Mac OS X (\d+)[._]/);
    if (match) return parseInt(match[1], 10);
    return 15;
}

export function getMacOSMajorVersion(): number {
    return detectMacOSMajorVersionSync();
}

export function isMacOSTahoe(): boolean {
    return getDesktopPlatform() === "macos" && getMacOSMajorVersion() >= 26;
}

const TRAFFIC_LIGHT_X = 14;
// Traffic-light Y is chosen to vertically center the ~12px native buttons
// inside the 34px WindowChrome bar: (34 - 12) / 2 = 11. Keeping the same
// offset on legacy and Tahoe means the tab bar and traffic lights line up
// identically regardless of macOS version.
const TRAFFIC_LIGHT_Y = 11;
const TRAFFIC_LIGHT_SPACER_LEGACY = 68;
const TRAFFIC_LIGHT_SPACER_TAHOE = 72;
const TITLEBAR_PADDING_TOP_LEGACY = 0;
const TITLEBAR_PADDING_TOP_TAHOE = 0;

export function getTrafficLightPosition(): { x: number; y: number } {
    return {
        x: TRAFFIC_LIGHT_X,
        y: TRAFFIC_LIGHT_Y,
    };
}

export function getTrafficLightSpacerWidth(): number {
    if (getDesktopPlatform() !== "macos") return 0;
    return isMacOSTahoe()
        ? TRAFFIC_LIGHT_SPACER_TAHOE
        : TRAFFIC_LIGHT_SPACER_LEGACY;
}

export function getTitlebarPaddingTop(): number {
    if (getDesktopPlatform() !== "macos") return 0;
    return isMacOSTahoe()
        ? TITLEBAR_PADDING_TOP_TAHOE
        : TITLEBAR_PADDING_TOP_LEGACY;
}

export function getWindowChromeLayout(): WindowChromeLayout {
    const platform = getDesktopPlatform();
    return {
        platform,
        leadingInsetWidth:
            platform === "macos" ? getTrafficLightSpacerWidth() : 0,
        titlebarPaddingTop: getTitlebarPaddingTop(),
        windowControlsSide: platform === "macos" ? "left" : "right",
    };
}

export function getManagedWindowChromeOptions(): ManagedWindowChromeOptions {
    // On Windows we intentionally return no options so satellite windows
    // (settings, detached note, vault) go through the main-process window
    // factory the same way the main window does — getting native acrylic
    // via `backgroundMaterial` and native caption buttons via
    // `titleBarOverlay`. Passing `decorations: false` here used to force
    // them chromeless, which suppressed the acrylic and hid the native
    // min/max/close buttons.
    if (getDesktopPlatform() === "windows") {
        return {};
    }

    if (getDesktopPlatform() !== "macos") {
        return {};
    }

    return {
        decorations: true,
        titleBarStyle: "overlay",
        hiddenTitle: true,
        trafficLightPosition: getTrafficLightPosition(),
    };
}
