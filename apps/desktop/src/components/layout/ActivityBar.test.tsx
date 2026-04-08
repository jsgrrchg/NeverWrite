import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActivityBar } from "./ActivityBar";
import { useLayoutStore } from "../../app/store/layoutStore";
import { useSettingsStore } from "../../app/store/settingsStore";
import { useAppUpdateStore } from "../../features/updates/store";

describe("ActivityBar integrated terminal button", () => {
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

    beforeEach(() => {
        useSettingsStore.setState({
            livePreviewEnabled: true,
            lineWrapping: true,
            developerModeEnabled: false,
            developerTerminalEnabled: true,
        });
        useLayoutStore.setState({
            sidebarCollapsed: false,
            sidebarWidth: 240,
            sidebarView: "files",
            rightPanelCollapsed: false,
            rightPanelExpanded: false,
            rightPanelWidth: 280,
            rightPanelView: "outline",
            bottomPanelCollapsed: true,
            bottomPanelHeight: 240,
            bottomPanelView: "terminal",
        });
        useAppUpdateStore.getState().reset();
    });

    afterEach(() => {
        setNavigatorIdentity(originalUserAgent, originalPlatform);
    });

    it("shows the button only when the integrated terminal is enabled", () => {
        const { unmount } = render(
            <ActivityBar
                active="files"
                onChange={() => {}}
                onOpenSettings={() => {}}
            />,
        );

        expect(
            screen.queryByTitle("Show Integrated Terminal"),
        ).not.toBeInTheDocument();

        unmount();
        useSettingsStore.setState({
            developerModeEnabled: true,
            developerTerminalEnabled: true,
        });

        render(
            <ActivityBar
                active="files"
                onChange={() => {}}
                onOpenSettings={() => {}}
            />,
        );

        expect(
            screen.getByTitle("Show Integrated Terminal"),
        ).toBeInTheDocument();
    });

    it("opens and collapses the bottom terminal panel", () => {
        useSettingsStore.setState({
            developerModeEnabled: true,
            developerTerminalEnabled: true,
        });

        render(
            <ActivityBar
                active="files"
                onChange={() => {}}
                onOpenSettings={() => {}}
            />,
        );

        fireEvent.click(screen.getByTitle("Show Integrated Terminal"));

        expect(useLayoutStore.getState().bottomPanelCollapsed).toBe(false);
        expect(useLayoutStore.getState().bottomPanelView).toBe("terminal");

        fireEvent.click(screen.getByTitle("Hide Integrated Terminal"));

        expect(useLayoutStore.getState().bottomPanelCollapsed).toBe(true);
    });

    it("uses platform-aware shortcut labels in button titles", () => {
        setNavigatorIdentity(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Win32",
        );
        useSettingsStore.setState({
            livePreviewEnabled: false,
        });

        render(
            <ActivityBar
                active="files"
                onChange={() => {}}
                onOpenSettings={() => {}}
            />,
        );

        expect(
            screen.getByTitle("Enable Live Preview (Ctrl+E)"),
        ).toBeInTheDocument();
        expect(screen.getByTitle("Settings (Ctrl+,)")).toBeInTheDocument();
    });

    it("shows a badge on the settings button when an update is available", () => {
        useAppUpdateStore.setState({
            status: {
                enabled: true,
                currentVersion: "0.1.0",
                channel: "stable",
                endpoint: "https://updates.example.com/stable/latest.json",
                message: null,
                update: {
                    currentVersion: "0.1.0",
                    version: "0.2.0",
                    date: "2026-04-04T12:00:00Z",
                    body: "## Added\n\n- In-app updates.",
                    rawJson: {},
                    target: "darwin-aarch64",
                    downloadUrl:
                        "https://github.com/example/neverwrite/releases/download/v0.2.0/NeverWrite.app.tar.gz",
                },
            },
            initialized: true,
        });

        render(
            <ActivityBar
                active="files"
                onChange={() => {}}
                onOpenSettings={() => {}}
            />,
        );

        expect(
            screen.getByTitle("Settings (⌘,) · Update available"),
        ).toBeInTheDocument();
    });
});
