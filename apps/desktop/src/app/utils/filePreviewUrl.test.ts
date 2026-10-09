import { describe, expect, it } from "vitest";
import {
    buildCodexGeneratedImagePreviewUrl,
    buildManagedAttachmentPreviewUrl,
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

    it("builds managed attachment previews without a physical path", () => {
        const url = buildManagedAttachmentPreviewUrl(
            "/vault",
            "ma_0123456789abcdef0123456789abcdef",
        );
        expect(url).toContain("neverwrite-file://localhost/ai-attachment/");
        expect(url).not.toContain("assets/chat");
    });

    it("preserves query suffixes for local vault previews", () => {
        expect(
            buildVaultPreviewUrlFromAbsolutePath(
                "/vault/assets/image.png?raw=1",
                "/vault",
            ),
        )?.toContain("?raw=1");
    });

    it.each([
        String.raw`\\?\C:\Users\José\OneDrive\My Vault`,
        "//?/C:/Users/José/OneDrive/My Vault",
        String.raw`\\?\UNC\server\share\My Vault`,
        "//?/UNC/server/share/My Vault",
    ])("preserves the Windows namespace in %s", (vaultPath) => {
        const separator = vaultPath.includes("\\") ? "\\" : "/";
        const filePath = `${vaultPath}${separator}docs${separator}Asymptoter.pdf`;
        const expected = buildVaultPreviewUrl(vaultPath, "docs/Asymptoter.pdf");

        expect(buildVaultPreviewUrlFromAbsolutePath(filePath, vaultPath)).toBe(
            expected,
        );
        expect(
            buildVaultPreviewUrlFromAbsolutePath(
                `${filePath}?raw=1#page=2`,
                vaultPath,
            ),
        ).toBe(`${expected}?raw=1#page=2`);
        expect(
            buildVaultPreviewUrlFromAbsolutePath(`${filePath}#page=2`, vaultPath),
        ).toBe(`${expected}#page=2`);
        expect(isAuthorizedVaultPreviewPath(filePath, vaultPath)).toBe(filePath);
        expect(
            isAuthorizedVaultPreviewPath(`${filePath}?raw=1`, vaultPath),
        ).toBe(filePath);

        const outsidePath = `${vaultPath}-other${separator}Asymptoter.pdf`;
        expect(
            buildVaultPreviewUrlFromAbsolutePath(outsidePath, vaultPath),
        ).toBeNull();
        expect(isAuthorizedVaultPreviewPath(outsidePath, vaultPath)).toBeNull();
    });

    it("preserves Windows namespaces in generated image previews", () => {
        const imagePath = String.raw`\\?\C:\Users\José\.codex\generated_images\image.png`;
        const preview = buildCodexGeneratedImagePreviewUrl(`${imagePath}#preview`)!;
        const url = new URL(preview);
        const encodedPath = url.pathname.split("/").at(-1)!;

        expect(Buffer.from(encodedPath, "base64url").toString("utf8")).toBe(
            imagePath,
        );
        expect(url.search).toBe("");
        expect(url.hash).toBe("#preview");
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
