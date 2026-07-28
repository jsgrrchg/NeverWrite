import { describe, expect, it, vi } from "vitest";
import { mockInvoke, setEditorTabs } from "../../test/test-utils";
import { useBookmarkStore } from "./bookmarkStore";
import { useEditorStore } from "./editorStore";
import {
    ACTIVE_VAULT_RECENT_REMOVAL_ERROR,
    useVaultStore,
    clearRecentVaults,
    getRecentVaults,
    removeVaultFromList,
    type VaultEntryDto,
    type VaultNoteChange,
} from "./vaultStore";

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

function upsertChange(
    note: {
        id: string;
        path: string;
        title: string;
        status?: string | null;
        okf_type?: string | null;
    },
): VaultNoteChange {
    return {
        vault_path: "/vault",
        kind: "upsert",
        note: {
            modified_at: 1,
            created_at: 1,
            ...note,
        },
        note_id: note.id,
        entry: null,
        relative_path: `${note.id}.md`,
        origin: "external",
        op_id: null,
        revision: 1,
        content_hash: null,
        graph_revision: 0,
        status: note.status ?? null,
        okf_type: note.okf_type ?? null,
    };
}

describe("vaultStore", () => {
    it("does not forget device-local AI data while the vault is active", async () => {
        const invoke = mockInvoke();
        localStorage.setItem(
            "neverwrite:recentVaults",
            JSON.stringify([{ path: "/vault", name: "Vault" }]),
        );
        useVaultStore.setState({ vaultPath: "/vault" });

        await expect(removeVaultFromList("/vault")).rejects.toThrow(
            ACTIVE_VAULT_RECENT_REMOVAL_ERROR,
        );

        expect(invoke).not.toHaveBeenCalledWith(
            "forget_ai_history_device_data",
            expect.anything(),
        );
        expect(getRecentVaults()).toEqual([
            { path: "/vault", name: "Vault" },
        ]);
    });

    it("forgets only device-local AI data when a vault is removed from Recents", async () => {
        const invoke = mockInvoke();
        invoke.mockResolvedValue(undefined);
        useVaultStore.setState({ vaultPath: null });

        await removeVaultFromList("/vault");

        expect(invoke).toHaveBeenCalledWith("forget_ai_history_device_data", {
            vaultPath: "/vault",
            activeVaultPath: null,
        });
        expect(invoke).not.toHaveBeenCalledWith(
            "ai_delete_all_session_histories",
            expect.anything(),
        );
        vi.clearAllMocks();

        clearRecentVaults();
        expect(invoke).not.toHaveBeenCalledWith(
            "forget_ai_history_device_data",
            expect.anything(),
        );
    });

    it("keeps a Recent visible when device-local cleanup cannot be verified", async () => {
        const invoke = mockInvoke();
        invoke.mockRejectedValueOnce(new Error("cleanup blocked"));
        localStorage.setItem(
            "neverwrite:recentVaults",
            JSON.stringify([{ path: "/missing-vault", name: "Missing" }]),
        );

        await expect(removeVaultFromList("/missing-vault")).rejects.toThrow(
            "cleanup blocked",
        );

        expect(getRecentVaults()).toEqual([
            { path: "/missing-vault", name: "Missing" },
        ]);
        expect(invoke).not.toHaveBeenCalledWith(
            "delete_vault_snapshot",
            expect.anything(),
        );
    });

    it("updates a note's status and okf_type when a change event arrives", () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [
                {
                    id: "notes/alpha",
                    path: "/vault/notes/alpha.md",
                    title: "Alpha",
                    modified_at: 1,
                    created_at: 1,
                },
            ],
        });

        const before = useVaultStore.getState().structureRevision;

        useVaultStore.getState().applyVaultNoteChange(
            upsertChange({
                id: "notes/alpha",
                path: "/vault/notes/alpha.md",
                title: "Alpha",
                status: "published",
                okf_type: "runbook",
            }),
        );

        const note = useVaultStore
            .getState()
            .notes.find((n) => n.id === "notes/alpha");
        expect(note?.status).toBe("published");
        expect(note?.okf_type).toBe("runbook");
        // A status/type change must bump structureRevision so the tree
        // rebuilds and its status dot updates live.
        expect(useVaultStore.getState().structureRevision).toBe(before + 1);
    });

    it("updates status via updateNoteMetadata and bumps only the structure revision", () => {
        // Runtime sequence for an app-initiated save: the backend's change
        // event has origin "user" and is ignored by the renderer, so the
        // editor pushes status/okf_type from the save_note response through
        // updateNoteMetadata. The tree rebuild is keyed on structureRevision;
        // resolver/graph revisions must stay untouched for a status-only edit.
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [
                {
                    id: "notes/alpha",
                    path: "/vault/notes/alpha.md",
                    title: "Alpha",
                    modified_at: 1,
                    created_at: 1,
                    status: "draft",
                    okf_type: "runbook",
                },
            ],
        });

        const before = useVaultStore.getState();

        useVaultStore.getState().updateNoteMetadata("notes/alpha", {
            title: "Alpha",
            path: "/vault/notes/alpha.md",
            modified_at: 2,
            status: "published",
            okf_type: "runbook",
        });

        const after = useVaultStore.getState();
        const note = after.notes.find((n) => n.id === "notes/alpha");
        expect(note?.status).toBe("published");
        expect(after.structureRevision).toBe(before.structureRevision + 1);
        expect(after.resolverRevision).toBe(before.resolverRevision);
        expect(after.graphRevision).toBe(before.graphRevision);

        // Unchanged status must not churn the structure revision.
        useVaultStore.getState().updateNoteMetadata("notes/alpha", {
            modified_at: 3,
            status: "published",
            okf_type: "runbook",
        });
        expect(useVaultStore.getState().structureRevision).toBe(
            before.structureRevision + 1,
        );
    });

    it("sets okfVersion from the open state and resets it when switching vaults", async () => {
        const invokeMock = mockInvoke();

        const openStateFor = (okfVersion: string | null) =>
            async (command: string) => {
                if (command === "start_open_vault") return null;
                if (command === "get_vault_open_state") {
                    return {
                        stage: "ready",
                        message: "Vault ready",
                        okf_version: okfVersion,
                    };
                }
                if (command === "list_notes") return [];
                if (command === "list_vault_entries") return [];
                if (command === "get_graph_revision") return 1;
                throw new Error(`Unexpected command: ${command}`);
            };

        invokeMock.mockImplementation(openStateFor("0.1.0"));
        await useVaultStore.getState().openVault("/vault-okf");
        expect(useVaultStore.getState().okfVersion).toBe("0.1.0");

        invokeMock.mockImplementation(openStateFor(null));
        await useVaultStore.getState().openVault("/vault-plain");
        expect(useVaultStore.getState().okfVersion).toBeNull();
    });

    it("normalizes Windows-style vault DTO paths when opening a vault", async () => {
        const invokeMock = mockInvoke();

        invokeMock.mockImplementation(async (command) => {
            if (command === "start_open_vault") return null;
            if (command === "get_vault_open_state") {
                return { stage: "ready", message: "Vault ready" };
            }
            if (command === "list_notes") {
                return [
                    {
                        id: "src\\notes\\alpha",
                        path: "C:\\vault\\src\\notes\\alpha.md",
                        title: "Alpha",
                        modified_at: 1,
                        created_at: 1,
                    },
                ];
            }
            if (command === "list_vault_entries") {
                return [
                    {
                        id: "src\\app",
                        path: "C:\\vault\\src\\app",
                        relative_path: "src\\app",
                        title: "app",
                        file_name: "app",
                        extension: "",
                        kind: "folder",
                        modified_at: 1,
                        created_at: 1,
                        size: 0,
                        mime_type: null,
                    },
                    {
                        id: "src\\app\\main.ts",
                        path: "C:\\vault\\src\\app\\main.ts",
                        relative_path: "src\\app\\main.ts",
                        title: "main",
                        file_name: "main.ts",
                        extension: "ts",
                        kind: "file",
                        modified_at: 1,
                        created_at: 1,
                        size: 10,
                        mime_type: "text/typescript",
                    },
                ];
            }
            if (command === "get_graph_revision") return 1;

            throw new Error(`Unexpected command: ${command}`);
        });

        await useVaultStore.getState().openVault("C:\\vault");

        expect(useVaultStore.getState().notes[0]?.id).toBe(
            "src/notes/alpha",
        );
        expect(useVaultStore.getState().entries).toEqual([
            expect.objectContaining({
                id: "src/app",
                relative_path: "src/app",
            }),
            expect.objectContaining({
                id: "src/app/main.ts",
                relative_path: "src/app/main.ts",
            }),
        ]);
    });

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
