import {
    Decoration,
    EditorView,
    ViewPlugin,
    hoverTooltip,
    type DecorationSet,
    type Tooltip,
    type ViewUpdate,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import {
    resolveFrontendSpellcheckLanguage,
    spellcheckCheckGrammar,
} from "../../spellcheck/api";
import type { SpellcheckLanguage } from "../../../app/store/settingsStore";
import type { GrammarDiagnostic } from "../../spellcheck/types";
import {
    buildGrammarDecorations,
    grammarDecorationsTheme,
} from "./grammarDecorations";

const GRAMMAR_DEBOUNCE_MS = 2000;
const MAX_GRAMMAR_CHUNK_LENGTH = 4000;
const CHUNK_BREAK_SEARCH_FRACTION = 0.55;
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

type ExcludedRange = {
    from: number;
    to: number;
};

type GrammarDocumentChunk = {
    from: number;
    to: number;
    text: string;
};

type GrammarDocumentSnapshot = {
    version: string;
    chunks: GrammarDocumentChunk[];
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

function normalizeGrammarServerUrl(serverUrl: string) {
    const trimmed = serverUrl.trim();
    return trimmed || "__default__";
}

export function buildGrammarCacheKey(
    noteId: string,
    documentVersion: string,
    primaryLanguage: SpellcheckLanguage,
    serverUrl: string,
) {
    return [
        "grammar",
        noteId,
        resolveFrontendSpellcheckLanguage(primaryLanguage),
        normalizeGrammarServerUrl(serverUrl),
        documentVersion,
    ].join(":");
}

function mergeExcludedRanges(ranges: ExcludedRange[]) {
    if (ranges.length <= 1) {
        return ranges;
    }

    const sorted = [...ranges].sort((left, right) => left.from - right.from);
    const merged: ExcludedRange[] = [sorted[0]!];

    for (const range of sorted.slice(1)) {
        const current = merged[merged.length - 1]!;
        if (range.from <= current.to) {
            current.to = Math.max(current.to, range.to);
            continue;
        }
        merged.push({ ...range });
    }

    return merged;
}

function collectExcludedRanges(view: EditorView) {
    const ranges: ExcludedRange[] = [];

    syntaxTree(view.state).iterate({
        from: 0,
        to: view.state.doc.length,
        enter(node) {
            if (!shouldExcludeNode(node.name)) {
                return;
            }

            ranges.push({ from: node.from, to: node.to });
        },
    });

    return mergeExcludedRanges(ranges);
}

function maskExcludedText(text: string, excludedRanges: ExcludedRange[]) {
    if (excludedRanges.length === 0) {
        return text;
    }

    let cursor = 0;
    let masked = "";

    for (const range of excludedRanges) {
        if (range.from > cursor) {
            masked += text.slice(cursor, range.from);
        }

        masked += text
            .slice(range.from, range.to)
            .replace(/[^\n\r]/g, " ");
        cursor = range.to;
    }

    if (cursor < text.length) {
        masked += text.slice(cursor);
    }

    return masked;
}

function findPreferredChunkBoundary(
    text: string,
    from: number,
    hardEnd: number,
) {
    if (hardEnd >= text.length) {
        return text.length;
    }

    const preferredStart = Math.min(
        hardEnd,
        from +
            Math.max(
                1,
                Math.floor(
                    (hardEnd - from) * CHUNK_BREAK_SEARCH_FRACTION,
                ),
            ),
    );
    const searchWindow = text.slice(preferredStart, hardEnd);
    const breakpoints: Array<{ token: string; bias: number }> = [
        { token: "\n\n", bias: 2 },
        { token: "\n", bias: 1 },
        { token: ". ", bias: 2 },
        { token: "! ", bias: 2 },
        { token: "? ", bias: 2 },
    ];

    for (const breakpoint of breakpoints) {
        const index = searchWindow.lastIndexOf(breakpoint.token);
        if (index >= 0) {
            return preferredStart + index + breakpoint.bias;
        }
    }

    return hardEnd;
}

function buildGrammarDocumentSnapshot(view: EditorView): GrammarDocumentSnapshot {
    const text = view.state.doc.toString();
    const maskedText = maskExcludedText(text, collectExcludedRanges(view));
    const chunks: GrammarDocumentChunk[] = [];
    let from = 0;

    while (from < maskedText.length) {
        while (from < maskedText.length && !/\S/u.test(maskedText[from] ?? "")) {
            from += 1;
        }

        if (from >= maskedText.length) {
            break;
        }

        const hardEnd = Math.min(
            maskedText.length,
            from + MAX_GRAMMAR_CHUNK_LENGTH,
        );
        let to =
            hardEnd >= maskedText.length
                ? maskedText.length
                : findPreferredChunkBoundary(maskedText, from, hardEnd);

        if (to <= from) {
            to = hardEnd;
        }

        const chunkText = maskedText.slice(from, to);
        if (chunkText.trim()) {
            chunks.push({ from, to, text: chunkText });
        }
        from = to;
    }

    return {
        version: hashText(maskedText),
        chunks,
    };
}

type GrammarExtensionOptions = {
    enabled: boolean;
    noteId: string | null | undefined;
    primaryLanguage: SpellcheckLanguage;
    serverUrl: string;
};

export type ResolvedGrammarDiagnostic = GrammarDiagnostic & {
    from: number;
    to: number;
};

const grammarCache = new Map<string, ResolvedGrammarDiagnostic[]>();
const GRAMMAR_CACHE_MAX = 32;

function getCachedGrammar(cacheKey: string) {
    return grammarCache.get(cacheKey) ?? null;
}

function setCachedGrammar(
    cacheKey: string,
    diagnostics: ResolvedGrammarDiagnostic[],
) {
    if (grammarCache.size >= GRAMMAR_CACHE_MAX) {
        const oldest = grammarCache.keys().next().value;
        if (oldest !== undefined) {
            grammarCache.delete(oldest);
        }
    }

    grammarCache.set(cacheKey, diagnostics);
}

const activeDiagnostics = new Map<string, ResolvedGrammarDiagnostic[]>();

function setActiveDiagnostics(
    noteId: string,
    diagnostics: ResolvedGrammarDiagnostic[],
) {
    activeDiagnostics.set(noteId, diagnostics);
}

function clearActiveDiagnostics(noteId: string) {
    activeDiagnostics.delete(noteId);
}

export function findGrammarDiagnosticsAt(noteId: string, pos: number) {
    return (activeDiagnostics.get(noteId) ?? []).filter(
        (diagnostic) => pos >= diagnostic.from && pos <= diagnostic.to,
    );
}

export function findGrammarDiagnosticAt(
    noteId: string,
    pos: number,
): ResolvedGrammarDiagnostic | null {
    return findGrammarDiagnosticsAt(noteId, pos)[0] ?? null;
}

const rateLimitedUntilByServer = new Map<string, number>();
const RATE_LIMIT_BACKOFF_MS = 30_000;

function isRateLimited(serverUrl: string): boolean {
    const until =
        rateLimitedUntilByServer.get(normalizeGrammarServerUrl(serverUrl)) ?? 0;
    return Date.now() < until;
}

function markRateLimited(serverUrl: string) {
    rateLimitedUntilByServer.set(
        normalizeGrammarServerUrl(serverUrl),
        Date.now() + RATE_LIMIT_BACKOFF_MS,
    );
}

function buildResolvedGrammarDiagnostics(
    chunk: GrammarDocumentChunk,
    diagnostics: GrammarDiagnostic[],
) {
    return diagnostics
        .map((diagnostic) => ({
            ...diagnostic,
            from: chunk.from + diagnostic.start_utf16,
            to: chunk.from + diagnostic.end_utf16,
        }))
        .filter((diagnostic) => diagnostic.to > diagnostic.from);
}

function grammarHoverTooltip(noteId: string) {
    return hoverTooltip(
        (_view, pos): Tooltip | null => {
            const diagnostics = findGrammarDiagnosticsAt(noteId, pos);
            if (diagnostics.length === 0) {
                return null;
            }

            const tooltipFrom = Math.min(
                ...diagnostics.map((diagnostic) => diagnostic.from),
            );
            const tooltipTo = Math.max(
                ...diagnostics.map((diagnostic) => diagnostic.to),
            );

            return {
                pos: tooltipFrom,
                end: tooltipTo,
                above: true,
                create() {
                    const dom = document.createElement("div");
                    dom.className = "cm-grammar-tooltip";

                    for (const diagnostic of diagnostics) {
                        const item = document.createElement("div");
                        item.className = "cm-grammar-tooltip-item";

                        const message = document.createElement("div");
                        message.className = "cm-grammar-tooltip-message";
                        message.textContent = diagnostic.message;
                        item.appendChild(message);

                        if (diagnostic.replacements.length > 0) {
                            const suggestions = document.createElement("div");
                            suggestions.className =
                                "cm-grammar-tooltip-suggestions";
                            suggestions.textContent =
                                diagnostic.replacements.join(", ");
                            item.appendChild(suggestions);
                        }

                        dom.appendChild(item);
                    }

                    return { dom };
                },
            };
        },
        { hoverTime: 400 },
    );
}

const grammarTooltipTheme = EditorView.baseTheme({
    ".cm-grammar-tooltip": {
        padding: "6px 10px",
        fontSize: "12px",
        lineHeight: "1.5",
        maxWidth: "360px",
        color: "var(--text-primary)",
        backgroundColor: "var(--bg-secondary)",
        border: "1px solid var(--border)",
        borderRadius: "6px",
        boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
    },
    ".cm-grammar-tooltip-item + .cm-grammar-tooltip-item": {
        marginTop: "6px",
        paddingTop: "6px",
        borderTop: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
    },
    ".cm-grammar-tooltip-message": {
        color: "var(--text-primary)",
    },
    ".cm-grammar-tooltip-suggestions": {
        marginTop: "4px",
        fontSize: "11px",
        color: "var(--accent)",
        fontStyle: "italic",
    },
});

export function getGrammarEditorExtension({
    enabled,
    noteId,
    primaryLanguage,
    serverUrl,
}: GrammarExtensionOptions) {
    if (!enabled || typeof noteId !== "string" || noteId.length === 0) {
        return [];
    }
    const activeNoteId = noteId;

    const plugin = ViewPlugin.fromClass(
        class {
            decorations: DecorationSet = Decoration.none;
            private view: EditorView;
            private debounceTimer: ReturnType<typeof setTimeout> | null = null;
            private destroyed = false;
            private refreshQueued = false;
            private inFlight = false;
            private scheduledRevision = 0;

            constructor(view: EditorView) {
                this.view = view;
                this.scheduleRefresh();
            }

            update(update: ViewUpdate) {
                if (update.docChanged) {
                    this.scheduleRefresh();
                }
            }

            destroy() {
                this.destroyed = true;
                if (this.debounceTimer) {
                    clearTimeout(this.debounceTimer);
                    this.debounceTimer = null;
                }
                clearActiveDiagnostics(activeNoteId);
            }

            private scheduleRefresh() {
                this.scheduledRevision += 1;
                const targetRevision = this.scheduledRevision;

                if (this.debounceTimer) {
                    clearTimeout(this.debounceTimer);
                }

                this.debounceTimer = setTimeout(() => {
                    if (
                        this.destroyed ||
                        targetRevision !== this.scheduledRevision
                    ) {
                        return;
                    }

                    this.refreshQueued = true;
                    void this.flushRefreshQueue();
                }, GRAMMAR_DEBOUNCE_MS);
            }

            private async flushRefreshQueue() {
                if (this.inFlight || this.destroyed) {
                    return;
                }

                while (this.refreshQueued && !this.destroyed) {
                    this.refreshQueued = false;
                    const revision = this.scheduledRevision;
                    this.inFlight = true;

                    try {
                        await this.runRefresh(revision);
                    } finally {
                        this.inFlight = false;
                    }
                }
            }

            private applyDiagnostics(
                diagnostics: ResolvedGrammarDiagnostic[],
            ) {
                setActiveDiagnostics(activeNoteId, diagnostics);
                this.decorations = buildGrammarDecorations(diagnostics);
                this.view.dispatch({});
            }

            private async runRefresh(revision: number) {
                const snapshot = buildGrammarDocumentSnapshot(this.view);
                const cacheKey = buildGrammarCacheKey(
                    activeNoteId,
                    snapshot.version,
                    primaryLanguage,
                    serverUrl,
                );

                if (snapshot.chunks.length === 0) {
                    this.decorations = Decoration.none;
                    clearActiveDiagnostics(activeNoteId);
                    this.view.dispatch({});
                    return;
                }

                const cached = getCachedGrammar(cacheKey);
                if (cached) {
                    this.applyDiagnostics(cached);
                    return;
                }

                if (isRateLimited(serverUrl)) {
                    return;
                }

                try {
                    const diagnostics: ResolvedGrammarDiagnostic[] = [];

                    for (const chunk of snapshot.chunks) {
                        const result = await spellcheckCheckGrammar(
                            chunk.text,
                            primaryLanguage,
                            serverUrl || undefined,
                        );

                        if (
                            this.destroyed ||
                            revision !== this.scheduledRevision
                        ) {
                            return;
                        }

                        diagnostics.push(
                            ...buildResolvedGrammarDiagnostics(
                                chunk,
                                result.diagnostics,
                            ),
                        );
                    }

                    diagnostics.sort(
                        (left, right) =>
                            left.from - right.from || left.to - right.to,
                    );

                    if (
                        this.destroyed ||
                        revision !== this.scheduledRevision
                    ) {
                        return;
                    }

                    setCachedGrammar(cacheKey, diagnostics);
                    this.applyDiagnostics(diagnostics);
                } catch (error) {
                    if (this.destroyed || revision !== this.scheduledRevision) {
                        return;
                    }

                    const message =
                        error instanceof Error ? error.message : String(error);
                    if (
                        message.includes("429") ||
                        message.includes("Too Many")
                    ) {
                        markRateLimited(serverUrl);
                    }

                    this.decorations = Decoration.none;
                    clearActiveDiagnostics(activeNoteId);
                    this.view.dispatch({});
                }
            }
        },
        {
            decorations: (plugin) => plugin.decorations,
        },
    );

    return [
        plugin,
        grammarDecorationsTheme,
        grammarHoverTooltip(activeNoteId),
        grammarTooltipTheme,
    ];
}
