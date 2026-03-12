import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";
import {
    renderComponent,
    setEditorTabs,
    setVaultNotes,
} from "../../test/test-utils";
import { FileTree } from "./FileTree";

function getNoteRow(label: string) {
    const row = screen.getByText(label).closest('[role="button"]');
    expect(row).not.toBeNull();
    return row!;
}

function getFolderRow(label: string) {
    const row = screen.getByText(label).closest("button");
    expect(row).not.toBeNull();
    return row!;
}

async function expandFolder(
    user: ReturnType<typeof userEvent.setup>,
    label: string,
) {
    await user.click(screen.getByText(label));
}

function buildCreatedNote(path: string) {
    return {
        id: path,
        path: `/vault/${path}.md`,
        title: path.split("/").pop() ?? path,
        modified_at: 1,
        created_at: 1,
    };
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

        expect(
            await screen.findByText("Delete Selected Notes"),
        ).toBeInTheDocument();
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
        const activeTab = useEditorStore
            .getState()
            .tabs.find((t) => t.id === useEditorStore.getState().activeTabId);
        expect(activeTab?.noteId).toBe("notes/beta");
    });

    it("opens a note in a new tab on middle click", async () => {
        const user = userEvent.setup();
        vi.mocked(invoke).mockResolvedValue({ content: "Beta body" });

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
            ],
            "tab-alpha",
        );

        renderComponent(<FileTree />);
        await expandFolder(user, "notes");

        fireEvent(
            getNoteRow("Beta"),
            new MouseEvent("auxclick", {
                bubbles: true,
                button: 1,
            }),
        );

        await waitFor(() => {
            expect(useEditorStore.getState().tabs).toHaveLength(2);
        });

        const activeTab = useEditorStore
            .getState()
            .tabs.find((t) => t.id === useEditorStore.getState().activeTabId);
        expect(activeTab?.noteId).toBe("notes/beta");
        expect(activeTab?.content).toBe("Beta body");
    });

    it("renders the new note input inline inside the tree even when the vault is empty", async () => {
        const user = userEvent.setup();

        setVaultNotes([]);

        renderComponent(<FileTree />);

        await user.click(screen.getByTitle("New note"));

        const input = screen.getByPlaceholderText("New note");
        expect(input.closest('[data-folder-path=""]')).not.toBeNull();
        expect(screen.queryByText("No notes")).not.toBeInTheDocument();
    });

    it("expands the target folder when creating a note inline inside it", async () => {
        const user = userEvent.setup();

        setVaultNotes([
            {
                id: "notes/alpha",
                path: "/vault/notes/alpha.md",
                title: "Alpha",
                modified_at: 1,
                created_at: 1,
            },
        ]);

        renderComponent(<FileTree />);

        fireEvent.contextMenu(getFolderRow("notes"));
        await user.click(await screen.findByText("New Note Here"));

        const input = screen.getByPlaceholderText("New note");
        expect(input.closest('[data-folder-path=""]')).not.toBeNull();
        expect(screen.getByText("Alpha")).toBeInTheDocument();
    });

    it("copies and pastes a note from the tree context menu", async () => {
        const user = userEvent.setup();
        const createNote = vi
            .fn()
            .mockImplementation(async (path: string) => buildCreatedNote(path));
        const updateNoteMetadata = vi.fn();
        const touchContent = vi.fn();

        useVaultStore.setState({
            createNote,
            updateNoteMetadata,
            touchContent,
        });
        vi.mocked(invoke).mockImplementation(async (command, args) => {
            if (command === "read_note") {
                return { content: "Alpha body" };
            }
            if (command === "save_note") {
                return {
                    title: "alpha",
                    path: `/vault/${(args as { noteId: string }).noteId}.md`,
                };
            }
            return undefined;
        });

        setVaultNotes([
            {
                id: "notes/alpha",
                path: "/vault/notes/alpha.md",
                title: "Alpha",
                modified_at: 1,
                created_at: 1,
            },
            {
                id: "archive/existing",
                path: "/vault/archive/existing.md",
                title: "Existing",
                modified_at: 1,
                created_at: 1,
            },
        ]);

        renderComponent(<FileTree />);
        await expandFolder(user, "notes");

        fireEvent.contextMenu(getNoteRow("Alpha"));
        await user.click(await screen.findByText("Copy Note"));

        fireEvent.contextMenu(getFolderRow("archive"));
        await user.click(await screen.findByText("Paste Here"));

        await waitFor(() => {
            expect(createNote).toHaveBeenCalledWith("archive/alpha");
        });
        expect(invoke).toHaveBeenCalledWith("save_note", {
            noteId: "archive/alpha",
            content: "Alpha body",
            vaultPath: "/vault",
        });
        expect(updateNoteMetadata).toHaveBeenCalledWith(
            "archive/alpha",
            expect.objectContaining({
                title: "alpha",
                path: "/vault/archive/alpha.md",
            }),
        );
        expect(touchContent).toHaveBeenCalled();
    });

    it("copies and pastes a folder from the tree context menu", async () => {
        const user = userEvent.setup();
        const createNote = vi
            .fn()
            .mockImplementation(async (path: string) => buildCreatedNote(path));

        useVaultStore.setState({
            createNote,
            updateNoteMetadata: vi.fn(),
            touchContent: vi.fn(),
        });
        vi.mocked(invoke).mockImplementation(async (command, args) => {
            if (command === "read_note") {
                const noteId = (args as { noteId: string }).noteId;
                return { content: `${noteId} body` };
            }
            if (command === "save_note") {
                return {
                    title: "copied",
                    path: `/vault/${(args as { noteId: string }).noteId}.md`,
                };
            }
            return undefined;
        });

        setVaultNotes([
            {
                id: "projects/alpha",
                path: "/vault/projects/alpha.md",
                title: "Alpha",
                modified_at: 1,
                created_at: 1,
            },
            {
                id: "projects/sub/beta",
                path: "/vault/projects/sub/beta.md",
                title: "Beta",
                modified_at: 1,
                created_at: 1,
            },
            {
                id: "archive/existing",
                path: "/vault/archive/existing.md",
                title: "Existing",
                modified_at: 1,
                created_at: 1,
            },
        ]);

        renderComponent(<FileTree />);

        fireEvent.contextMenu(getFolderRow("projects"));
        await user.click(await screen.findByText("Copy"));

        fireEvent.contextMenu(getFolderRow("archive"));
        await user.click(await screen.findByText("Paste Here"));

        await waitFor(() => {
            expect(createNote).toHaveBeenCalledWith("archive/projects/alpha");
        });
        expect(createNote).toHaveBeenCalledWith("archive/projects/sub/beta");
    });
});
