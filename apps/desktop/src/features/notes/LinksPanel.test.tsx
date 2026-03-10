import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LinksPanel } from "./LinksPanel";
import {
    flushPromises,
    mockInvoke,
    renderComponent,
    setEditorTabs,
    setVaultNotes,
} from "../../test/test-utils";
import { useEditorStore } from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";

describe("LinksPanel", () => {
    it("renders backlinks and outgoing links for the active note", async () => {
        const invokeMock = mockInvoke();

        setVaultNotes([
            {
                id: "notes/current",
                path: "/vault/notes/current.md",
                title: "Current",
                modified_at: 1,
                created_at: 1,
            },
            {
                id: "notes/reference",
                path: "/vault/notes/reference.md",
                title: "Reference",
                modified_at: 1,
                created_at: 1,
            },
        ]);
        setEditorTabs([
            {
                id: "tab-current",
                noteId: "notes/current",
                title: "Current",
                content: "[[Reference]] and [[Missing note]]",
            },
        ]);

        invokeMock.mockImplementation(async (command) => {
            if (command === "get_backlinks") {
                return [{ id: "notes/source", title: "Source note" }];
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        renderComponent(<LinksPanel />);
        await flushPromises();

        expect(await screen.findByText("Source note")).toBeInTheDocument();
        expect(screen.getByText("Reference")).toBeInTheDocument();
        expect(screen.getByText("Missing note")).toBeInTheDocument();
        expect(screen.getByText("Not found")).toBeInTheDocument();
    });

    it("creates a note when clicking a broken outgoing link", async () => {
        const user = userEvent.setup();
        const createNote = vi.fn().mockResolvedValue({
            id: "notes/missing-note",
            path: "/vault/notes/missing-note.md",
            title: "Missing note",
            modified_at: 1,
            created_at: 1,
        });
        const invokeMock = mockInvoke();

        setVaultNotes([
            {
                id: "notes/current",
                path: "/vault/notes/current.md",
                title: "Current",
                modified_at: 1,
                created_at: 1,
            },
        ]);
        useVaultStore.setState({ createNote });
        setEditorTabs([
            {
                id: "tab-current",
                noteId: "notes/current",
                title: "Current",
                content: "[[Missing note]]",
            },
        ]);

        invokeMock.mockImplementation(async (command) => {
            if (command === "get_backlinks") {
                return [];
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        renderComponent(<LinksPanel />);
        await flushPromises();

        await user.click(await screen.findByText("Missing note"));

        await waitFor(() => {
            expect(createNote).toHaveBeenCalledWith("Missing note");
        });
        expect(
            useEditorStore.getState().tabs.some(
                (tab) => tab.noteId === "notes/missing-note",
            ),
        ).toBe(true);
    });

    it("queues a reveal for an outgoing link from the context menu", async () => {
        const user = userEvent.setup();
        const invokeMock = mockInvoke();

        setVaultNotes([
            {
                id: "notes/current",
                path: "/vault/notes/current.md",
                title: "Current",
                modified_at: 1,
                created_at: 1,
            },
            {
                id: "notes/reference",
                path: "/vault/notes/reference.md",
                title: "Reference",
                modified_at: 1,
                created_at: 1,
            },
        ]);
        setEditorTabs([
            {
                id: "tab-current",
                noteId: "notes/current",
                title: "Current",
                content: "[[Reference]]",
            },
        ]);

        invokeMock.mockImplementation(async (command) => {
            if (command === "get_backlinks") {
                return [];
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        renderComponent(<LinksPanel />);
        await flushPromises();

        const referenceItem = await screen.findByText("Reference");
        fireEvent.contextMenu(referenceItem.closest("button")!, {
            clientX: 50,
            clientY: 50,
        });

        await user.click(await screen.findByText("Reveal Link"));

        expect(useEditorStore.getState().pendingReveal).toEqual({
            noteId: "notes/current",
            targets: [
                "Reference",
                "notes/reference",
                "Reference",
                "reference",
            ],
            mode: "link",
        });
    });

    it.todo(
        "ignores late backlink responses in the combined links panel when the active note changes",
    );
});
