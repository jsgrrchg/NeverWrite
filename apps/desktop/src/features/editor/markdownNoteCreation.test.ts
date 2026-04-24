import { describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../app/store/editorStore";
import { useVaultStore, type VaultEntryDto } from "../../app/store/vaultStore";
import { setEditorTabs } from "../../test/test-utils";
import {
    createUntitledMarkdownNote,
    openUntitledMarkdownNote,
} from "./markdownNoteCreation";

function note(id: string) {
    return {
        id,
        path: `/vault/${id}.md`,
        title: id.split("/").pop() ?? id,
        modified_at: 1,
        created_at: 1,
    };
}

function entry(relativePath: string): VaultEntryDto {
    const fileName = relativePath.split("/").pop() ?? relativePath;
    return {
        id: relativePath,
        path: `/vault/${relativePath}`,
        relative_path: relativePath,
        title: fileName.replace(/\.md$/i, ""),
        file_name: fileName,
        extension: fileName.toLowerCase().endsWith(".md") ? "md" : "",
        kind: fileName.toLowerCase().endsWith(".md") ? "note" : "file",
        modified_at: 1,
        created_at: 1,
        size: 0,
        mime_type: fileName.toLowerCase().endsWith(".md")
            ? "text/markdown"
            : null,
    };
}

describe("markdown note creation", () => {
    it("creates the next available root markdown note", async () => {
        const createNote = vi.fn().mockResolvedValue(note("Untitled 2"));
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [note("Untitled")],
            entries: [entry("Untitled 1.md")],
            createNote,
        });

        const created = await createUntitledMarkdownNote();

        expect(created?.id).toBe("Untitled 2");
        expect(createNote).toHaveBeenCalledWith("Untitled 2.md");
    });

    it("tries the next untitled name when the snapshot was stale", async () => {
        const createNote = vi
            .fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(note("Untitled 1"));
        useVaultStore.setState({
            vaultPath: "/vault",
            createNote,
        });

        const created = await createUntitledMarkdownNote();

        expect(created?.id).toBe("Untitled 1");
        expect(createNote).toHaveBeenNthCalledWith(1, "Untitled.md");
        expect(createNote).toHaveBeenNthCalledWith(2, "Untitled 1.md");
    });

    it("opens the created markdown note in the focused pane", async () => {
        setEditorTabs([]);
        const createNote = vi.fn().mockResolvedValue(note("Untitled"));
        useVaultStore.setState({
            vaultPath: "/vault",
            createNote,
        });

        await openUntitledMarkdownNote();

        const activeTab = useEditorStore
            .getState()
            .panes[0]?.tabs.find(
                (tab) =>
                    tab.id ===
                    useEditorStore.getState().panes[0]?.activeTabId,
            );
        expect(activeTab).toMatchObject({
            kind: "note",
            noteId: "Untitled",
            title: "Untitled",
            content: "",
        });
    });
});
