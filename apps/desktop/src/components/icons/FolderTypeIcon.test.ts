import { describe, expect, it } from "vitest";

import { hasSymbolsIcon } from "./symbols-icons";
import { resolveSymbolsFolderIcon } from "./folderTypeIcons";

describe("resolveSymbolsFolderIcon", () => {
    it.each([
        ["src", "folders/folder-orange-code.svg"],
        ["tests", "folders/folder-red-code.svg"],
        [".github", "folders/folder-github.svg"],
        ["assets", "folders/folder-assets.svg"],
        ["docs", "folders/folder-documents.svg"],
        ["scripts", "folders/folder-red-code.svg"],
        ["components", "folders/folder-green-code.svg"],
        ["types", "folders/folder-blue-code.svg"],
        ["node_modules", "folders/folder-node-modules.svg"],
        ["target", "folders/folder-target.svg"],
    ])("maps folder %s to %s", (folderName, iconPath) => {
        const resolved = resolveSymbolsFolderIcon(folderName, false);

        expect(resolved.iconPath).toBe(iconPath);
        expect(hasSymbolsIcon(resolved.iconPath)).toBe(true);
    });

    it("matches folder names case-insensitively and ignores parent paths", () => {
        expect(
            resolveSymbolsFolderIcon("project/SRC", false).iconPath,
        ).toBe("folders/folder-orange-code.svg");
    });

    it("uses the same artwork for open and closed folders like Zeron", () => {
        expect(resolveSymbolsFolderIcon("src", true).iconPath).toBe(
            resolveSymbolsFolderIcon("src", false).iconPath,
        );
    });

    it("uses the generic folder icon for unknown names", () => {
        expect(
            resolveSymbolsFolderIcon("feature-lab", false).iconPath,
        ).toBe("folders/folder.svg");
        expect(resolveSymbolsFolderIcon("feature-lab", true).iconPath).toBe(
            "folders/folder.svg",
        );
    });
});
