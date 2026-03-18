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
                grammarDiagnostics: [],
            },
            applySuggestion: vi.fn(),
            addToDictionary: vi.fn(),
            ignoreForSession: vi.fn(),
            setSecondaryLanguage,
            spellcheckAction: null,
            trailingEntries: [],
        });

        const clearEntry = entries.find(
            (entry) =>
                "label" in entry && entry.label === "Clear Secondary Language",
        );

        expect(clearEntry).toBeDefined();
        if (clearEntry && "action" in clearEntry) {
            clearEntry.action?.();
        }
        expect(setSecondaryLanguage).toHaveBeenCalledWith(null);
    });

    it("inserts the optional spellcheck action before trailing entries", () => {
        const disableSpellcheck = vi.fn();

        const entries = buildSpellcheckContextMenuEntries({
            payload: null,
            applySuggestion: vi.fn(),
            addToDictionary: vi.fn(),
            ignoreForSession: vi.fn(),
            setSecondaryLanguage: vi.fn(),
            spellcheckAction: {
                label: "Disable Spellcheck",
                action: disableSpellcheck,
            },
            trailingEntries: [{ label: "Undo", action: vi.fn() }],
        });

        expect(entries).toEqual([
            { label: "Disable Spellcheck", action: disableSpellcheck },
            { type: "separator" },
            expect.objectContaining({ label: "Undo" }),
        ]);
    });

    it("renders multiple grammar diagnostics and de-duplicates repeated suggestions", () => {
        const applySuggestion = vi.fn();

        const entries = buildSpellcheckContextMenuEntries({
            payload: {
                hasSelection: false,
                spellingWord: "teh",
                spellingCorrect: false,
                wordRange: { from: 0, to: 3 },
                spellingSuggestions: ["the"],
                secondaryLanguage: null,
                secondaryLanguageCandidates: [],
                grammarDiagnostics: [
                    {
                        message: "Possible typo",
                        replacements: ["the"],
                        range: { from: 0, to: 3 },
                    },
                    {
                        message: "Article agreement",
                        replacements: ["the", "a"],
                        range: { from: 0, to: 3 },
                    },
                ],
            },
            applySuggestion,
            addToDictionary: vi.fn(),
            ignoreForSession: vi.fn(),
            setSecondaryLanguage: vi.fn(),
            spellcheckAction: null,
            trailingEntries: [],
        });

        expect(entries).toContainEqual(
            expect.objectContaining({
                label: "Possible typo",
                disabled: true,
            }),
        );
        expect(entries).toContainEqual(
            expect.objectContaining({
                label: "Article agreement",
                disabled: true,
            }),
        );
        expect(
            entries.filter(
                (entry) => "label" in entry && entry.label === "the",
            ),
        ).toHaveLength(1);
        expect(
            entries.some(
                (entry) =>
                    "label" in entry && entry.label === "Add to Dictionary",
            ),
        ).toBe(false);
    });
});
