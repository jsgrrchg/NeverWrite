import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../app/store/editorStore";
import { renderComponent, setEditorTabs } from "../../test/test-utils";
import { EditorPaneContent } from "./EditorPaneContent";

function enableStackedOnFocusedPane() {
    const paneId = useEditorStore.getState().focusedPaneId;
    if (!paneId) throw new Error("expected a focused pane");
    act(() => {
        useEditorStore.getState().setPaneTabDisplayMode(paneId, "stacked");
    });
}

describe("StackedPaneContent", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("renders one column per tab as a horizontal tablist", () => {
        setEditorTabs(
            [
                {
                    id: "n1",
                    kind: "note",
                    noteId: "note-1",
                    title: "Alpha",
                    content: "A",
                },
                {
                    id: "n2",
                    kind: "note",
                    noteId: "note-2",
                    title: "Beta",
                    content: "B",
                },
            ],
            "n1",
        );
        enableStackedOnFocusedPane();

        renderComponent(<EditorPaneContent />);

        const tablist = screen.getByRole("tablist", { name: /stacked tabs/i });
        expect(tablist).toHaveAttribute("aria-orientation", "horizontal");

        expect(
            screen.getByRole("tab", { name: /alpha/i }),
        ).toHaveAttribute("aria-selected", "true");
        expect(
            screen.getByRole("tab", { name: /beta/i }),
        ).toHaveAttribute("aria-selected", "false");
    });

    it("collapses a column to a spine and keeps it activatable", () => {
        setEditorTabs(
            [
                {
                    id: "n1",
                    kind: "note",
                    noteId: "note-1",
                    title: "Alpha",
                    content: "A",
                },
                {
                    id: "n2",
                    kind: "note",
                    noteId: "note-2",
                    title: "Beta",
                    content: "B",
                },
            ],
            "n1",
        );
        enableStackedOnFocusedPane();

        renderComponent(<EditorPaneContent />);

        // Collapse the inactive "Beta" column via its header collapse button.
        act(() => {
            screen
                .getByRole("button", { name: /collapse beta/i })
                .click();
        });

        // It becomes a spine offering to expand again.
        const expandButton = screen.getByRole("tab", { name: /expand beta/i });
        expect(expandButton).toHaveAttribute("aria-expanded", "false");

        act(() => {
            expandButton.click();
        });

        // Expanding activates it.
        expect(useEditorStore.getState().focusedPaneId).toBeTruthy();
        expect(
            screen.getByRole("tab", { name: /beta/i }),
        ).toHaveAttribute("aria-selected", "true");
    });

    it("does not render the stacked tablist in default mode", () => {
        setEditorTabs(
            [
                {
                    id: "n1",
                    kind: "note",
                    noteId: "note-1",
                    title: "Alpha",
                    content: "A",
                },
            ],
            "n1",
        );

        renderComponent(<EditorPaneContent />);

        expect(
            screen.queryByRole("tablist", { name: /stacked tabs/i }),
        ).not.toBeInTheDocument();
    });
});
