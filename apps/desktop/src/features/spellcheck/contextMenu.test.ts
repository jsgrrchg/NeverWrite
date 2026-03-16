import { describe, expect, it, vi } from "vitest";
import { buildSpellcheckContextMenuEntries } from "./contextMenu";

describe("spellcheck context menu", () => {
    it("keeps the clear secondary language action visible without candidates", () => {
        const setSecondaryLanguage = vi.fn();

        const entries = buildSpellcheckContextMenuEntries({
            payload: {
                hasSelection: false,
                spellingWord: null,
                spellingCorrect: null,
                wordRange: null,
                spellingSuggestions: [],
                secondaryLanguage: "en-US",
                secondaryLanguageCandidates: [],
            },
            applySuggestion: vi.fn(),
            addToDictionary: vi.fn(),
            ignoreForSession: vi.fn(),
            setSecondaryLanguage,
            trailingEntries: [],
        });

        const clearEntry = entries.find(
            (entry) =>
                "label" in entry &&
                entry.label === "Clear Secondary Language",
        );

        expect(clearEntry).toBeDefined();
        if (clearEntry && "action" in clearEntry) {
            clearEntry.action?.();
        }
        expect(setSecondaryLanguage).toHaveBeenCalledWith(null);
    });
});
