import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { renderComponent, setEditorTabs, setVaultNotes } from "../../test/test-utils";
import { FileTree } from "./FileTree";

function getNoteRow(label: string) {
    const row = screen.getByText(label).closest('[role="button"]');
    expect(row).not.toBeNull();
    return row!;
}

async function expandFolder(user: ReturnType<typeof userEvent.setup>, label: string) {
    await user.click(screen.getByText(label));
}

describe("FileTree", () => {
    it("shows a plural delete label when right-clicking a note inside the current multi-selection", async () => {
        const user = userEvent.setup();
        setVaultNotes([
            {
                id: "notes/alpha",
                path: "/vault/notes/alpha.md",
                title: "Alpha",
                modified_at: 1,
                created_at: 1,
            },
            {
                id: "notes/beta",
                path: "/vault/notes/beta.md",
                title: "Beta",
                modified_at: 1,
                created_at: 1,
            },
        ]);
        setEditorTabs([
            {
                id: "tab-alpha",
                noteId: "notes/alpha",
                title: "Alpha",
                content: "Alpha",
            },
            {
                id: "tab-beta",
                noteId: "notes/beta",
                title: "Beta",
                content: "Beta",
            },
        ]);
        renderComponent(<FileTree />);

        await expandFolder(user, "notes");

        fireEvent.click(getNoteRow("Alpha"), { metaKey: true });
        fireEvent.click(getNoteRow("Beta"), { metaKey: true });
        fireEvent.contextMenu(getNoteRow("Beta"));

        expect(await screen.findByText("Delete Selected Notes")).toBeInTheDocument();
    });

    it("deletes all selected notes from the context menu", async () => {
        const user = userEvent.setup();
        const deleteNote = vi.fn().mockResolvedValue(undefined);

        useVaultStore.setState({ deleteNote });
        setVaultNotes([
            {
                id: "notes/alpha",
                path: "/vault/notes/alpha.md",
                title: "Alpha",
                modified_at: 1,
                created_at: 1,
            },
            {
                id: "notes/beta",
                path: "/vault/notes/beta.md",
                title: "Beta",
                modified_at: 1,
                created_at: 1,
            },
        ]);
        setEditorTabs([
            {
                id: "tab-alpha",
                noteId: "notes/alpha",
                title: "Alpha",
                content: "Alpha",
            },
            {
                id: "tab-beta",
                noteId: "notes/beta",
                title: "Beta",
                content: "Beta",
            },
        ]);

        renderComponent(<FileTree />);
        await expandFolder(user, "notes");

        fireEvent.click(getNoteRow("Alpha"), { metaKey: true });
        fireEvent.click(getNoteRow("Beta"), { metaKey: true });
        fireEvent.contextMenu(getNoteRow("Beta"));

        await user.click(await screen.findByText("Delete Selected Notes"));

        await waitFor(() => {
            expect(deleteNote).toHaveBeenCalledTimes(2);
        });
        expect(deleteNote).toHaveBeenCalledWith("notes/alpha");
        expect(deleteNote).toHaveBeenCalledWith("notes/beta");
        expect(useEditorStore.getState().tabs).toHaveLength(0);
    });

    it("moves all selected notes from the context menu with a plural label", async () => {
        const user = userEvent.setup();
        const renameNote = vi
            .fn()
            .mockImplementation(async (_noteId: string, newPath: string) => ({
                id: `${newPath}.md`,
                path: `/vault/${newPath}.md`,
                title: newPath.split("/").pop() ?? newPath,
            }));

        useVaultStore.setState({ renameNote });
        setVaultNotes([
            {
                id: "notes/alpha",
                path: "/vault/notes/alpha.md",
                title: "Alpha",
                modified_at: 1,
                created_at: 1,
            },
            {
                id: "notes/beta",
                path: "/vault/notes/beta.md",
                title: "Beta",
                modified_at: 1,
                created_at: 1,
            },
            {
                id: "archive/gamma",
                path: "/vault/archive/gamma.md",
                title: "Gamma",
                modified_at: 1,
                created_at: 1,
            },
        ]);
        setEditorTabs([
            {
                id: "tab-alpha",
                noteId: "notes/alpha",
                title: "Alpha",
                content: "Alpha",
            },
            {
                id: "tab-beta",
                noteId: "notes/beta",
                title: "Beta",
                content: "Beta",
            },
        ]);

        renderComponent(<FileTree />);
        await expandFolder(user, "notes");

        fireEvent.click(getNoteRow("Alpha"), { metaKey: true });
        fireEvent.click(getNoteRow("Beta"), { metaKey: true });
        fireEvent.contextMenu(getNoteRow("Beta"));

        await user.click(
            await screen.findByRole("button", {
                name: "Move Selected Notes to…",
            }),
        );
        const archiveTargets = await screen.findAllByRole("button", {
            name: "archive",
        });
        await user.click(archiveTargets[archiveTargets.length - 1]!);

        await waitFor(() => {
            expect(renameNote).toHaveBeenCalledTimes(2);
        });
        expect(renameNote).toHaveBeenCalledWith("notes/alpha", "archive/alpha");
        expect(renameNote).toHaveBeenCalledWith("notes/beta", "archive/beta");
    });

    it("opens a note when clicked in the tree", async () => {
        const user = userEvent.setup();

        setVaultNotes([
            {
                id: "notes/alpha",
                path: "/vault/notes/alpha.md",
                title: "Alpha",
                modified_at: 1,
                created_at: 1,
            },
            {
                id: "notes/beta",
                path: "/vault/notes/beta.md",
                title: "Beta",
                modified_at: 1,
                created_at: 1,
            },
        ]);
        setEditorTabs(
            [
                {
                    id: "tab-alpha",
                    noteId: "notes/alpha",
                    title: "Alpha",
                    content: "Alpha",
                },
                {
                    id: "tab-beta",
                    noteId: "notes/beta",
                    title: "Beta",
                    content: "Beta",
                },
            ],
            "tab-alpha",
        );

        renderComponent(<FileTree />);
        await expandFolder(user, "notes");
        await user.click(getNoteRow("Beta"));

        // openNote now navigates within the active tab instead of switching tabs
        const activeTab = useEditorStore.getState().tabs.find(
            (t) => t.id === useEditorStore.getState().activeTabId,
        );
        expect(activeTab?.noteId).toBe("notes/beta");
    });
});
