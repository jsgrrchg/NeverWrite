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
        expect(useEditorStore.getState().panes.map((pane) => pane.id)).toEqual([
            "secondary",
        ]);
        expect(
            useEditorStore.getState().panes[0]?.tabs.map((tab) => tab.id),
        ).toEqual(["tab-b", "tab-a"]);
    });

    it("does not move tabs between panes via drag gestures", () => {
        renderComponent(
            <div>
                <div data-editor-pane-id="primary">
                    <EditorPaneBar paneId="primary" isFocused />
                </div>
                <div data-editor-pane-id="secondary">
                    <EditorPaneBar paneId="secondary" isFocused={false} />
                </div>
            </div>,
        );

        const primaryPane = document.querySelector(
            '[data-editor-pane-id="primary"]',
        ) as HTMLElement | null;
        const secondaryPane = document.querySelector(
            '[data-editor-pane-id="secondary"]',
        ) as HTMLElement | null;
        const secondaryStrip = document.querySelector(
            '[data-pane-tab-strip="secondary"]',
        ) as HTMLElement | null;
        const tabButton = document.querySelector(
            '[data-pane-tab-id="tab-a"]',
        ) as HTMLElement | null;

        expect(primaryPane).not.toBeNull();
        expect(secondaryPane).not.toBeNull();
        expect(secondaryStrip).not.toBeNull();
        expect(tabButton).not.toBeNull();

        primaryPane!.getBoundingClientRect = () =>
            ({
                left: 0,
                top: 0,
                right: 180,
                bottom: 80,
                width: 180,
                height: 80,
                x: 0,
                y: 0,
                toJSON: () => ({}),
            }) as DOMRect;
        secondaryPane!.getBoundingClientRect = () =>
            ({
                left: 200,
                top: 0,
                right: 380,
                bottom: 80,
                width: 180,
                height: 80,
                x: 200,
                y: 0,
                toJSON: () => ({}),
            }) as DOMRect;
        secondaryStrip!.getBoundingClientRect = () =>
            ({
                left: 200,
                top: 0,
                right: 380,
                bottom: 38,
                width: 180,
                height: 38,
                x: 200,
                y: 0,
                toJSON: () => ({}),
            }) as DOMRect;

        fireEvent.pointerDown(tabButton!, {
            pointerId: 1,
            button: 0,
            clientX: 20,
            clientY: 20,
            screenX: 20,
            screenY: 20,
        });
        fireEvent.pointerMove(tabButton!, {
            pointerId: 1,
            buttons: 1,
            clientX: 240,
            clientY: 20,
            screenX: 240,
            screenY: 20,
        });
        fireEvent.pointerUp(tabButton!, {
            pointerId: 1,
            clientX: 240,
            clientY: 20,
            screenX: 240,
            screenY: 20,
        });

        const state = useEditorStore.getState();
        expect(state.panes[0]?.tabs.map((tab) => tab.id)).toEqual(["tab-a"]);
        expect(state.panes[1]?.tabs.map((tab) => tab.id)).toEqual(["tab-b"]);
        expect(state.focusedPaneId).toBe("primary");
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
            expect(useEditorStore.getState().panes).toHaveLength(2);
        });

        const state = useEditorStore.getState();
        expect(state.focusedPaneId).toBe("pane-3");
        expect(state.panes.map((pane) => pane.id)).toEqual([
            "secondary",
            "pane-3",
        ]);
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
