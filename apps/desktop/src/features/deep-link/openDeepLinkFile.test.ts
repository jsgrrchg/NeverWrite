import { beforeEach, describe, expect, it, vi } from "vitest";

const { openAiEditedFileByAbsolutePath } = vi.hoisted(() => ({
    openAiEditedFileByAbsolutePath: vi.fn(),
}));
vi.mock("../ai/chatFileNavigation", () => ({
    openAiEditedFileByAbsolutePath,
}));

import { useEditorStore } from "../../app/store/editorStore";
import { useVaultStore, type NoteDto } from "../../app/store/vaultStore";
import { openDeepLinkFile } from "./openDeepLinkFile";

function setNotes(notes: Array<{ id: string; path: string }>) {
    useVaultStore.setState({ notes: notes as unknown as NoteDto[] });
}

beforeEach(() => {
    useVaultStore.setState({ vaultPath: "/vault", notes: [] });
    useEditorStore.getState().clearPendingLineReveal();
    openAiEditedFileByAbsolutePath.mockReset().mockResolvedValue(true);
});

describe("openDeepLinkFile", () => {
    it("rejects an empty path", async () => {
        expect(
            await openDeepLinkFile({ path: " ", line: null, endLine: null }),
        ).toBe("invalid");
        expect(openAiEditedFileByAbsolutePath).not.toHaveBeenCalled();
    });

    it("reports when no vault is open", async () => {
        useVaultStore.setState({ vaultPath: null });
        expect(
            await openDeepLinkFile({ path: "a.md", line: null, endLine: null }),
        ).toBe("no-vault");
        expect(openAiEditedFileByAbsolutePath).not.toHaveBeenCalled();
    });

    it("rejects absolute paths outside the vault", async () => {
        expect(
            await openDeepLinkFile({
                path: "/etc/passwd",
                line: null,
                endLine: null,
            }),
        ).toBe("outside-vault");
        expect(openAiEditedFileByAbsolutePath).not.toHaveBeenCalled();
    });

    it("rejects relative traversal that escapes the vault", async () => {
        expect(
            await openDeepLinkFile({
                path: "../secret.txt",
                line: null,
                endLine: null,
            }),
        ).toBe("outside-vault");
        expect(openAiEditedFileByAbsolutePath).not.toHaveBeenCalled();
    });

    it("rejects absolute traversal that escapes the vault", async () => {
        expect(
            await openDeepLinkFile({
                path: "/vault/../etc/passwd",
                line: null,
                endLine: null,
            }),
        ).toBe("outside-vault");
        expect(openAiEditedFileByAbsolutePath).not.toHaveBeenCalled();
    });

    it("collapses harmless . / .. segments that stay inside the vault", async () => {
        expect(
            await openDeepLinkFile({
                path: "notes/../a.md",
                line: null,
                endLine: null,
            }),
        ).toBe("opened");
        expect(openAiEditedFileByAbsolutePath).toHaveBeenCalledWith("/vault/a.md");
    });

    it("resolves a relative path against the vault root and opens it", async () => {
        expect(
            await openDeepLinkFile({
                path: "notes/a.md",
                line: null,
                endLine: null,
            }),
        ).toBe("opened");
        expect(openAiEditedFileByAbsolutePath).toHaveBeenCalledWith(
            "/vault/notes/a.md",
        );
    });

    it("accepts an absolute path inside the vault", async () => {
        expect(
            await openDeepLinkFile({
                path: "/vault/sub/x.md",
                line: null,
                endLine: null,
            }),
        ).toBe("opened");
        expect(openAiEditedFileByAbsolutePath).toHaveBeenCalledWith(
            "/vault/sub/x.md",
        );
    });

    it("reports not-found when the file cannot be opened", async () => {
        openAiEditedFileByAbsolutePath.mockResolvedValue(false);
        expect(
            await openDeepLinkFile({ path: "gone.md", line: null, endLine: null }),
        ).toBe("not-found");
    });

    it("queues a line reveal for notes when a line is given", async () => {
        setNotes([{ id: "note-1", path: "/vault/a.md" }]);
        expect(
            await openDeepLinkFile({ path: "a.md", line: 10, endLine: 20 }),
        ).toBe("opened");
        expect(useEditorStore.getState().pendingLineReveal).toEqual({
            noteId: "note-1",
            line: 10,
            endLine: 20,
        });
    });

    it("does not queue a line reveal without a line", async () => {
        setNotes([{ id: "note-1", path: "/vault/a.md" }]);
        await openDeepLinkFile({ path: "a.md", line: null, endLine: null });
        expect(useEditorStore.getState().pendingLineReveal).toBeNull();
    });

    it("does not queue a line reveal for a non-note file", async () => {
        // `a.txt` is not in the notes list, so a line fragment is a no-op.
        await openDeepLinkFile({ path: "a.txt", line: 10, endLine: null });
        expect(useEditorStore.getState().pendingLineReveal).toBeNull();
    });
});
