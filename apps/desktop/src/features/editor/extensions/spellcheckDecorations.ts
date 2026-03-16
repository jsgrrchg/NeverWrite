import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import type { SpellcheckDiagnostic } from "../../spellcheck/types";

type ExcludedRange = {
    from: number;
    to: number;
};

const spellcheckMark = Decoration.mark({ class: "cm-spellcheck-error" });

function overlapsExcludedRange(
    from: number,
    to: number,
    excludedRanges: ExcludedRange[],
) {
    return excludedRanges.some(
        (range) => to > range.from && from < range.to,
    );
}

export function buildSpellcheckDecorations(
    diagnostics: SpellcheckDiagnostic[],
    chunkFrom: number,
    chunkTo: number,
    excludedRanges: ExcludedRange[],
): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();

    for (const diagnostic of diagnostics) {
        const from = chunkFrom + diagnostic.start_utf16;
        const to = chunkFrom + diagnostic.end_utf16;

        if (from >= to || from < chunkFrom || to > chunkTo) {
            continue;
        }

        if (overlapsExcludedRange(from, to, excludedRanges)) {
            continue;
        }

        builder.add(from, to, spellcheckMark);
    }

    return builder.finish();
}

export const spellcheckDecorationsTheme = EditorView.baseTheme({
    ".cm-spellcheck-error": {
        textDecorationLine: "underline",
        textDecorationStyle: "wavy",
        textDecorationThickness: "1.5px",
        textUnderlineOffset: "3px",
        textDecorationColor:
            "color-mix(in srgb, var(--diff-remove) 88%, transparent)",
    },
});
