import { fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useChatStore } from "../ai/store/chatStore";
import { SettingsPanel } from "./SettingsPanel";
import { renderComponent } from "../../test/test-utils";

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

describe("SettingsPanel", () => {
    it("renders the shared shortcut registry labels for Windows", () => {
        setNavigatorIdentity(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Win32",
        );

        renderComponent(<SettingsPanel onClose={() => {}} />);

        fireEvent.click(screen.getByRole("button", { name: "Shortcuts" }));

        expect(screen.getByText("Quick Switcher")).toBeInTheDocument();
        expect(screen.getByText("Ctrl+O")).toBeInTheDocument();
        expect(screen.getByText("Open Settings")).toBeInTheDocument();
        expect(screen.getByText("Ctrl+,")).toBeInTheDocument();
    });

    it("renders AI send hints with the platform primary modifier", () => {
        useChatStore.setState({
            requireCmdEnterToSend: true,
        });

        setNavigatorIdentity(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15",
            "MacIntel",
        );

        const { unmount } = renderComponent(
            <SettingsPanel onClose={() => {}} />,
        );

        fireEvent.click(screen.getByRole("button", { name: "AI" }));

        expect(screen.getByText("Require ⌘Enter to send")).toBeInTheDocument();
        expect(
            screen.getByText(/Press ⌘Enter to send messages\./),
        ).toBeInTheDocument();

        unmount();

        setNavigatorIdentity(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Win32",
        );

        renderComponent(<SettingsPanel onClose={() => {}} />);

        fireEvent.click(screen.getByRole("button", { name: "AI" }));

        expect(
            screen.getByText("Require Ctrl+Enter to send"),
        ).toBeInTheDocument();
        expect(
            screen.getByText(/Press Ctrl\+Enter to send messages\./),
        ).toBeInTheDocument();
    });

    it("renders the screenshot retention control in AI settings", () => {
        useChatStore.setState({
            screenshotRetentionSeconds: 300,
        });

        renderComponent(<SettingsPanel onClose={() => {}} />);

        fireEvent.click(screen.getByRole("button", { name: "AI" }));

        expect(screen.getByText("Screenshot retention")).toBeInTheDocument();
        expect(screen.getByText("5 minutes")).toBeInTheDocument();
        expect(
            screen.getByText(
                "How long pasted screenshots stay in the AI composer before they are removed automatically.",
            ),
        ).toBeInTheDocument();
    });
});
