import { describe, expect, it } from "vitest";
import { mockInvoke } from "../../test/test-utils";
import { useVaultStore } from "./vaultStore";

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
});
