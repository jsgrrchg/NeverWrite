import {
    Decoration,
    EditorView,
    ViewPlugin,
    type DecorationSet,
    type ViewUpdate,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { useSpellcheckStore } from "../../spellcheck/store";
import type {
    SpellcheckLanguage,
    SpellcheckSecondaryLanguage,
} from "../../../app/store/settingsStore";
import {
    buildSpellcheckDecorations,
    spellcheckDecorationsTheme,
} from "./spellcheckDecorations";

const VIEWPORT_MARGIN_LINES = 8;
const SPELLCHECK_DEBOUNCE_MS = 180;
const EXCLUDED_NODE_NAMES = new Set([
    "Autolink",
    "CodeInfo",
    "CodeMark",
    "CodeText",
    "FencedCode",
    "HTMLBlock",
    "HTMLTag",
    "Image",
    "InlineCode",
    "LinkReference",
    "ProcessingInstruction",
    "URL",
]);

type SpellcheckViewportChunk = {
    id: string;
    from: number;
    to: number;
    version: string;
    text: string;
};

function shouldExcludeNode(name: string) {
    return EXCLUDED_NODE_NAMES.has(name) || name.endsWith("Code");
}

function hashText(text: string) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
}

function getViewportChunk(view: EditorView, noteId: string) {
    const firstVisible = view.visibleRanges[0] ?? { from: 0, to: 0 };
    const lastVisible =
        view.visibleRanges[view.visibleRanges.length - 1] ?? firstVisible;
    const firstLine = view.state.doc.lineAt(firstVisible.from).number;
    const lastLine = view.state.doc.lineAt(lastVisible.to).number;
    const fromLine = Math.max(1, firstLine - VIEWPORT_MARGIN_LINES);
    const toLine = Math.min(
        view.state.doc.lines,
        lastLine + VIEWPORT_MARGIN_LINES,
    );
    const from = view.state.doc.line(fromLine).from;
    const to = view.state.doc.line(toLine).to;
    const text = view.state.sliceDoc(from, to);

    return {
        id: `${noteId}:${from}-${to}`,
        from,
        to,
        version: `${from}:${to}:${hashText(text)}`,
        text,
    } satisfies SpellcheckViewportChunk;
}

function collectExcludedRanges(view: EditorView, from: number, to: number) {
    const ranges: Array<{ from: number; to: number }> = [];

    syntaxTree(view.state).iterate({
        from,
        to,
        enter(node) {
            if (!shouldExcludeNode(node.name)) {
                return;
            }

            ranges.push({ from: node.from, to: node.to });
        },
    });

    return ranges;
}

type SpellcheckExtensionOptions = {
    enabled: boolean;
    noteId: string | null | undefined;
    primaryLanguage: SpellcheckLanguage;
    secondaryLanguage: SpellcheckSecondaryLanguage;
};

export function getSpellcheckEditorExtension({
    enabled,
    noteId,
    primaryLanguage,
    secondaryLanguage,
}: SpellcheckExtensionOptions) {
    if (!enabled || typeof noteId !== "string" || noteId.length === 0) {
        return [];
    }
    const activeNoteId = noteId;

    const plugin = ViewPlugin.fromClass(
        class {
            decorations: DecorationSet = Decoration.none;
            private view: EditorView;
            private debounceTimer: ReturnType<typeof setTimeout> | null = null;
            private requestId = 0;
            private destroyed = false;

            constructor(view: EditorView) {
                this.view = view;
                this.scheduleRefresh();
            }

            update(update: ViewUpdate) {
                if (update.docChanged || update.viewportChanged) {
                    this.scheduleRefresh();
                }
            }

            destroy() {
                this.destroyed = true;
                this.requestId += 1;
                if (this.debounceTimer) {
                    clearTimeout(this.debounceTimer);
                    this.debounceTimer = null;
                }
            }

            private scheduleRefresh() {
                if (this.debounceTimer) {
                    clearTimeout(this.debounceTimer);
                }

                this.debounceTimer = setTimeout(() => {
                    this.debounceTimer = null;
                    void this.refresh();
                }, SPELLCHECK_DEBOUNCE_MS);
            }

            private async refresh() {
                const chunk = getViewportChunk(this.view, activeNoteId);
                const currentRequestId = ++this.requestId;

                if (!chunk.text.trim()) {
                    this.decorations = Decoration.none;
                    this.view.dispatch({});
                    return;
                }

                try {
                    const result = await useSpellcheckStore
                        .getState()
                        .checkDocument({
                            documentId: chunk.id,
                            version: chunk.version,
                            text: chunk.text,
                            language: primaryLanguage,
                            secondaryLanguage,
                        });

                    if (this.destroyed || currentRequestId !== this.requestId) {
                        return;
                    }

                    this.decorations = buildSpellcheckDecorations(
                        result.diagnostics,
                        chunk.from,
                        chunk.to,
                        collectExcludedRanges(this.view, chunk.from, chunk.to),
                    );
                    this.view.dispatch({});
                } catch {
                    if (this.destroyed || currentRequestId !== this.requestId) {
                        return;
                    }

                    this.decorations = Decoration.none;
                    this.view.dispatch({});
                }
            }
        },
        {
            decorations: (plugin) => plugin.decorations,
        },
    );

    return [plugin, spellcheckDecorationsTheme];
}
