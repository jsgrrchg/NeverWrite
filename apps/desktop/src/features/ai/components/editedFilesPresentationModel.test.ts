import { describe, expect, it } from "vitest";
import type { AIEditedFileBufferEntry } from "../types";
import {
    canResolveEntryHunks,
    deriveReviewItems,
} from "./editedFilesPresentationModel";

function makeEntry(
    overrides: Partial<AIEditedFileBufferEntry> = {},
): AIEditedFileBufferEntry {
    return {
        identityKey: "/vault/test.md",
        originPath: "/vault/test.md",
        path: "/vault/test.md",
        previousPath: null,
        operation: "update",
        baseText: "old",
        appliedText: "new",
        reversible: true,
        isText: true,
        supported: true,
        status: "pending",
        appliedHash: "hash-1",
        currentHash: null,
        additions: 1,
        deletions: 1,
        updatedAt: 1,
        ...overrides,
    };
}

describe("editedFilesPresentationModel", () => {
    it("marks update entries with both snapshots as hunk-resolvable", () => {
        expect(canResolveEntryHunks(makeEntry())).toBe(true);
    });

    it("marks move entries with content changes as hunk-resolvable", () => {
        expect(
            canResolveEntryHunks(
                makeEntry({
                    operation: "move",
                    originPath: "/vault/old.md",
                    path: "/vault/new.md",
                }),
            ),
        ).toBe(true);
    });

    it("does not mark pure moves without content changes as hunk-resolvable", () => {
        expect(
            canResolveEntryHunks(
                makeEntry({
                    operation: "move",
                    originPath: "/vault/old.md",
                    path: "/vault/new.md",
                    baseText: "same",
                    appliedText: "same",
                }),
            ),
        ).toBe(false);
    });

    it("does not allow per-hunk resolution for add, delete, partial or conflict entries", () => {
        expect(
            canResolveEntryHunks(
                makeEntry({
                    operation: "add",
                    baseText: null,
                }),
            ),
        ).toBe(false);
        expect(
            canResolveEntryHunks(
                makeEntry({
                    operation: "delete",
                    appliedText: null,
                }),
            ),
        ).toBe(false);
        expect(
            canResolveEntryHunks(
                makeEntry({
                    supported: false,
                }),
            ),
        ).toBe(false);
        expect(
            canResolveEntryHunks(
                makeEntry({
                    status: "conflict",
                }),
            ),
        ).toBe(false);
    });

    it("does not allow per-hunk resolution for large previews without exact hunks", () => {
        const baseText = Array.from(
            { length: 701 },
            (_, index) => `old-${index}`,
        ).join("\n");
        const appliedText = Array.from({ length: 701 }, (_, index) =>
            index === 350 ? "changed" : `old-${index}`,
        ).join("\n");

        expect(
            canResolveEntryHunks(
                makeEntry({
                    baseText,
                    appliedText,
                }),
            ),
        ).toBe(false);
    });

    it("allows per-hunk resolution for large files when exact hunks are available", () => {
        const baseText = Array.from(
            { length: 900 },
            (_, index) => `old-${index}`,
        ).join("\n");
        const appliedText = Array.from({ length: 900 }, (_, index) =>
            index === 350 ? "changed-350" : `old-${index}`,
        ).join("\n");

        expect(
            canResolveEntryHunks(
                makeEntry({
                    baseText,
                    appliedText,
                    hunks: [
                        {
                            old_start: 346,
                            old_count: 11,
                            new_start: 346,
                            new_count: 11,
                            lines: [
                                { type: "context", text: "old-345" },
                                { type: "context", text: "old-346" },
                                { type: "context", text: "old-347" },
                                { type: "context", text: "old-348" },
                                { type: "context", text: "old-349" },
                                { type: "remove", text: "old-350" },
                                { type: "add", text: "changed-350" },
                                { type: "context", text: "old-351" },
                                { type: "context", text: "old-352" },
                                { type: "context", text: "old-353" },
                                { type: "context", text: "old-354" },
                                { type: "context", text: "old-355" },
                            ],
                        },
                    ],
                }),
            ),
        ).toBe(true);
    });

    it("adds canResolveHunks to derived review items", () => {
        const items = deriveReviewItems(
            [
                makeEntry(),
                makeEntry({
                    identityKey: "/vault/add.md",
                    path: "/vault/add.md",
                    originPath: "/vault/add.md",
                    operation: "add",
                    baseText: null,
                }),
            ],
            new Set<string>(),
        );

        expect(items[0]?.canResolveHunks).toBe(true);
        expect(items[1]?.canResolveHunks).toBe(false);
    });
});
