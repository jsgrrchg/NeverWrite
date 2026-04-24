import { describe, expect, it } from "vitest";

import { hasCatppuccinIcon } from "./catppuccin-icons";
import { resolveCatppuccinFolderIcon } from "./folderTypeIcons";

describe("resolveCatppuccinFolderIcon", () => {
    it.each([
        ["src", false, "folder-src"],
        ["src", true, "folder-src-open"],
        ["tests", false, "folder-tests"],
        ["__tests__", true, "folder-tests-open"],
        [".github", false, "folder-github"],
        [".github", true, "folder-github-open"],
        [".PERSONAL", false, "folder-private"],
        [".PERSONAL", true, "folder-private-open"],
        ["assets", false, "folder-assets"],
        ["Excalidraw", true, "folder-images-open"],
        ["docs", true, "folder-docs-open"],
        ["scripts", false, "folder-scripts"],
        ["components", true, "folder-components-open"],
        ["types", false, "folder-types"],
        ["typings", true, "folder-types-open"],
        ["vendor", false, "folder-packages"],
        ["crates", true, "folder-packages-open"],
    ])("maps folder %s open=%s to %s", (folderName, open, iconName) => {
        const resolved = resolveCatppuccinFolderIcon(folderName, open);

        expect(resolved.iconName).toBe(iconName);
        expect(hasCatppuccinIcon(resolved.iconName)).toBe(true);
    });

    it("uses default folder icons for unknown folder names", () => {
        expect(resolveCatppuccinFolderIcon("feature-lab", false).iconName).toBe(
            "folder",
        );
        expect(resolveCatppuccinFolderIcon("feature-lab", true).iconName).toBe(
            "folder-open",
        );
    });
});
