import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
type GrammarDecorationRange = {
    from: number;
    to: number;
};

const grammarMark = Decoration.mark({ class: "cm-grammar-error" });

export function buildGrammarDecorations(
    diagnostics: GrammarDecorationRange[],
): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();

    for (const diagnostic of diagnostics) {
        if (diagnostic.from >= diagnostic.to) {
            continue;
        }

        builder.add(diagnostic.from, diagnostic.to, grammarMark);
    }

    return builder.finish();
}

export const grammarDecorationsTheme = EditorView.baseTheme({
    ".cm-grammar-error": {
        textDecorationLine: "underline",
        textDecorationStyle: "wavy",
        textDecorationThickness: "1.5px",
        textUnderlineOffset: "3px",
        textDecorationColor:
            "color-mix(in srgb, var(--accent) 70%, transparent)",
    },
    // When both spellcheck and grammar underline the same text,
    // suppress the spellcheck underline so only the grammar one shows.
    ".cm-grammar-error .cm-spellcheck-error, .cm-spellcheck-error .cm-grammar-error":
        {
            textDecorationLine: "none",
        },
    ".cm-grammar-error.cm-spellcheck-error": {
        textDecorationLine: "underline",
        textDecorationStyle: "wavy",
        textDecorationColor:
            "color-mix(in srgb, var(--accent) 70%, transparent)",
    },
});
