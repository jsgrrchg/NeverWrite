import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ActivityBar } from "./ActivityBar";
import { useLayoutStore } from "../../app/store/layoutStore";
import { useSettingsStore } from "../../app/store/settingsStore";

describe("ActivityBar integrated terminal button", () => {
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
});
