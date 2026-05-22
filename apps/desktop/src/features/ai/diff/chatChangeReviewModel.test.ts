import { describe, expect, it } from "vitest";
import type { TrackedFile } from "./actionLogTypes";
import { deriveChatChangeReviewDiffs } from "./chatChangeReviewModel";
import { buildPatchFromTexts } from "../store/actionLogModel";
import type { AIFileDiff } from "../types";

function makeTrackedFile(
    path: string,
    diffBase: string,
    currentText: string,
): TrackedFile {
    return {
        identityKey: path,
        originPath: path,
        path,
        previousPath: null,
        status: { kind: "modified" },
        reviewState: "pending",
        diffBase,
        currentText,
        unreviewedEdits: buildPatchFromTexts(diffBase, currentText),
        version: 1,
        isText: true,
        updatedAt: 1,
    };
}

describe("deriveChatChangeReviewDiffs", () => {
    it("prefers matched tracked-file diffs over verbose activity hunks", () => {
        const path = "/vault/posts/article.md";
        const activityDiff: AIFileDiff = {
            path,
            kind: "update",
            old_text: "old snippet",
            new_text: "new snippet",
            hunks: [
                {
                    old_start: 20,
                    old_count: 3,
                    new_start: 20,
                    new_count: 3,
                    lines: [
                        { type: "context", text: "before" },
                        { type: "remove", text: "old snippet" },
                        { type: "add", text: "new snippet" },
                        { type: "context", text: "after" },
                    ],
                },
            ],
        };
        const trackedFile = makeTrackedFile(
            path,
            "before\nold snippet\nafter",
            "before\nnew snippet\nafter",
        );

        const [diff] = deriveChatChangeReviewDiffs(
            [activityDiff],
            [trackedFile],
            "/vault",
        );

        expect(diff?.old_text).toBe("before\nold snippet\nafter");
        expect(diff?.new_text).toBe("before\nnew snippet\nafter");
        expect(diff?.hunks).toEqual([
            {
                old_start: 2,
                old_count: 1,
                new_start: 2,
                new_count: 1,
                lines: [
                    { type: "remove", text: "old snippet" },
                    { type: "add", text: "new snippet" },
                ],
            },
        ]);
    });

    it("keeps the activity diff when tracked-file matching is ambiguous", () => {
        const activityDiff: AIFileDiff = {
            path: "/vault/posts/article.md",
            kind: "update",
            old_text: "old",
            new_text: "new",
        };
        const left = makeTrackedFile(
            "/vault/posts/article.md",
            "left old",
            "left new",
        );
        const right = makeTrackedFile(
            "/vault/posts/article.md",
            "right old",
            "right new",
        );
        right.identityKey = "/vault/posts/article-copy.md";

        const [diff] = deriveChatChangeReviewDiffs(
            [activityDiff],
            [left, right],
            "/vault",
        );

        expect(diff).toBe(activityDiff);
    });
});
