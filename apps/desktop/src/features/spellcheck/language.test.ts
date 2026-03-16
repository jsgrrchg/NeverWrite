import { describe, expect, it } from "vitest";
import {
    buildSpellcheckLanguageDescription,
    buildSpellcheckSecondaryLanguageDescription,
    buildSpellcheckLanguageSelectOptions,
    buildSpellcheckLanguagesSummary,
    getSpellcheckLanguageStatusLabel,
} from "./language";
import type { SpellcheckLanguageInfo } from "./types";

const LANGUAGES: SpellcheckLanguageInfo[] = [
    {
        id: "en-US",
        label: "English (US)",
        available: true,
        source: "bundled-pack",
        dictionary_path: null,
        user_dictionary_path: "/tmp/spellcheck/user/en-US.txt",
        aff_path: null,
        dic_path: null,
        version: "2026.03.15",
        size_bytes: 570801,
        license: "LGPL-2.1+ wordlist; BSD-style affix file",
        homepage: "http://wordlist.sourceforge.net",
    },
    {
        id: "fr-FR",
        label: "fr-FR",
        available: true,
        source: "installed-pack",
        dictionary_path: "/tmp/spellcheck/packs/fr-FR",
        user_dictionary_path: "/tmp/spellcheck/user/fr-FR.txt",
        aff_path: "/tmp/spellcheck/packs/fr-FR/dictionary.aff",
        dic_path: "/tmp/spellcheck/packs/fr-FR/dictionary.dic",
        version: null,
        size_bytes: null,
        license: null,
        homepage: null,
    },
];

describe("spellcheck language helpers", () => {
    it("builds select options from backend-provided languages", () => {
        const options = buildSpellcheckLanguageSelectOptions(
            "fr-FR",
            LANGUAGES,
        );

        expect(options[0]?.value).toBe("system");
        expect(options.some((option) => option.label.includes("Bundled"))).toBe(
            true,
        );
        expect(
            options.some((option) => option.label.includes("Installed")),
        ).toBe(true);
    });

    it("keeps a selected custom language visible when it is not installed", () => {
        const options = buildSpellcheckLanguageSelectOptions("pt-BR", []);

        expect(options.at(-1)).toEqual({
            value: "pt-BR",
            label: "pt-BR · Not installed",
        });
    });

    it("describes unavailable custom languages with their install path", () => {
        expect(
            buildSpellcheckLanguageDescription("pt-BR", [], "/tmp/spellcheck"),
        ).toContain("Runtime will fall back to System");
    });

    it("describes unavailable secondary languages as ignored at runtime", () => {
        expect(
            buildSpellcheckSecondaryLanguageDescription(
                "pt-BR",
                [],
                "/tmp/spellcheck",
            ),
        ).toContain("Runtime will ignore the secondary dictionary");
    });

    it("summarizes built-in and installed dictionaries", () => {
        expect(buildSpellcheckLanguagesSummary(LANGUAGES)).toBe(
            "1 installed · 1 bundled (557 KB)",
        );
    });

    it("maps backend sources to readable status labels", () => {
        expect(getSpellcheckLanguageStatusLabel(LANGUAGES[0]!)).toBe("Bundled");
        expect(getSpellcheckLanguageStatusLabel(LANGUAGES[1]!)).toBe(
            "Installed",
        );
    });
});
