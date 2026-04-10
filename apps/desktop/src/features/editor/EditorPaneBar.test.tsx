import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { renderComponent } from "../../test/test-utils";
import { useEditorStore } from "../../app/store/editorStore";
import { MAX_EDITOR_PANES } from "../../app/store/workspaceLayoutTree";
import { EditorPaneBar } from "./EditorPaneBar";

describe("EditorPaneBar", () => {
    beforeEach(() => {
        Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
            configurable: true,
            value: () => {},
        });
        Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
            configurable: true,
            value: () => {},
        });
        Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
            configurable: true,
            value: () => false,
        });
        useEditorStore.getState().hydrateWorkspace(
            [
                {
                    id: "primary",
                    tabs: [
                        {
                            id: "tab-a",
                            kind: "note",
                            noteId: "notes/a",
                            title: "Alpha",
                            content: "Alpha",
                        },
                    ],
                    activeTabId: "tab-a",
                },
                {
                    id: "secondary",
                    tabs: [
                        {
                            id: "tab-b",
                            kind: "note",
                            noteId: "notes/b",
                            title: "Beta",
                            content: "Beta",
                        },
                    ],
                    activeTabId: "tab-b",
                },
            ],
            "primary",
        );
    });

    it("moves a tab to another pane from the tab context menu", async () => {
        const user = userEvent.setup();
        renderComponent(<EditorPaneBar paneId="primary" isFocused />);

        const tabButton = document.querySelector(
            '[data-pane-tab-id="tab-a"]',
        ) as HTMLElement | null;
        expect(tabButton).not.toBeNull();
        fireEvent.contextMenu(tabButton!);
        await user.click(
            await screen.findByRole("button", { name: "Move to Pane 2" }),
        );

        await waitFor(() => {
            expect(useEditorStore.getState().focusedPaneId).toBe("secondary");
        });
        expect(useEditorStore.getState().panes[0]?.tabs).toHaveLength(0);
        expect(
            useEditorStore.getState().panes[1]?.tabs.map((tab) => tab.id),
        ).toEqual(["tab-b", "tab-a"]);
    });

    it("moves a tab into a new right split from the tab context menu", async () => {
        const user = userEvent.setup();
        renderComponent(<EditorPaneBar paneId="primary" isFocused />);

        const tabButton = document.querySelector(
            '[data-pane-tab-id="tab-a"]',
        ) as HTMLElement | null;
        expect(tabButton).not.toBeNull();
        fireEvent.contextMenu(tabButton!);
        await user.click(
            await screen.findByRole("button", {
                name: "Move to New Right Split",
            }),
        );

        await waitFor(() => {
            expect(useEditorStore.getState().panes).toHaveLength(3);
        });

        const state = useEditorStore.getState();
        expect(state.focusedPaneId).toBe("pane-3");
        expect(
            state.panes.find((pane) => pane.id === "primary")?.tabs,
        ).toHaveLength(0);
        expect(
            state.panes.find((pane) => pane.id === "pane-3")?.tabs[0],
        ).toMatchObject({
            kind: "note",
            noteId: "notes/a",
            title: "Alpha",
            content: "Alpha",
        });
    });

    it("disables creating a new split when the workspace already reached the cap", async () => {
        renderComponent(<EditorPaneBar paneId="primary" isFocused />);

        await act(async () => {
            Array.from({ length: MAX_EDITOR_PANES - 2 }, () =>
                useEditorStore.getState().createEmptyPane(),
            );
            await Promise.resolve();
        });

        const tabButton = document.querySelector(
            '[data-pane-tab-id="tab-a"]',
        ) as HTMLElement | null;
        expect(tabButton).not.toBeNull();
        fireEvent.contextMenu(tabButton!);

        expect(
            await screen.findByRole("button", {
                name: "Move to New Right Split",
            }),
        ).toBeDisabled();
    });

    it("splits the current pane down from the pane actions menu", async () => {
        const user = userEvent.setup();
        renderComponent(<EditorPaneBar paneId="secondary" isFocused />);

        await user.click(
            screen.getByRole("button", { name: "Pane 2 actions" }),
        );
        await user.click(
            await screen.findByRole("button", { name: "Split Down" }),
        );

        await waitFor(() => {
            expect(useEditorStore.getState().panes).toHaveLength(3);
        });

        const state = useEditorStore.getState();
        expect(state.focusedPaneId).toBe("pane-3");
        expect(state.panes.map((pane) => pane.id)).toEqual([
            "primary",
            "secondary",
            "pane-3",
        ]);
    });

    it("focuses a neighbor pane from the pane actions menu", async () => {
        const user = userEvent.setup();
        renderComponent(<EditorPaneBar paneId="secondary" isFocused />);

        await user.click(
            screen.getByRole("button", { name: "Pane 2 actions" }),
        );
        await user.click(
            await screen.findByRole("button", { name: "Focus Pane Left" }),
        );

        await waitFor(() => {
            expect(useEditorStore.getState().focusedPaneId).toBe("primary");
        });
    });

    it("closes a pane explicitly from the pane actions menu", async () => {
        const user = userEvent.setup();
        renderComponent(<EditorPaneBar paneId="secondary" isFocused />);

        await user.click(
            screen.getByRole("button", { name: "Pane 2 actions" }),
        );
        await user.click(
            await screen.findByRole("button", { name: "Close Pane 2" }),
        );

        await waitFor(() => {
            expect(useEditorStore.getState().panes).toHaveLength(1);
        });
        expect(useEditorStore.getState().focusedPaneId).toBe("primary");
    });
});
