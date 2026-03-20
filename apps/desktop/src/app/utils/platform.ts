/**
 * Synchronous macOS version detection from WKWebView user-agent.
 * Works immediately at module load — no async IPC needed for layout.
 */
function detectMacOSMajorVersionSync(): number {
    if (typeof navigator === "undefined") return 15;
    // WKWebView UA: "…Mac OS X 26_3_1…" or "…Mac OS X 15_0…"
    const match = navigator.userAgent.match(/Mac OS X (\d+)[._]/);
    if (match) return parseInt(match[1], 10);
    return 15;
}

const macOSMajorVersion = detectMacOSMajorVersionSync();

export function getMacOSMajorVersion(): number {
    return macOSMajorVersion;
}

export function isMacOSTahoe(): boolean {
    return macOSMajorVersion >= 26;
}

// ---------------------------------------------------------------------------
// Traffic-light layout constants
// ---------------------------------------------------------------------------

const TRAFFIC_LIGHT_X = 14;
const TRAFFIC_LIGHT_Y_LEGACY = 20;
const TRAFFIC_LIGHT_Y_TAHOE = 17;

/** Width of the invisible spacer to the right of the traffic lights. */
const TRAFFIC_LIGHT_SPACER_LEGACY = 68;
const TRAFFIC_LIGHT_SPACER_TAHOE = 72;

/** Top padding for the title-bar area (clears the overlay). */
const TITLEBAR_PADDING_TOP_LEGACY = 0;
const TITLEBAR_PADDING_TOP_TAHOE = 0;

export function getTrafficLightPosition(): { x: number; y: number } {
    return {
        x: TRAFFIC_LIGHT_X,
        y: isMacOSTahoe() ? TRAFFIC_LIGHT_Y_TAHOE : TRAFFIC_LIGHT_Y_LEGACY,
    };
}

export function getTrafficLightSpacerWidth(): number {
    return isMacOSTahoe()
        ? TRAFFIC_LIGHT_SPACER_TAHOE
        : TRAFFIC_LIGHT_SPACER_LEGACY;
}

export function getTitlebarPaddingTop(): number {
    return isMacOSTahoe()
        ? TITLEBAR_PADDING_TOP_TAHOE
        : TITLEBAR_PADDING_TOP_LEGACY;
}
