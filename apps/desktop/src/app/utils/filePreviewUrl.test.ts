import { describe, expect, it } from "vitest";
import {
    buildCodexGeneratedImagePreviewUrl,
    buildVaultPreviewUrl,
    buildVaultPreviewUrlFromAbsolutePath,
    isGeneratedImagePath,
    isAuthorizedVaultPreviewPath,
} from "./filePreviewUrl";

describe("filePreviewUrl", () => {
    it("builds a stable vault preview URL from a relative path", () => {
        expect(buildVaultPreviewUrl("/vault", "docs/spec.pdf")).toContain(
            "neverwrite-file://localhost/vault/",
        );
    });

    it("builds a vault preview URL from an absolute vault path", () => {
        expect(
            buildVaultPreviewUrlFromAbsolutePath(
                "/vault/assets/image.png",
                "/vault",
            ),
        ).toContain("neverwrite-file://localhost/vault/");
    });

    it("preserves query suffixes for local vault previews", () => {
        expect(
            buildVaultPreviewUrlFromAbsolutePath(
                "/vault/assets/image.png?raw=1",
                "/vault",
            ),
        )?.toContain("?raw=1");
    });

    it("rejects absolute paths outside the active vault", () => {
        expect(
            buildVaultPreviewUrlFromAbsolutePath(
                "/outside/assets/image.png",
                "/vault",
            ),
        ).toBeNull();
        expect(
            isAuthorizedVaultPreviewPath("/outside/assets/image.png", "/vault"),
        ).toBeNull();
    });

    it("builds a generated image preview URL outside the vault scope", () => {
        expect(
            buildCodexGeneratedImagePreviewUrl(
                "/Users/test/.codex/generated_images/session/ig_1.png",
            ),
        ).toContain("neverwrite-file://localhost/codex-image/");
    });

    it("detects Codex generated image paths", () => {
        expect(
            isGeneratedImagePath(
                "/Users/test/.codex/generated_images/session/ig_1.png",
            ),
        ).toBe(true);
        expect(isGeneratedImagePath("/Users/test/Pictures/ig_1.png")).toBe(
            false,
        );
    });
});
