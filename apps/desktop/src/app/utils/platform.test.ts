import { afterEach, describe, expect, it } from "vitest";
import {
    getDesktopPlatform,
    getManagedWindowChromeOptions,
    getWindowChromeLayout,
} from "./platform";

const originalUserAgent = navigator.userAgent;
const originalPlatform = navigator.platform;

function setNavigatorIdentity(userAgent: string, platform: string) {
    Object.defineProperty(window.navigator, "userAgent", {
        configurable: true,
        value: userAgent,
    });
    Object.defineProperty(window.navigator, "platform", {
        configurable: true,
        value: platform,
    });
}

afterEach(() => {
    setNavigatorIdentity(originalUserAgent, originalPlatform);
});

describe("platform helpers", () => {
    it("keeps macOS chrome defaults outside Windows", () => {
        setNavigatorIdentity(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15",
            "MacIntel",
        );

        expect(getDesktopPlatform()).toBe("macos");
        expect(getWindowChromeLayout()).toMatchObject({
            platform: "macos",
            windowControlsSide: "left",
        });
        expect(getManagedWindowChromeOptions()).toMatchObject({
            decorations: true,
            titleBarStyle: "overlay",
            hiddenTitle: true,
            // y=11 vertically centers the 12px traffic lights in the 34px
            // WindowChrome bar — same origin on every macOS version.
            trafficLightPosition: { x: 14, y: 11 },
        });
    });

    it("switches chrome responsibilities for Windows", () => {
        setNavigatorIdentity(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Win32",
        );

        expect(getDesktopPlatform()).toBe("windows");
        expect(getWindowChromeLayout()).toEqual({
            platform: "windows",
            leadingInsetWidth: 0,
            titlebarPaddingTop: 0,
            windowControlsSide: "right",
        });
        expect(getManagedWindowChromeOptions()).toEqual({
            decorations: false,
        });
    });
});
