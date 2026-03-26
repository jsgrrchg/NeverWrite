import { describe, expect, it } from "vitest";
import {
    serializeComposerParts,
    serializeComposerPartsForAI,
} from "./composerParts";
import type { AIComposerPart } from "./types";

describe("serializeComposerPartsForAI", () => {
    it("keeps UI pills decorated but sends plain paths to the agent", () => {
        const parts: AIComposerPart[] = [
            { id: "text-1", type: "text", text: "Review " },
            {
                id: "mention-1",
                type: "mention",
                noteId: "notes/spec.md",
                label: "Spec",
                path: "/vault/notes/spec.md",
            },
            { id: "text-2", type: "text", text: " and " },
            {
                id: "folder-1",
                type: "folder_mention",
                label: "docs",
                folderPath: "/vault/docs",
            },
            { id: "text-3", type: "text", text: " plus " },
            {
                id: "selection-1",
                type: "selection_mention",
                noteId: "notes/spec.md",
                label: "Lines 10-12",
                path: "/vault/notes/spec.md",
                selectedText: "selected",
                startLine: 10,
                endLine: 12,
            },
            { id: "text-4", type: "text", text: " with " },
            {
                id: "file-1",
                type: "file_attachment",
                filePath: "/vault/docs/guide.md",
                mimeType: "text/markdown",
                label: "guide.md",
            },
            { id: "text-5", type: "text", text: " and " },
            {
                id: "shot-1",
                type: "screenshot",
                filePath: "/vault/assets/chat/screenshot.png",
                mimeType: "image/png",
                label: "Screenshot 10:42 hrs",
            },
        ];

        expect(serializeComposerParts(parts)).toBe(
            "Review [@Spec] and [@📁 docs] plus [@Lines 10-12] with [📎 guide.md] and [Screenshot 10:42 hrs]",
        );
        expect(serializeComposerPartsForAI(parts)).toBe(
            "Review /vault/notes/spec.md and /vault/docs plus /vault/notes/spec.md:10-12 with /vault/docs/guide.md and /vault/assets/chat/screenshot.png",
        );
    });

    it("resolves relative paths against the vault root before sending to the agent", () => {
        const parts: AIComposerPart[] = [
            { id: "text-1", type: "text", text: "Inspect " },
            {
                id: "mention-1",
                type: "mention",
                noteId: "notes/spec.md",
                label: "Spec",
                path: "notes/spec.md",
            },
            { id: "text-2", type: "text", text: " and " },
            {
                id: "folder-1",
                type: "folder_mention",
                label: "docs",
                folderPath: "docs",
            },
            { id: "text-3", type: "text", text: " plus " },
            {
                id: "selection-1",
                type: "selection_mention",
                noteId: "notes/spec.md",
                label: "Lines 1-2",
                path: "notes/spec.md",
                selectedText: "selected",
                startLine: 1,
                endLine: 2,
            },
            { id: "text-4", type: "text", text: " and " },
            {
                id: "file-1",
                type: "file_attachment",
                filePath: "@/vault/docs/guide.md",
                mimeType: "text/markdown",
                label: "guide.md",
            },
        ];

        expect(
            serializeComposerPartsForAI(parts, {
                vaultPath: "/vault",
            }),
        ).toBe(
            "Inspect /vault/notes/spec.md and /vault/docs plus /vault/notes/spec.md:1-2 and /vault/docs/guide.md",
        );
    });
});
