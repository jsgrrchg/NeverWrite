import { describe, expect, it } from "vitest";
import {
    isAbsoluteVaultPath,
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
});
