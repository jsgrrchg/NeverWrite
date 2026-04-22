import { describe, expect, it } from "vitest";
import { mockInvoke, setEditorTabs } from "../../test/test-utils";
import { useBookmarkStore } from "./bookmarkStore";
import { useEditorStore } from "./editorStore";
import { useVaultStore, type VaultEntryDto } from "./vaultStore";

function folderEntry(path: string): VaultEntryDto {
    const name = path.split("/").pop() ?? path;
    return {
        id: path,
        path: `/vault/${path}`,
        relative_path: path,
        title: name,
        file_name: name,
        extension: "",
        kind: "folder",
        modified_at: 1,
        created_at: 1,
        size: 0,
        mime_type: null,
    };
}

function fileEntry(path: string): VaultEntryDto {
    const fileName = path.split("/").pop() ?? path;
    const dotIndex = fileName.lastIndexOf(".");
    return {
        id: path,
        path: `/vault/${path}`,
        relative_path: path,
        title: dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName,
        file_name: fileName,
        extension: dotIndex > 0 ? fileName.slice(dotIndex + 1) : "",
        kind: "file",
        modified_at: 1,
        created_at: 1,
        size: 10,
        mime_type: "text/plain",
    };
}

describe("vaultStore", () => {
    it("refreshes entries after creating a note", async () => {
        const invokeMock = mockInvoke();

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "create_note") {
                expect(args).toEqual({
                    vaultPath: "/vault",
                    path: "notes/new-note.md",
                    content: "",
                });
                return {
                    id: "notes/new-note",
                    path: "/vault/notes/new-note.md",
                    title: "New Note",
                };
            }

            if (command === "list_vault_entries") {
                expect(args).toEqual({ vaultPath: "/vault" });
                return [
                    {
                        id: "notes",
                        path: "/vault/notes",
                        relative_path: "notes",
                        title: "notes",
                        file_name: "notes",
                        extension: "",
                        kind: "folder",
                        modified_at: 0,
                        created_at: 0,
                        size: 0,
                        mime_type: null,
                    },
                    {
                        id: "notes/new-note",
                        path: "/vault/notes/new-note.md",
                        relative_path: "notes/new-note.md",
                        title: "New Note",
                        file_name: "new-note.md",
                        extension: "md",
                        kind: "note",
                        modified_at: 0,
                        created_at: 0,
                        size: 0,
                        mime_type: "text/markdown",
                    },
                ];
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        useVaultStore.setState({ vaultPath: "/vault" });

        const note = await useVaultStore.getState().createNote("notes/new-note");

        expect(note).toEqual({
            id: "notes/new-note",
            path: "/vault/notes/new-note.md",
            title: "New Note",
            modified_at: expect.any(Number),
            created_at: expect.any(Number),
        });
        expect(useVaultStore.getState().entries).toEqual([
            {
                id: "notes",
                path: "/vault/notes",
                relative_path: "notes",
                title: "notes",
                file_name: "notes",
                extension: "",
                kind: "folder",
                modified_at: 0,
                created_at: 0,
                size: 0,
                mime_type: null,
            },
            {
                id: "notes/new-note",
                path: "/vault/notes/new-note.md",
                relative_path: "notes/new-note.md",
                title: "New Note",
                file_name: "new-note.md",
                extension: "md",
                kind: "note",
                modified_at: 0,
                created_at: 0,
                size: 0,
                mime_type: "text/markdown",
            },
        ]);
    });

    it("persists folder renames into local vault state immediately", async () => {
        const invokeMock = mockInvoke();

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "move_folder") {
                expect(args).toEqual({
                    vaultPath: "/vault",
                    relativePath: "plans",
                    newRelativePath: "roadmap",
                });
                return undefined;
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [
                {
                    id: "plans/alpha",
                    path: "/vault/plans/alpha.md",
                    title: "Alpha",
                    modified_at: 1,
                    created_at: 1,
                },
            ],
            entries: [
                folderEntry("plans"),
                fileEntry("plans/spec.txt"),
                folderEntry("other"),
            ],
        });
        setEditorTabs([
            {
                id: "note-tab",
                noteId: "plans/alpha",
                title: "Alpha",
                content: "Alpha",
            },
            {
                id: "file-tab",
                relativePath: "plans/spec.txt",
                title: "spec.txt",
                path: "/vault/plans/spec.txt",
                content: "Spec",
                mimeType: "text/plain",
            },
        ]);
        useBookmarkStore.setState({
            items: [
                {
                    id: "bookmark-note",
                    folderId: null,
                    kind: "note",
                    noteId: "plans/alpha",
                    entryPath: null,
                    sortOrder: 0,
                },
                {
                    id: "bookmark-file",
                    folderId: null,
                    kind: "file",
                    noteId: null,
                    entryPath: "plans/spec.txt",
                    sortOrder: 1,
                },
            ],
        });

        await expect(
            useVaultStore.getState().renameFolder("plans", "roadmap"),
        ).resolves.toBe(true);

        expect(useVaultStore.getState().notes[0]).toMatchObject({
            id: "roadmap/alpha",
            path: "/vault/roadmap/alpha.md",
        });
        expect(useVaultStore.getState().entries).toEqual([
            expect.objectContaining({
                id: "roadmap",
                path: "/vault/roadmap",
                relative_path: "roadmap",
                title: "roadmap",
                file_name: "roadmap",
            }),
            expect.objectContaining({
                id: "roadmap/spec.txt",
                path: "/vault/roadmap/spec.txt",
                relative_path: "roadmap/spec.txt",
            }),
            expect.objectContaining({ id: "other", relative_path: "other" }),
        ]);
        expect(useEditorStore.getState().tabs).toEqual([
            expect.objectContaining({
                id: "note-tab",
                noteId: "roadmap/alpha",
            }),
            expect.objectContaining({
                id: "file-tab",
                relativePath: "roadmap/spec.txt",
                path: "/vault/roadmap/spec.txt",
            }),
        ]);
        expect(useBookmarkStore.getState().items).toEqual([
            expect.objectContaining({ noteId: "roadmap/alpha" }),
            expect.objectContaining({ entryPath: "roadmap/spec.txt" }),
        ]);
    });
});
