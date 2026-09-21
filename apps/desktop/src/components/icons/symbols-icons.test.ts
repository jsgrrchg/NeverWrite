import { describe, expect, it } from "vitest";

import symbolsManifestJson from "../../assets/file-icons/file-icons.json";
import { getSymbolsIconSvg, hasSymbolsIcon } from "./symbols-icons";

describe("Symbols icon assets", () => {
    it("bundles file and folder SVGs", () => {
        expect(hasSymbolsIcon("files/rust.svg")).toBe(true);
        expect(hasSymbolsIcon("folders/folder.svg")).toBe(true);
        expect(hasSymbolsIcon("files/missing.svg")).toBe(false);
    });

    it("makes Zeron's dark-palette accents theme-aware", () => {
        const svg = getSymbolsIconSvg("files/rust.svg");

        expect(svg).toContain("var(--symbols-icon-orange, #EA580C)");
    });

    it("bundles every SVG referenced by the upstream manifest", () => {
        const missingAssets = Object.values(
            symbolsManifestJson.iconDefinitions,
        )
            .map(({ iconPath }) => iconPath.replace(/^\.\/icons\//, ""))
            .filter((iconPath) => !hasSymbolsIcon(iconPath));

        expect(missingAssets).toEqual([]);
    });

    it("namespaces gradient and mask IDs between different inline icons", () => {
        const svg = getSymbolsIconSvg("files/angular.svg");

        expect(svg).not.toMatch(/\bid=["'](paint|clip|mask)/);
    });
});
