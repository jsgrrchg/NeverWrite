import { describe, expect, it } from "vitest";
import type { TrackedFile } from "../diff/actionLogTypes";
import { emptyPatch, buildPatchFromTexts } from "../store/actionLogModel";
import {
    canResolveFileHunks,
    deriveReviewItems,
} from "./editedFilesPresentationModel";

function makeFile(overrides: Partial<TrackedFile> = {}): TrackedFile {
    const diffBase = overrides.diffBase ?? "old";
    const currentText = overrides.currentText ?? "new";
    return {
        identityKey: "/vault/test.md",
        originPath: "/vault/test.md",
        path: "/vault/test.md",
        previousPath: null,
        status: { kind: "modified" },
        diffBase,
        currentText,
        unreviewedEdits:
            diffBase === currentText
                ? emptyPatch()
                : buildPatchFromTexts(diffBase, currentText),
        version: 1,
        isText: true,
        updatedAt: 1,
        ...overrides,
    };
}

describe("editedFilesPresentationModel", () => {
    it("marks update files with both snapshots as hunk-resolvable", () => {
        expect(canResolveFileHunks(makeFile())).toBe(true);
    });

    it("marks move files with content changes as hunk-resolvable", () => {
        expect(
            canResolveFileHunks(
                makeFile({
                    originPath: "/vault/old.md",
                    path: "/vault/new.md",
                }),
            ),
        ).toBe(true);
    });

    it("does not mark pure moves without content changes as hunk-resolvable", () => {
        expect(
            canResolveFileHunks(
                makeFile({
                    originPath: "/vault/old.md",
                    path: "/vault/new.md",
                    diffBase: "same",
                    currentText: "same",
                }),
            ),
        ).toBe(false);
    });

    it("does not allow per-hunk resolution for add, delete, partial or conflict files", () => {
        expect(
            canResolveFileHunks(
                makeFile({
                    status: { kind: "created", existingFileContent: null },
                }),
            ),
        ).toBe(false);
        expect(
            canResolveFileHunks(
                makeFile({
                    status: { kind: "deleted" },
                }),
            ),
        ).toBe(false);
        expect(
            canResolveFileHunks(
                makeFile({
                    isText: false,
                }),
            ),
        ).toBe(false);
        expect(
            canResolveFileHunks(
                makeFile({
                    conflictHash: "abc",
                }),
            ),
        ).toBe(false);
    });

    it("allows per-hunk resolution for large files (unreviewedEdits always provides exact hunks)", () => {
        const diffBase = Array.from(
            { length: 900 },
            (_, index) => `old-${index}`,
        ).join("\n");
        const currentText = Array.from({ length: 900 }, (_, index) =>
            index === 350 ? "changed-350" : `old-${index}`,
        ).join("\n");

        expect(
            canResolveFileHunks(
                makeFile({
                    diffBase,
                    currentText,
                }),
            ),
        ).toBe(true);
    });

    it("adds canResolveHunks to derived review items", () => {
        const items = deriveReviewItems(
            [
                makeFile(),
                makeFile({
                    identityKey: "/vault/add.md",
                    path: "/vault/add.md",
                    originPath: "/vault/add.md",
                    status: { kind: "created", existingFileContent: null },
                }),
            ],
            new Set<string>(),
        );

        expect(items[0]?.canResolveHunks).toBe(true);
        expect(items[1]?.canResolveHunks).toBe(false);
    });
});
