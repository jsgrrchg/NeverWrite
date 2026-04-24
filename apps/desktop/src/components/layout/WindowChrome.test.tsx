import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderComponent } from "../../test/test-utils";
import { WindowChrome } from "./WindowChrome";

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

describe("WindowChrome", () => {
    it("renders the macOS leading inset when requested", () => {
        setNavigatorIdentity(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15",
            "MacIntel",
        );

        renderComponent(
            <WindowChrome showLeadingInset>
                <div data-testid="chrome-child">Body</div>
            </WindowChrome>,
        );

        const root = screen
            .getByTestId("chrome-child")
            .closest("[data-window-platform]");

        expect(root).toHaveAttribute("data-window-platform", "macos");
        expect(root).toHaveAttribute("data-window-controls-side", "left");
        expect(
            root?.querySelector(".drag.flex.items-stretch"),
        ).not.toBeNull();
        expect(
            root?.querySelector('[data-window-chrome-leading-inset="true"]'),
        ).not.toBeNull();
    });

    it("leaves the leading side clean on Windows and never renders caption buttons", () => {
        setNavigatorIdentity(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Win32",
        );

        renderComponent(
            <WindowChrome showLeadingInset>
                <div data-testid="chrome-child">Body</div>
            </WindowChrome>,
        );

        const root = screen
            .getByTestId("chrome-child")
            .closest("[data-window-platform]");

        expect(root).toHaveAttribute("data-window-platform", "windows");
        expect(root).toHaveAttribute("data-window-controls-side", "right");
        expect(
            root?.querySelector('[data-window-chrome-leading-inset="true"]'),
        ).toBeNull();
        // Caption buttons are painted by Electron's native titleBarOverlay,
        // so no React-level min/max/close buttons should be in the DOM.
        expect(
            screen.queryByLabelText("Minimize window"),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByLabelText("Maximize window"),
        ).not.toBeInTheDocument();
        expect(screen.queryByLabelText("Close window")).not.toBeInTheDocument();
    });
});
