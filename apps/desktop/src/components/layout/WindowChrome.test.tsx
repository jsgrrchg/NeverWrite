import { fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

beforeEach(() => {
    const mockWindow = (
        globalThis as typeof globalThis & {
            __mockCurrentWindow: {
                minimize: { mockClear: () => void };
                toggleMaximize: { mockClear: () => void };
                isMaximized: {
                    mockReset: () => void;
                    mockResolvedValue: (value: boolean) => void;
                };
                close: { mockClear: () => void };
            };
        }
    ).__mockCurrentWindow;
    const mockWebviewWindow = (
        globalThis as typeof globalThis & {
            __mockCurrentWebviewWindow: {
                minimize: { mockClear: () => void };
                toggleMaximize: { mockClear: () => void };
                isMaximized: {
                    mockReset: () => void;
                    mockResolvedValue: (value: boolean) => void;
                };
                close: { mockClear: () => void };
            };
        }
    ).__mockCurrentWebviewWindow;

    mockWindow.minimize.mockClear();
    mockWindow.toggleMaximize.mockClear();
    mockWindow.isMaximized.mockReset();
    mockWindow.isMaximized.mockResolvedValue(false);
    mockWindow.close.mockClear();
    mockWebviewWindow.minimize.mockClear();
    mockWebviewWindow.toggleMaximize.mockClear();
    mockWebviewWindow.isMaximized.mockReset();
    mockWebviewWindow.isMaximized.mockResolvedValue(false);
    mockWebviewWindow.close.mockClear();
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
        expect(
            screen.queryByLabelText("Minimize window"),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByLabelText("Maximize window"),
        ).not.toBeInTheDocument();
        expect(screen.queryByLabelText("Close window")).not.toBeInTheDocument();
    });

    it("leaves the leading side clean on Windows", () => {
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
        expect(
            screen.queryByLabelText("Minimize window"),
        ).not.toBeInTheDocument();
    });

    it("renders native window controls on Windows and dispatches commands", () => {
        setNavigatorIdentity(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Win32",
        );

        const mockWindow = (
            globalThis as typeof globalThis & {
                __mockCurrentWindow: {
                    minimize: { mock: { calls: unknown[][] } };
                    toggleMaximize: { mock: { calls: unknown[][] } };
                    close: { mock: { calls: unknown[][] } };
                };
            }
        ).__mockCurrentWindow;

        renderComponent(
            <WindowChrome showWindowControls>
                <div data-testid="chrome-child">Body</div>
            </WindowChrome>,
        );

        fireEvent.click(screen.getByLabelText("Minimize window"));
        fireEvent.click(screen.getByLabelText("Maximize window"));
        fireEvent.click(screen.getByLabelText("Close window"));

        expect(mockWindow.minimize.mock.calls).toHaveLength(1);
        expect(mockWindow.toggleMaximize.mock.calls).toHaveLength(1);
        expect(mockWindow.close.mock.calls).toHaveLength(1);
    });

    it("can target the current webview window for Windows controls", () => {
        setNavigatorIdentity(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Win32",
        );

        const mockWebviewWindow = (
            globalThis as typeof globalThis & {
                __mockCurrentWebviewWindow: {
                    minimize: { mock: { calls: unknown[][] } };
                    toggleMaximize: { mock: { calls: unknown[][] } };
                    close: { mock: { calls: unknown[][] } };
                };
            }
        ).__mockCurrentWebviewWindow;

        renderComponent(
            <WindowChrome
                showWindowControls
                windowControlScope="webview"
            >
                <div data-testid="chrome-child">Body</div>
            </WindowChrome>,
        );

        fireEvent.click(screen.getByLabelText("Minimize window"));
        fireEvent.click(screen.getByLabelText("Maximize window"));
        fireEvent.click(screen.getByLabelText("Close window"));

        expect(mockWebviewWindow.minimize.mock.calls).toHaveLength(1);
        expect(mockWebviewWindow.toggleMaximize.mock.calls).toHaveLength(1);
        expect(mockWebviewWindow.close.mock.calls).toHaveLength(1);
    });
});
