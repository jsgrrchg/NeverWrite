import { describe, expect, it } from "vitest";
import {
    buildVaultPreviewUrl,
    buildVaultPreviewUrlFromAbsolutePath,
    isAuthorizedVaultPreviewPath,
} from "./filePreviewUrl";

describe("filePreviewUrl", () => {
    it("builds a stable vault preview URL from a relative path", () => {
        expect(buildVaultPreviewUrl("/vault", "docs/spec.pdf")).toContain(
            "vaultai-file://localhost/vault/",
        );
    });

    it("builds a vault preview URL from an absolute vault path", () => {
        expect(
            buildVaultPreviewUrlFromAbsolutePath(
                "/vault/assets/image.png",
                "/vault",
            ),
        ).toContain("vaultai-file://localhost/vault/");
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
});
