import { describe, expect, it } from "vitest";
import {
    buildVaultPathAliases,
    canonicalizeVaultScopedPath,
    isAbsoluteVaultPath,
    pathsMatchVaultScoped,
    resolveVaultAbsolutePath,
    toVaultRelativePath,
} from "./vaultPaths";

describe("vaultPaths", () => {
    it("treats Windows drive paths as absolute", () => {
        expect(isAbsoluteVaultPath("C:\\Vault\\Map.excalidraw")).toBe(true);
        expect(isAbsoluteVaultPath("C:/Vault/Map.excalidraw")).toBe(true);
    });

    it("preserves Windows absolute paths when resolving absolute paths", () => {
        expect(
            resolveVaultAbsolutePath(
                "C:\\Vault\\Excalidraw\\Architecture.excalidraw",
                "/vault",
            ),
        ).toBe("C:/Vault/Excalidraw/Architecture.excalidraw");
    });

    it("converts Windows absolute paths inside the vault to relative paths", () => {
        expect(
            toVaultRelativePath(
                "C:\\Vault\\Excalidraw\\Architecture.excalidraw",
                "C:\\Vault",
            ),
        ).toBe("Excalidraw/Architecture.excalidraw");
    });

    it("canonicalizes relative vault-scoped paths to absolute paths", () => {
        expect(canonicalizeVaultScopedPath("src/watcher.rs", "/vault")).toBe(
            "/vault/src/watcher.rs",
        );
    });

    it("preserves absolute external paths during canonicalization", () => {
        expect(canonicalizeVaultScopedPath("/tmp/watcher.rs", "/vault")).toBe(
            "/tmp/watcher.rs",
        );
    });

    it("builds aliases across relative and absolute vault paths", () => {
        expect(
            buildVaultPathAliases("/vault/src/watcher.rs", "/vault"),
        ).toEqual(["/vault/src/watcher.rs", "src/watcher.rs"]);
        expect(buildVaultPathAliases("src/watcher.rs", "/vault")).toEqual([
            "src/watcher.rs",
            "/vault/src/watcher.rs",
        ]);
    });

    it("adds legacy leading-slash aliases when requested", () => {
        expect(
            buildVaultPathAliases("/src/watcher.rs", "/vault", {
                includeLegacyLeadingSlashRelative: true,
            }),
        ).toEqual([
            "/src/watcher.rs",
            "src/watcher.rs",
            "/vault/src/watcher.rs",
        ]);
    });

    it("matches canonical and legacy vault-scoped path variants", () => {
        expect(
            pathsMatchVaultScoped(
                "/vault/src/watcher.rs",
                "src/watcher.rs",
                "/vault",
            ),
        ).toBe(true);
        expect(
            pathsMatchVaultScoped(
                "/vault/src/watcher.rs",
                "/src/watcher.rs",
                "/vault",
                {
                    includeLegacyLeadingSlashRelative: true,
                },
            ),
        ).toBe(true);
        expect(
            pathsMatchVaultScoped(
                "/vault/src/watcher.rs",
                "/tmp/watcher.rs",
                "/vault",
            ),
        ).toBe(false);
    });
});
