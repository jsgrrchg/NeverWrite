import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { BacklinksPanel } from "./BacklinksPanel";
import {
    flushPromises,
    mockInvoke,
    renderComponent,
    setEditorTabs,
} from "../../test/test-utils";
import { useEditorStore } from "../../app/store/editorStore";

describe("BacklinksPanel", () => {
    it("loads and renders backlinks for the active tab", async () => {
        const invokeMock = mockInvoke();

        setEditorTabs([
            {
                id: "tab-active",
                noteId: "notes/current",
                title: "Current",
                content: "body",
                isDirty: false,
            },
        ]);

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "get_backlinks") {
                expect(args).toEqual({ noteId: "notes/current" });
                return [{ id: "notes/source", title: "Source note" }];
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        renderComponent(<BacklinksPanel />);
        await flushPromises();

        expect(await screen.findByText("Source note")).toBeInTheDocument();
    });

    it("switches to an already open source note without reading it again", async () => {
        const user = userEvent.setup();
        const invokeMock = mockInvoke();

        setEditorTabs(
            [
                {
                    id: "tab-active",
                    noteId: "notes/current",
                    title: "Current",
                    content: "body",
                    isDirty: false,
                },
                {
                    id: "tab-source",
                    noteId: "notes/source",
                    title: "Source note",
                    content: "cached",
                    isDirty: false,
                },
            ],
            "tab-active",
        );

        invokeMock.mockImplementation(async (command) => {
            if (command === "get_backlinks") {
                return [{ id: "notes/source", title: "Source note" }];
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        renderComponent(<BacklinksPanel />);
        await flushPromises();

        await user.click(await screen.findByText("Source note"));

        expect(useEditorStore.getState().activeTabId).toBe("tab-source");
        expect(invokeMock).not.toHaveBeenCalledWith(
            "read_note",
            expect.anything(),
        );
    });

    it("queues a mention reveal from the backlink context menu", async () => {
        const user = userEvent.setup();
        const invokeMock = mockInvoke();

        setEditorTabs(
            [
                {
                    id: "tab-active",
                    noteId: "notes/current",
                    title: "Current",
                    content: "body",
                    isDirty: false,
                },
                {
                    id: "tab-source",
                    noteId: "notes/source",
                    title: "Source note",
                    content: "cached",
                    isDirty: false,
                },
            ],
            "tab-active",
        );

        invokeMock.mockImplementation(async (command) => {
            if (command === "get_backlinks") {
                return [{ id: "notes/source", title: "Source note" }];
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        renderComponent(<BacklinksPanel />);
        await flushPromises();

        const sourceButton = await screen.findByText("Source note");
        fireEvent.contextMenu(sourceButton, {
            clientX: 90,
            clientY: 90,
        });

        await user.click(await screen.findByText("Go to Mention"));

        await waitFor(() => {
            expect(useEditorStore.getState().pendingReveal).toEqual({
                noteId: "notes/source",
                targets: ["notes/current", "Current", "current"],
                mode: "mention",
            });
        });
        expect(useEditorStore.getState().activeTabId).toBe("tab-source");
    });

    it.todo(
        "ignores late backlink responses after the active note changes",
    );
});
