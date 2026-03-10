import { describe, expect, it } from "vitest";
import { resolvePreviewAssetPath } from "./livePreviewBlocks";

describe("resolvePreviewAssetPath", () => {
    it("resolves note-relative assets against the current note path", () => {
        expect(
            resolvePreviewAssetPath(
                "./assets/cover.png",
                "/vault",
                "/vault/notes/daily/today.md",
            ),
        ).toBe("/vault/notes/daily/assets/cover.png");
    });

    it("supports parent-directory traversal from the current note", () => {
        expect(
            resolvePreviewAssetPath(
                "../shared/diagram.png",
                "/vault",
                "/vault/notes/daily/today.md",
            ),
        ).toBe("/vault/notes/shared/diagram.png");
    });

    it("keeps vault-root-relative assets anchored to the vault root", () => {
        expect(
            resolvePreviewAssetPath(
                "/attachments/diagram.png",
                "/vault",
                "/vault/notes/daily/today.md",
            ),
        ).toBe("/vault/attachments/diagram.png");
    });
});
