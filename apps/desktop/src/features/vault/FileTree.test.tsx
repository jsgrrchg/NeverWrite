import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import { describe, expect, it, vi } from "vitest";
import {
    useEditorStore,
    isFileTab,
    isNoteTab,
} from "../../app/store/editorStore";
import { useSettingsStore } from "../../app/store/settingsStore";
import { useVaultStore } from "../../app/store/vaultStore";
import {
    renderComponent,
    setEditorTabs,
    setVaultEntries,
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

function getFileRow(label: string) {
    const row = screen.getByText(label).closest('[role="button"]');
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

function buildFolderEntry(path: string) {
    const name = path.split("/").pop() ?? path;
    return {
        id: path,
        path: `/vault/${path}`,
        relative_path: path,
        title: name,
        file_name: name,
        extension: "",
        kind: "folder" as const,
        modified_at: 1,
        created_at: 1,
        size: 0,
        mime_type: null,
    };
}

describe("FileTree", () => {
    it("anchors the virtualized layers to the viewport width", async () => {
        const user = userEvent.setup();

        setVaultNotes([
            {
                id: "notes/alpha-with-a-very-long-name-that-should-not-stretch-the-virtualized-tree-layout",
                path: "/vault/notes/alpha-with-a-very-long-name-that-should-not-stretch-the-virtualized-tree-layout.md",
                title: "Alpha with a very long name that should not stretch the virtualized tree layout",
                modified_at: 1,
                created_at: 1,
            },
        ]);

        renderComponent(<FileTree />);
        await expandFolder(user, "notes");

        const viewport = screen.getByTestId("file-tree-viewport");
        const virtualCanvas = screen.getByTestId("file-tree-virtual-canvas");
        const rowsLayer = screen.getByTestId("file-tree-rows-layer");
        const row = getNoteRow(
            "Alpha with a very long name that should not stretch the virtualized tree layout",
        );
        const label = screen.getByText(
            "Alpha with a very long name that should not stretch the virtualized tree layout",
        );

        expect(viewport).toHaveStyle({
            boxSizing: "border-box",
            paddingInline: "4px",
        });
        expect(virtualCanvas).toHaveStyle({
            width: "100%",
            minWidth: "100%",
            boxSizing: "border-box",
        });
        expect(virtualCanvas.getAttribute("style")).not.toContain("fit-content");
        expect(rowsLayer).toHaveStyle({
            width: "100%",
            minWidth: "100%",
            boxSizing: "border-box",
        });
        expect(row).toHaveStyle({
            width: "100%",
            minWidth: "0",
            boxSizing: "border-box",
        });
        expect(label).toHaveClass(
            "min-w-0",
            "flex-1",
            "overflow-hidden",
            "text-ellipsis",
            "whitespace-nowrap",
        );
    });

    it("keeps sticky folder layers aligned with the viewport width after scrolling", async () => {
        const user = userEvent.setup();

        setVaultNotes([
            {
                id: "root/folder/alpha",
                path: "/vault/root/folder/alpha.md",
                title: "Alpha",
                modified_at: 1,
                created_at: 1,
            },
            {
                id: "root/folder/beta",
                path: "/vault/root/folder/beta.md",
                title: "Beta",
                modified_at: 1,
                created_at: 1,
            },
            {
                id: "root/folder/gamma",
                path: "/vault/root/folder/gamma.md",
                title: "Gamma",
                modified_at: 1,
                created_at: 1,
            },
        ]);

        renderComponent(<FileTree />);
        await expandFolder(user, "root");
        await expandFolder(user, "folder");

        const viewport = screen.getByTestId("file-tree-viewport");
        Object.defineProperty(viewport, "clientHeight", {
            configurable: true,
            value: 48,
        });
        viewport.scrollTop = 40;
        fireEvent.scroll(viewport);
        fireEvent(window, new Event("resize"));

        const stickyLayer = await screen.findByTestId("file-tree-sticky-layer");
        expect(stickyLayer).toHaveStyle({
            width: "100%",
            minWidth: "100%",
            boxSizing: "border-box",
        });
    });

    it("clamps scroll state safely when the viewport becomes much taller than the content", async () => {
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
        await expandFolder(user, "notes");

        const viewport = screen.getByTestId("file-tree-viewport");
        Object.defineProperty(viewport, "clientHeight", {
            configurable: true,
            value: 2400,
        });
        viewport.scrollTop = 900;
        fireEvent.scroll(viewport);
        fireEvent(window, new Event("resize"));

        await waitFor(() => {
            expect(viewport.scrollTop).toBe(0);
        });
    });

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

    it("deletes a folder from the context menu and closes every tab inside it", async () => {
        const user = userEvent.setup();
        const deleteFolder = vi.fn().mockResolvedValue(undefined);

        vi.mocked(confirm).mockResolvedValueOnce(true);
        useVaultStore.setState({ deleteFolder });
        setVaultEntries([buildFolderEntry("assets")]);
        setEditorTabs([
            {
                id: "note-tab",
                noteId: "assets/alpha",
                title: "Alpha",
                content: "Alpha",
            },
            {
                id: "pdf-tab",
                kind: "pdf",
                entryId: "assets/spec.pdf",
                title: "Spec",
                path: "/vault/assets/spec.pdf",
                page: 1,
                zoom: 1,
                viewMode: "continuous",
            },
            {
                id: "file-tab",
                kind: "file",
                relativePath: "assets/photo.png",
                path: "/vault/assets/photo.png",
                title: "Photo",
                content: "",
                mimeType: "image/png",
                viewer: "image",
            },
            {
                id: "keep-tab",
                noteId: "archive/keep",
                title: "Keep",
                content: "Keep",
            },
        ]);

        renderComponent(<FileTree />);

        fireEvent.contextMenu(getFolderRow("assets"));
        await user.click(await screen.findByText("Delete Folder"));

        await waitFor(() => {
            expect(deleteFolder).toHaveBeenCalledWith("assets");
        });
        expect(confirm).toHaveBeenCalledWith(
            'Delete folder "assets" and all its contents?',
            { title: "Delete Folder", kind: "warning" },
        );
        expect(useEditorStore.getState().tabs.map((tab) => tab.id)).toEqual([
            "keep-tab",
        ]);
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
        expect(
            activeTab && isNoteTab(activeTab) ? activeTab.noteId : null,
        ).toBe("notes/beta");
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
        expect(
            activeTab && isNoteTab(activeTab) ? activeTab.noteId : null,
        ).toBe("notes/beta");
        expect(
            activeTab && isNoteTab(activeTab) ? activeTab.content : null,
        ).toBe("Beta body");
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
        vi.mocked(invoke).mockImplementation(async (command, args) => {
            if (command === "copy_folder") {
                return {
                    id: "archive/projects",
                    path: "/vault/archive/projects",
                    relative_path: "archive/projects",
                    title: "projects",
                    file_name: "projects",
                    extension: "",
                    kind: "folder",
                    modified_at: 1,
                    created_at: 1,
                    size: 0,
                    mime_type: null,
                };
            }
            if (command === "list_notes") {
                return [
                    buildCreatedNote("projects/alpha"),
                    buildCreatedNote("projects/sub/beta"),
                    buildCreatedNote("archive/existing"),
                    buildCreatedNote("archive/projects/alpha"),
                    buildCreatedNote("archive/projects/sub/beta"),
                ];
            }
            if (command === "list_vault_entries") {
                return [
                    {
                        id: "archive/projects",
                        path: "/vault/archive/projects",
                        relative_path: "archive/projects",
                        title: "projects",
                        file_name: "projects",
                        extension: "",
                        kind: "folder",
                        modified_at: 1,
                        created_at: 1,
                        size: 0,
                        mime_type: null,
                    },
                    {
                        id: "archive/projects/sub",
                        path: "/vault/archive/projects/sub",
                        relative_path: "archive/projects/sub",
                        title: "sub",
                        file_name: "sub",
                        extension: "",
                        kind: "folder",
                        modified_at: 1,
                        created_at: 1,
                        size: 0,
                        mime_type: null,
                    },
                ];
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
            expect(invoke).toHaveBeenCalledWith("copy_folder", {
                relativePath: "projects",
                newRelativePath: "archive/projects",
                vaultPath: "/vault",
            });
        });
        expect(
            useVaultStore
                .getState()
                .notes.some((note) => note.id === "archive/projects/sub/beta"),
        ).toBe(true);
    });

    it("selects image files in the tree and opens them in-app", async () => {
        const user = userEvent.setup();

        setVaultNotes([]);
        setVaultEntries([
            buildFolderEntry("assets"),
            {
                id: "assets/photo.png",
                path: "/vault/assets/photo.png",
                relative_path: "assets/photo.png",
                title: "photo",
                file_name: "photo.png",
                extension: "png",
                kind: "file",
                modified_at: 1,
                created_at: 1,
                size: 128,
                mime_type: "image/png",
            },
        ]);
        useSettingsStore
            .getState()
            .setSetting("fileTreeContentMode", "all_files");

        renderComponent(<FileTree />);
        await expandFolder(user, "assets");
        await user.click(getFileRow("photo"));

        await waitFor(() => {
            const activeTab = useEditorStore
                .getState()
                .tabs.find(
                    (tab) => tab.id === useEditorStore.getState().activeTabId,
                );
            expect(
                activeTab && isFileTab(activeTab)
                    ? activeTab.relativePath
                    : null,
            ).toBe("assets/photo.png");
        });

        const row = getFileRow("photo");
        expect(row).toHaveAttribute("data-selected", "true");
        expect(row).toHaveAttribute("data-active", "true");
    });

    it("reveals the active pdf tab in nested folders", async () => {
        localStorage.setItem("vaultai:reveal-active", "true");

        setVaultNotes([]);
        setVaultEntries([
            {
                id: "docs/design/blueprint.pdf",
                path: "/vault/docs/design/blueprint.pdf",
                relative_path: "docs/design/blueprint.pdf",
                title: "Blueprint",
                file_name: "blueprint.pdf",
                extension: "pdf",
                kind: "pdf",
                modified_at: 1,
                created_at: 1,
                size: 256,
                mime_type: "application/pdf",
            },
        ]);
        setEditorTabs(
            [
                {
                    id: "pdf-tab",
                    kind: "pdf",
                    entryId: "docs/design/blueprint.pdf",
                    title: "Blueprint",
                    path: "/vault/docs/design/blueprint.pdf",
                    page: 1,
                    zoom: 1,
                    viewMode: "continuous",
                },
            ],
            "pdf-tab",
        );

        renderComponent(<FileTree />);

        expect(await screen.findByText("design")).toBeInTheDocument();
        const row = await screen.findByText("Blueprint");
        expect(row.closest('[role="button"]')).toHaveAttribute(
            "data-active",
            "true",
        );
    });

    it("reveals the active generic file tab in nested folders", async () => {
        localStorage.setItem("vaultai:reveal-active", "true");

        setVaultNotes([]);
        setVaultEntries([
            buildFolderEntry("assets"),
            buildFolderEntry("assets/images"),
            {
                id: "assets/images/photo.png",
                path: "/vault/assets/images/photo.png",
                relative_path: "assets/images/photo.png",
                title: "Photo",
                file_name: "photo.png",
                extension: "png",
                kind: "file",
                modified_at: 1,
                created_at: 1,
                size: 128,
                mime_type: "image/png",
            },
        ]);
        useSettingsStore
            .getState()
            .setSetting("fileTreeContentMode", "all_files");
        setEditorTabs(
            [
                {
                    id: "file-tab",
                    kind: "file",
                    relativePath: "assets/images/photo.png",
                    path: "/vault/assets/images/photo.png",
                    title: "Photo",
                    content: "",
                    mimeType: "image/png",
                    viewer: "image",
                },
            ],
            "file-tab",
        );

        renderComponent(<FileTree />);

        expect(await screen.findByText("images")).toBeInTheDocument();
        const row = getFileRow("Photo");
        expect(row).toHaveAttribute("data-active", "true");
    });

    it("allows multi-selecting pdfs and files with cmd-click", async () => {
        const user = userEvent.setup();

        setVaultNotes([]);
        setVaultEntries([
            {
                id: "assets/reference.pdf",
                path: "/vault/assets/reference.pdf",
                relative_path: "assets/reference.pdf",
                title: "Reference",
                file_name: "reference.pdf",
                extension: "pdf",
                kind: "pdf",
                modified_at: 1,
                created_at: 1,
                size: 256,
                mime_type: "application/pdf",
            },
            {
                id: "assets/photo.png",
                path: "/vault/assets/photo.png",
                relative_path: "assets/photo.png",
                title: "Photo",
                file_name: "photo.png",
                extension: "png",
                kind: "file",
                modified_at: 1,
                created_at: 1,
                size: 128,
                mime_type: "image/png",
            },
        ]);
        useSettingsStore
            .getState()
            .setSetting("fileTreeContentMode", "all_files");

        renderComponent(<FileTree />);
        await expandFolder(user, "assets");

        await user.click(getFileRow("Reference"));
        fireEvent.click(getFileRow("Photo"), { metaKey: true });

        expect(getFileRow("Reference")).toHaveAttribute(
            "data-selected",
            "true",
        );
        expect(getFileRow("Photo")).toHaveAttribute("data-selected", "true");

        fireEvent.contextMenu(getFileRow("Photo"));

        expect(getFileRow("Reference")).toHaveAttribute(
            "data-selected",
            "true",
        );
        expect(getFileRow("Photo")).toHaveAttribute("data-selected", "true");
    });

    it("selects unsupported files on context menu and keeps open-in-new-tab disabled", async () => {
        const user = userEvent.setup();

        setVaultNotes([]);
        setVaultEntries([
            buildFolderEntry("assets"),
            {
                id: "assets/archive.bin",
                path: "/vault/assets/archive.bin",
                relative_path: "assets/archive.bin",
                title: "archive",
                file_name: "archive.bin",
                extension: "bin",
                kind: "file",
                modified_at: 1,
                created_at: 1,
                size: 256,
                mime_type: null,
            },
        ]);
        useSettingsStore
            .getState()
            .setSetting("fileTreeContentMode", "all_files");

        renderComponent(<FileTree />);
        await expandFolder(user, "assets");

        fireEvent.contextMenu(getFileRow("archive"));

        const row = getFileRow("archive");
        expect(row).toHaveAttribute("data-selected", "true");
        expect(
            await screen.findByRole("button", { name: "Open in New Tab" }),
        ).toBeDisabled();
        expect(
            await screen.findByRole("button", { name: "Add to Chat" }),
        ).toBeInTheDocument();
    });

    it("moves generic files to another folder via drag and drop", async () => {
        const user = userEvent.setup();

        setVaultNotes([]);
        setVaultEntries([
            buildFolderEntry("assets"),
            buildFolderEntry("archive"),
            {
                id: "assets/photo.png",
                path: "/vault/assets/photo.png",
                relative_path: "assets/photo.png",
                title: "photo",
                file_name: "photo.png",
                extension: "png",
                kind: "file",
                modified_at: 1,
                created_at: 1,
                size: 128,
                mime_type: "image/png",
            },
            {
                id: "archive/reference.txt",
                path: "/vault/archive/reference.txt",
                relative_path: "archive/reference.txt",
                title: "reference",
                file_name: "reference.txt",
                extension: "txt",
                kind: "file",
                modified_at: 1,
                created_at: 1,
                size: 10,
                mime_type: "text/plain",
            },
        ]);
        useSettingsStore
            .getState()
            .setSetting("fileTreeContentMode", "all_files");

        vi.mocked(invoke).mockImplementation(async (command) => {
            if (command === "move_vault_entry") {
                return {
                    id: "archive/photo.png",
                    path: "/vault/archive/photo.png",
                    relative_path: "archive/photo.png",
                    title: "photo",
                    file_name: "photo.png",
                    extension: "png",
                    kind: "file",
                    modified_at: 2,
                    created_at: 1,
                    size: 128,
                    mime_type: "image/png",
                };
            }
            if (command === "list_vault_entries") {
                return [
                    {
                        id: "archive/photo.png",
                        path: "/vault/archive/photo.png",
                        relative_path: "archive/photo.png",
                        title: "photo",
                        file_name: "photo.png",
                        extension: "png",
                        kind: "file",
                        modified_at: 2,
                        created_at: 1,
                        size: 128,
                        mime_type: "image/png",
                    },
                    {
                        id: "archive/reference.txt",
                        path: "/vault/archive/reference.txt",
                        relative_path: "archive/reference.txt",
                        title: "reference",
                        file_name: "reference.txt",
                        extension: "txt",
                        kind: "file",
                        modified_at: 1,
                        created_at: 1,
                        size: 10,
                        mime_type: "text/plain",
                    },
                ];
            }
            return undefined;
        });

        renderComponent(<FileTree />);
        await expandFolder(user, "assets");
        await expandFolder(user, "archive");

        const fileRow = getFileRow("photo");
        const archiveFolder = getFolderRow("archive");
        const elementsFromPoint = vi.fn(() => [archiveFolder]);
        Object.defineProperty(document, "elementsFromPoint", {
            configurable: true,
            value: elementsFromPoint,
        });

        fireEvent.mouseDown(fileRow, { button: 0, clientX: 10, clientY: 10 });
        fireEvent.mouseMove(window, { clientX: 30, clientY: 30 });
        fireEvent.mouseUp(window);

        await waitFor(() => {
            expect(invoke).toHaveBeenCalledWith("move_vault_entry", {
                relativePath: "assets/photo.png",
                newRelativePath: "archive/photo.png",
                vaultPath: "/vault",
            });
        });

        expect(
            useVaultStore
                .getState()
                .entries.some(
                    (entry) => entry.relative_path === "archive/photo.png",
                ),
        ).toBe(true);
        expect(elementsFromPoint).toHaveBeenCalled();
    });
});
