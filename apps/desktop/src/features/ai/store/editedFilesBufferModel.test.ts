import { describe, expect, it } from "vitest";
import { consolidateEditedFilesBuffer } from "./editedFilesBufferModel";
import type { AIFileDiff } from "../types";

describe("editedFilesBufferModel", () => {
    it("preserves exact hunks when consolidating incoming diffs", () => {
        const diffs: AIFileDiff[] = [
            {
                path: "/vault/src/watcher.rs",
                kind: "update",
                old_text: "legacy old",
                new_text: "legacy new",
                hunks: [
                    {
                        old_start: 7,
                        old_count: 2,
                        new_start: 7,
                        new_count: 2,
                        lines: [
                            { type: "context", text: "shared" },
                            { type: "remove", text: "old" },
                            { type: "add", text: "new" },
                        ],
                    },
                ],
            },
        ];

        const entries = consolidateEditedFilesBuffer([], diffs, 1234);

        expect(entries).toHaveLength(1);
        expect(entries[0].hunks).toEqual(diffs[0].hunks);
    });

    it("omits hunks when the incoming diff has no exact metadata", () => {
        const diffs: AIFileDiff[] = [
            {
                path: "/vault/src/watcher.rs",
                kind: "update",
                old_text: "old",
                new_text: "new",
            },
        ];

        const entries = consolidateEditedFilesBuffer([], diffs, 1234);

        expect(entries).toHaveLength(1);
        expect(entries[0].hunks).toBeUndefined();
    });

    it("does not duplicate entries when consolidating the same diffs twice", () => {
        const diffs: AIFileDiff[] = [
            {
                path: "/test.md",
                kind: "update",
                old_text: "a",
                new_text: "b",
                is_text: true,
                reversible: true,
            },
        ];
        const first = consolidateEditedFilesBuffer([], diffs, Date.now());
        const second = consolidateEditedFilesBuffer(first, diffs, Date.now());

        expect(second).toHaveLength(1);
        expect(second[0].path).toBe("/test.md");
    });

    it("updates the entry when a newer diff arrives for the same file", () => {
        const diff1: AIFileDiff[] = [
            {
                path: "/notes/daily.md",
                kind: "update",
                old_text: "original",
                new_text: "first edit",
            },
        ];
        const diff2: AIFileDiff[] = [
            {
                path: "/notes/daily.md",
                kind: "update",
                old_text: "original",
                new_text: "second edit",
            },
        ];

        const first = consolidateEditedFilesBuffer([], diff1, 1000);
        const second = consolidateEditedFilesBuffer(first, diff2, 2000);

        expect(second).toHaveLength(1);
        expect(second[0].appliedText).toBe("second edit");
        expect(second[0].baseText).toBe("original");
    });
});
