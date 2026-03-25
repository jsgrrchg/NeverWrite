import { describe, expect, it } from "vitest";
import {
    mergeRecentValues,
    normalizeFolderHint,
    parseFolderHintsInput,
    parseTagInput,
    recordClipperUsage,
} from "./clipper-preferences";
import { createDefaultClipperSettings } from "./storage";

describe("clipper preferences helpers", () => {
    it("normalizes folder hints to vault-relative paths", () => {
        expect(normalizeFolderHint(" /Clips\\\\Web//Inbox/ ")).toBe(
            "Clips/Web/Inbox",
        );
    });

    it("parses tags from comma and newline separated input", () => {
        expect(parseTagInput("research, Article\nresearch, web")).toEqual([
            "research",
            "Article",
            "web",
        ]);
    });

    it("parses folder hints from multi-line input", () => {
        expect(
            parseFolderHintsInput("Clips/Web\n\n/Clips/Research/\nClips/Web"),
        ).toEqual(["Clips/Web", "Clips/Research"]);
    });

    it("merges recents with newest values first", () => {
        expect(
            mergeRecentValues(["web", "todo"], ["research", "Web"], 4),
        ).toEqual(["research", "Web", "todo"]);
    });

    it("records folder and tag usage back into settings", () => {
        const settings = createDefaultClipperSettings();
        const nextSettings = recordClipperUsage(settings, {
            vaultId: settings.vaults[0].id,
            folder: "/Clips/Web/",
            tags: ["research", "web"],
        });

        expect(nextSettings.vaults[0].defaultFolder).toBe("Clips/Web");
        expect(nextSettings.vaults[0].folderHints).toContain("Clips/Web");
        expect(nextSettings.recentFoldersByVault[settings.vaults[0].id]).toEqual([
            "Clips/Web",
        ]);
        expect(nextSettings.recentTags).toEqual(["research", "web"]);
    });
});
