import type { ContextMenuEntry } from "../../components/context-menu/ContextMenu";

export type SpellcheckWordRange = {
    from: number;
    to: number;
};

export type SpellcheckGrammarContextDiagnostic = {
    message: string;
    replacements: string[];
    range: SpellcheckWordRange;
};

export type SpellcheckContextMenuPayload = {
    hasSelection: boolean;
    spellingWord: string | null;
    spellingCorrect: boolean | null;
    wordRange: SpellcheckWordRange | null;
    spellingSuggestions: string[];
    secondaryLanguage: string | null;
    secondaryLanguageCandidates: Array<{
        id: string;
        label: string;
    }>;
    grammarDiagnostics: SpellcheckGrammarContextDiagnostic[];
};

type BuildSpellcheckContextMenuEntriesOptions = {
    payload: SpellcheckContextMenuPayload | null | undefined;
    applySuggestion: (suggestion: string, range: SpellcheckWordRange) => void;
    addToDictionary: (word: string) => void;
    ignoreForSession: (word: string) => void;
    setSecondaryLanguage: (language: string | null) => void;
    spellcheckAction?: ContextMenuEntry | null;
    trailingEntries: ContextMenuEntry[];
};

export function buildSpellcheckContextMenuEntries({
    payload,
    applySuggestion,
    addToDictionary,
    ignoreForSession,
    setSecondaryLanguage,
    spellcheckAction,
    trailingEntries,
}: BuildSpellcheckContextMenuEntriesOptions): ContextMenuEntry[] {
    const grammarDiagnostics = payload?.grammarDiagnostics ?? [];

    // Grammar suggestions (higher priority — shown first)
    const grammarEntries: ContextMenuEntry[] = [];
    if (grammarDiagnostics.length > 0) {
        const seenSuggestions = new Set<string>();

        for (const diagnostic of grammarDiagnostics) {
            grammarEntries.push({
                label: diagnostic.message,
                action: () => {},
                disabled: true,
            });

            for (const replacement of diagnostic.replacements) {
                const suggestionKey = [
                    diagnostic.range.from,
                    diagnostic.range.to,
                    replacement,
                ].join(":");
                if (seenSuggestions.has(suggestionKey)) {
                    continue;
                }
                seenSuggestions.add(suggestionKey);
                grammarEntries.push({
                    label: replacement,
                    action: () =>
                        applySuggestion(replacement, diagnostic.range),
                });
            }

            grammarEntries.push({ type: "separator" as const });
        }

        if (grammarEntries.at(-1)?.type === "separator") {
            grammarEntries.pop();
        }
        if (grammarEntries.length > 0) {
            grammarEntries.push({ type: "separator" as const });
        }
    }

    // Spelling suggestions (skip if grammar already covers the same range)
    const hasGrammarAtSameRange =
        payload?.wordRange &&
        grammarDiagnostics.some(
            (diagnostic) =>
                diagnostic.range.from === payload.wordRange!.from &&
                diagnostic.range.to === payload.wordRange!.to,
        );

    const suggestionEntries =
        !hasGrammarAtSameRange &&
        payload &&
        payload.spellingCorrect === false &&
        payload.wordRange &&
        payload.spellingSuggestions.length > 0
            ? [
                  ...payload.spellingSuggestions.map((suggestion) => ({
                      label: suggestion,
                      action: () =>
                          applySuggestion(suggestion, payload.wordRange!),
                  })),
                  { type: "separator" as const },
              ]
            : [];

    const dictionaryEntries =
        !hasGrammarAtSameRange &&
        payload &&
        payload.spellingCorrect === false &&
        payload.spellingWord
            ? [
                  {
                      label: "Add to Dictionary",
                      action: () => addToDictionary(payload.spellingWord!),
                  },
                  {
                      label: "Ignore for Session",
                      action: () => ignoreForSession(payload.spellingWord!),
                  },
                  { type: "separator" as const },
              ]
            : [];

    const secondaryLanguageEntries =
        payload &&
        (payload.secondaryLanguageCandidates.length > 0 ||
            payload.secondaryLanguage)
            ? [
                  ...payload.secondaryLanguageCandidates.map((language) => ({
                      label:
                          payload.secondaryLanguage === language.id
                              ? `Secondary: ${language.label}`
                              : `Use ${language.label} as Secondary`,
                      action: () => setSecondaryLanguage(language.id),
                      disabled: payload.secondaryLanguage === language.id,
                  })),
                  ...(payload.secondaryLanguage
                      ? [
                            {
                                label: "Clear Secondary Language",
                                action: () => setSecondaryLanguage(null),
                            } as const,
                        ]
                      : []),
                  { type: "separator" as const },
              ]
            : [];
    const actionEntries = spellcheckAction
        ? [
              spellcheckAction,
              ...(trailingEntries.length > 0
                  ? [{ type: "separator" as const }]
                  : []),
          ]
        : [];

    return [
        ...grammarEntries,
        ...suggestionEntries,
        ...dictionaryEntries,
        ...secondaryLanguageEntries,
        ...actionEntries,
        ...trailingEntries,
    ];
}

export function findTextInputWordRange(
    value: string,
    selectionStart: number,
    selectionEnd: number,
): SpellcheckWordRange | null {
    if (selectionStart !== selectionEnd) {
        return selectionEnd > selectionStart
            ? { from: selectionStart, to: selectionEnd }
            : null;
    }

    const length = value.length;
    let from = Math.max(0, Math.min(selectionStart, length));
    let to = from;

    while (from > 0 && /[\p{L}\p{M}'’-]/u.test(value[from - 1] ?? "")) {
        from -= 1;
    }

    while (to < length && /[\p{L}\p{M}'’-]/u.test(value[to] ?? "")) {
        to += 1;
    }

    return to > from ? { from, to } : null;
}

export function isSpellcheckCandidate(text: string) {
    return /^[\p{L}\p{M}'’-]+$/u.test(text.trim());
}

export function shouldAllowNativeContextMenu(target: EventTarget | null) {
    const element =
        target instanceof Element
            ? target
            : target instanceof Node
              ? target.parentElement
              : null;

    if (!element) {
        return false;
    }

    return !!element.closest(
        ["input", "textarea", '[contenteditable="true"]', ".cm-content"].join(
            ", ",
        ),
    );
}
