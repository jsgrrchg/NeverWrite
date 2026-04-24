import { invoke } from "@neverwrite/runtime";
import { describe, expect, it, vi } from "vitest";
import { isNoteTab, useEditorStore } from "../../app/store/editorStore";
import {
    setEditorTabs,
    setVaultEntries,
    setVaultNotes,
} from "../../test/test-utils";
import {
    canOpenAiEditedFileByAbsolutePath,
    openAiEditedFileByAbsolutePath,
} from "./chatFileNavigation";

describe("chatFileNavigation", () => {
    it("keeps openable absolute paths actionable while entry metadata is still stale", () => {
        setVaultNotes([]);
        setVaultEntries([]);

        expect(canOpenAiEditedFileByAbsolutePath("/vault/src/main.ts")).toBe(
            true,
        );
        expect(
            canOpenAiEditedFileByAbsolutePath("/vault/assets/logo.png"),
        ).toBe(true);
        expect(canOpenAiEditedFileByAbsolutePath("/vault/archive.zip")).toBe(
            false,
        );
    });

    it("opens notes resolved from backend metadata even when the note store is stale", async () => {
        const invokeMock = vi.mocked(invoke);
        invokeMock.mockImplementation(async (command, args) => {
            if (command === "read_vault_entry") {
                expect(args).toMatchObject({
                    relativePath: "docs/roadmap.md",
                    vaultPath: "/vault",
                });
                return {
                    id: "docs/roadmap.md",
                    path: "/vault/docs/roadmap.md",
                    relative_path: "docs/roadmap.md",
                    title: "Roadmap",
                    file_name: "roadmap.md",
                    extension: "md",
                    kind: "note",
                    modified_at: 0,
                    created_at: 0,
                    size: 12,
                    mime_type: "text/markdown",
                    is_text_like: true,
                    is_image_like: false,
                    open_in_app: true,
                    viewer_kind: "markdown",
                };
            }

            if (command === "read_note") {
                expect(args).toMatchObject({
                    noteId: "docs/roadmap.md",
                    vaultPath: "/vault",
                });
                return {
                    content: "# Roadmap",
                };
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        setEditorTabs([]);
        setVaultNotes([], "/vault");
        setVaultEntries([], "/vault");

        const opened = await openAiEditedFileByAbsolutePath(
            "/vault/docs/roadmap.md",
        );

        expect(opened).toBe(true);
        const noteTab = useEditorStore
            .getState()
            .tabs.find(
                (tab) => isNoteTab(tab) && tab.noteId === "docs/roadmap.md",
            );
        expect(noteTab).toMatchObject({
            title: "Roadmap",
            content: "# Roadmap",
        });
    });
});
