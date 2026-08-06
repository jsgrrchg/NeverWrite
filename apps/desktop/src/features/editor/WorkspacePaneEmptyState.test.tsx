import "@testing-library/jest-dom/vitest";
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { formatShortcutAction } from "../../app/shortcuts/format";
import { useEditorStore } from "../../app/store/editorStore";
import { getDesktopPlatform } from "../../app/utils/platform";
import { renderComponent } from "../../test/test-utils";
import { WorkspacePaneEmptyState } from "./WorkspacePaneEmptyState";

describe("WorkspacePaneEmptyState", () => {
    beforeEach(() => {
        useEditorStore.getState().hydrateWorkspace(
            [
                {
                    id: "primary",
                    tabs: [],
                    activeTabId: null,
                },
            ],
            "primary",
        );
    });

    it("shows a compact empty state message with shortcut hints", () => {
        const { container } = renderComponent(
            <WorkspacePaneEmptyState paneId="primary" />,
        );

        // The placeholder lists each action with its keyboard shortcut.
        // Text nodes are interleaved with <kbd> elements, so assert on the
        // paragraph's combined text content.
        const text = container.textContent ?? "";
        expect(text).toContain("Open a file");
        expect(text).toContain("browse commands");
        expect(text).toContain("start a chat");
        expect(text).toContain("launch a terminal");

        // Shortcuts are resolved from the registry for the current test platform.
        const hints = Array.from(
            container.querySelectorAll("kbd"),
            (kbd) => kbd.textContent,
        );
        const platform = getDesktopPlatform();
        expect(hints).toEqual([
            formatShortcutAction("quick_switcher", platform),
            formatShortcutAction("command_palette", platform),
            formatShortcutAction("new_agent", platform),
            formatShortcutAction("new_terminal", platform),
        ]);

        expect(
            screen.queryByRole("button", { name: "New Note" }),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "New Agent" }),
        ).not.toBeInTheDocument();
    });

    it("keeps pane identity marker for drop and targeting logic", () => {
        renderComponent(<WorkspacePaneEmptyState paneId="secondary" />);

        expect(
            document.querySelector("[data-workspace-empty-pane='secondary']"),
        ).toBeInTheDocument();
    });
});
