/**
 * Inline diff decorations for CodeMirror — shows agent changes directly
 * in the editor with colored backgrounds, left border stripes, deleted-text
 * blocks, and per-hunk Keep/Reject controls.
 *
 * Data flows in via StateEffect (dispatched by Editor.tsx when the
 * chatStore's TrackedFile.version changes).
 *
 * Architecture:
 *  - ViewPlugin  → line decorations (added/modified) + inline hunk controls
 *  - StateField  → block widget decorations (deleted text blocks)
 *    (ViewPlugins cannot provide block decorations — CM6 restriction)
 */

import {
    type EditorState,
    type Extension,
    StateEffect,
    StateField,
    RangeSetBuilder,
} from "@codemirror/state";
import {
    Decoration,
    type DecorationSet,
    EditorView,
    ViewPlugin,
    WidgetType,
    type ViewUpdate,
} from "@codemirror/view";
import type {
    AgentTextSpan,
    HunkWordDiffs,
    LineEdit,
} from "../../ai/diff/actionLogTypes";
import type { ChangePresentationLevel } from "../changePresentationModel";
import { computeWordDiffsForHunk } from "../../ai/store/actionLogModel";
import { inlineDiffTheme } from "./inlineDiffTheme";

// ---------------------------------------------------------------------------
// Public state management
// ---------------------------------------------------------------------------

export interface InlineDiffPresentationState {
    level: ChangePresentationLevel;
    showInlineActions: boolean;
    showWordDiff: boolean;
    collapseLargeDeletes: boolean;
    reducedInlineMode: boolean;
    collapsedDeleteBlockIndexes: number[];
}

export interface InlineDiffState {
    edits: LineEdit[];
    spans: AgentTextSpan[];
    /** Parallel to edits — deleted lines text for each edit (empty for non-deletions). */
    deletedTexts: string[][];
    sessionId: string | null;
    identityKey: string | null;
    diffBase: string;
    reviewState: "pending" | "finalized";
    version: number;
    presentation: InlineDiffPresentationState;
    activeEditIndex?: number | null;
    hoveredEditIndex?: number | null;
}

const emptyState: InlineDiffState = {
    edits: [],
    spans: [],
    deletedTexts: [],
    sessionId: null,
    identityKey: null,
    diffBase: "",
    reviewState: "finalized",
    version: 0,
    presentation: {
        level: "small",
        showInlineActions: false,
        showWordDiff: false,
        collapseLargeDeletes: false,
        reducedInlineMode: false,
        collapsedDeleteBlockIndexes: [],
    },
    activeEditIndex: null,
    hoveredEditIndex: null,
};

export const setInlineDiff = StateEffect.define<InlineDiffState>();
export const clearInlineDiff = StateEffect.define<null>();
export const setInlineDiffActiveEditIndex = StateEffect.define<number | null>();
export const setInlineDiffHoveredEditIndex = StateEffect.define<number | null>();

function normalizeEditIndex(
    editCount: number,
    candidate: number | null | undefined,
) {
    return typeof candidate === "number" &&
        candidate >= 0 &&
        candidate < editCount
        ? candidate
        : null;
}

export const inlineDiffField = StateField.define<InlineDiffState>({
    create: () => emptyState,
    update(value, tr) {
        for (const effect of tr.effects) {
            if (effect.is(setInlineDiff)) {
                return {
                    ...effect.value,
                    activeEditIndex: normalizeEditIndex(
                        effect.value.edits.length,
                        effect.value.activeEditIndex ?? value.activeEditIndex,
                    ),
                    hoveredEditIndex: normalizeEditIndex(
                        effect.value.edits.length,
                        effect.value.hoveredEditIndex ??
                            value.hoveredEditIndex,
                    ),
                };
            }
            if (effect.is(clearInlineDiff)) return emptyState;
            if (effect.is(setInlineDiffActiveEditIndex)) {
                const nextIndex = normalizeEditIndex(
                    value.edits.length,
                    effect.value,
                );
                if (nextIndex === (value.activeEditIndex ?? null)) {
                    return value;
                }
                return { ...value, activeEditIndex: nextIndex };
            }
            if (effect.is(setInlineDiffHoveredEditIndex)) {
                const nextIndex = normalizeEditIndex(
                    value.edits.length,
                    effect.value,
                );
                if (nextIndex === (value.hoveredEditIndex ?? null)) {
                    return value;
                }
                return { ...value, hoveredEditIndex: nextIndex };
            }
        }
        return value;
    },
});

// ---------------------------------------------------------------------------
// Decoration classes (reused across rebuilds)
// ---------------------------------------------------------------------------

const addedLineDeco = Decoration.line({ class: "cm-diff-added" });
const modifiedLineDeco = Decoration.line({ class: "cm-diff-modified" });
const pendingLineDeco = Decoration.line({ class: "cm-diff-pending" });
const addedInlineMarkDeco = Decoration.mark({ class: "cm-diff-inline-add" });
const modifiedInlineMarkDeco = Decoration.mark({
    class: "cm-diff-inline-modified",
});
const focusedLineDeco = Decoration.line({ class: "cm-diff-focused" });
const wordChangedInlineMarkDeco = Decoration.mark({
    class: "cm-diff-word-changed",
});
const wordLineDeco = Decoration.line({ class: "cm-diff-word-line-bg" });

const WORD_DIFF_MAX_LINES = 5;
const WORD_DIFF_MAX_CHARS = 240;

function clampOffset(doc: EditorView["state"]["doc"], offset: number): number {
    return Math.max(0, Math.min(offset, doc.length));
}

function spanLineRange(
    doc: EditorView["state"]["doc"],
    span: AgentTextSpan,
): { start: number; end: number } | null {
    if (span.currentFrom === span.currentTo) return null;

    const from = clampOffset(doc, span.currentFrom);
    const to = clampOffset(doc, span.currentTo);
    if (from === to) return null;

    const start = doc.lineAt(from).number - 1;
    const end = doc.lineAt(Math.max(from, to - 1)).number;
    return { start, end };
}

function spansForEdit(
    doc: EditorView["state"]["doc"],
    edit: LineEdit,
    spans: AgentTextSpan[],
): AgentTextSpan[] {
    if (spans.length === 0) return [];

    return spans.filter((span) => {
        const range = spanLineRange(doc, span);
        if (!range) return false;
        if (edit.newStart === edit.newEnd) {
            return range.start === edit.newStart || range.end === edit.newStart;
        }
        return range.start < edit.newEnd && edit.newStart < range.end;
    });
}

function spanCoversFullLine(
    doc: EditorView["state"]["doc"],
    span: AgentTextSpan,
): boolean {
    if (span.currentFrom === span.currentTo) return false;

    const from = clampOffset(doc, span.currentFrom);
    const to = clampOffset(doc, span.currentTo);
    if (from === to) return false;

    const fromLine = doc.lineAt(from);
    const toLine = doc.lineAt(Math.max(from, to - 1));
    return from === fromLine.from && to === toLine.to;
}

function shouldRenderInlineMark(
    doc: EditorView["state"]["doc"],
    span: AgentTextSpan,
): boolean {
    if (span.currentFrom === span.currentTo) return false;

    const from = clampOffset(doc, span.currentFrom);
    const to = clampOffset(doc, span.currentTo);
    if (from === to) return false;

    const text = doc.sliceString(from, to);
    if (text.includes("\n")) return false;

    return !spanCoversFullLine(doc, span);
}

function shouldUseLineBackgroundForEdit(
    doc: EditorView["state"]["doc"],
    edit: LineEdit,
    spans: AgentTextSpan[],
): boolean {
    if (edit.newStart === edit.newEnd) return false;

    const relatedSpans = spansForEdit(doc, edit, spans);
    if (relatedSpans.length === 0) {
        return edit.newEnd - edit.newStart > 1;
    }

    return relatedSpans.some((span) => {
        const from = clampOffset(doc, span.currentFrom);
        const to = clampOffset(doc, span.currentTo);
        if (from === to) return false;
        const text = doc.sliceString(from, to);
        return text.includes("\n") || spanCoversFullLine(doc, span);
    });
}

function spanHandledByWordDiff(
    doc: EditorView["state"]["doc"],
    span: AgentTextSpan,
    edits: LineEdit[],
    wordDiffEditIndexes: Set<number>,
): boolean {
    if (wordDiffEditIndexes.size === 0) return false;

    return edits.some((edit, index) => {
        if (!wordDiffEditIndexes.has(index)) return false;
        const range = spanLineRange(doc, span);
        if (!range) return false;
        if (edit.newStart === edit.newEnd) {
            return range.start === edit.newStart || range.end === edit.newStart;
        }
        return range.start < edit.newEnd && edit.newStart < range.end;
    });
}

function shouldHighlightDeletedWords(
    deletedLines: string[],
    maxLines = WORD_DIFF_MAX_LINES,
    maxChars = WORD_DIFF_MAX_CHARS,
): boolean {
    if (deletedLines.length === 0 || deletedLines.length > maxLines) {
        return false;
    }

    const totalChars = deletedLines.reduce(
        (sum, line) => sum + line.length,
        Math.max(0, deletedLines.length - 1),
    );

    return totalChars <= maxChars;
}

function appendDeletedLineContent(lineEl: HTMLElement, line: string) {
    if (line.length === 0) {
        lineEl.textContent = "\u00a0";
        return;
    }

    const matcher = /\s+|\w+|[^\w\s]+/g;
    let match: RegExpExecArray | null;

    while ((match = matcher.exec(line)) !== null) {
        if (/^\s+$/.test(match[0])) {
            lineEl.appendChild(document.createTextNode(match[0]));
            continue;
        }

        const token = document.createElement("span");
        token.className = "cm-diff-word-removed";
        token.textContent = match[0];
        lineEl.appendChild(token);
    }
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

class HunkControlsWidget extends WidgetType {
    private sessionId: string;
    private identityKey: string;
    private newStart: number;
    private newEnd: number;

    constructor(
        sessionId: string,
        identityKey: string,
        newStart: number,
        newEnd: number,
    ) {
        super();
        this.sessionId = sessionId;
        this.identityKey = identityKey;
        this.newStart = newStart;
        this.newEnd = newEnd;
    }

    toDOM() {
        const container = document.createElement("span");
        container.className = "cm-diff-hunk-controls";

        container.appendChild(
            this.makeButton("Keep", "cm-diff-hunk-btn-keep", "accepted"),
        );
        container.appendChild(
            this.makeButton("Reject", "cm-diff-hunk-btn-reject", "rejected"),
        );
        return container;
    }

    private makeButton(
        label: string,
        cssClass: string,
        decision: "accepted" | "rejected",
    ) {
        const btn = document.createElement("button");
        btn.className = `cm-diff-hunk-btn ${cssClass}`;
        btn.textContent = label;
        btn.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
        btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            import("../../ai/store/chatStore").then(({ useChatStore }) => {
                void useChatStore
                    .getState()
                    .resolveHunkEdits(
                        this.sessionId,
                        this.identityKey,
                        decision,
                        this.newStart,
                        this.newEnd,
                    );
            });
        });
        return btn;
    }

    eq(other: HunkControlsWidget) {
        return (
            this.sessionId === other.sessionId &&
            this.identityKey === other.identityKey &&
            this.newStart === other.newStart &&
            this.newEnd === other.newEnd
        );
    }

    get estimatedHeight() {
        return 0;
    }
    ignoreEvent() {
        return true;
    }
}

class DeletedBlockWidget extends WidgetType {
    private deletedLines: string[];
    private sessionId: string;
    private identityKey: string;
    private newStart: number;
    private newEnd: number;
    private showControls: boolean;
    private reviewState: "pending" | "finalized";
    private collapsed: boolean;
    private focused: boolean;

    constructor(
        deletedLines: string[],
        sessionId: string,
        identityKey: string,
        newStart: number,
        newEnd: number,
        reviewState: "pending" | "finalized",
        showControls: boolean,
        collapsed: boolean,
        focused: boolean,
    ) {
        super();
        this.deletedLines = deletedLines;
        this.sessionId = sessionId;
        this.identityKey = identityKey;
        this.newStart = newStart;
        this.newEnd = newEnd;
        this.reviewState = reviewState;
        this.showControls = showControls;
        this.collapsed = collapsed;
        this.focused = focused;
    }

    toDOM() {
        const wrapper = document.createElement("div");
        wrapper.className =
            this.reviewState === "pending"
                ? "cm-diff-deleted-block cm-diff-pending"
                : "cm-diff-deleted-block";
        if (this.focused) {
            wrapper.classList.add("cm-diff-deleted-block-focused");
        }
        if (this.collapsed) {
            const summaryEl = document.createElement("div");
            summaryEl.className = "cm-diff-deleted-summary";
            summaryEl.textContent =
                this.deletedLines.length === 1
                    ? "1 deleted line"
                    : `${this.deletedLines.length} deleted lines`;
            wrapper.appendChild(summaryEl);
        } else {
            const highlightWords = shouldHighlightDeletedWords(
                this.deletedLines,
            );

            for (const line of this.deletedLines) {
                const lineEl = document.createElement("div");
                lineEl.className = "cm-diff-deleted-line";
                if (highlightWords) {
                    appendDeletedLineContent(lineEl, line);
                } else {
                    lineEl.textContent = line || "\u00a0"; // nbsp for empty lines
                }
                wrapper.appendChild(lineEl);
            }
        }

        if (this.showControls) {
            const controls = document.createElement("div");
            controls.className = "cm-diff-deleted-controls";

            controls.appendChild(
                this.makeButton("Keep", "cm-diff-hunk-btn-keep", "accepted"),
            );
            controls.appendChild(
                this.makeButton(
                    "Reject",
                    "cm-diff-hunk-btn-reject",
                    "rejected",
                ),
            );
            wrapper.appendChild(controls);
        }

        return wrapper;
    }

    private makeButton(
        label: string,
        cssClass: string,
        decision: "accepted" | "rejected",
    ) {
        const btn = document.createElement("button");
        btn.className = `cm-diff-hunk-btn ${cssClass}`;
        btn.textContent = label;
        btn.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
        btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            import("../../ai/store/chatStore").then(({ useChatStore }) => {
                void useChatStore
                    .getState()
                    .resolveHunkEdits(
                        this.sessionId,
                        this.identityKey,
                        decision,
                        this.newStart,
                        this.newEnd,
                    );
            });
        });
        return btn;
    }

    eq(other: DeletedBlockWidget) {
        return (
            this.sessionId === other.sessionId &&
            this.identityKey === other.identityKey &&
            this.newStart === other.newStart &&
            this.newEnd === other.newEnd &&
            this.reviewState === other.reviewState &&
            this.showControls === other.showControls &&
            this.collapsed === other.collapsed &&
            this.focused === other.focused &&
            this.deletedLines.length === other.deletedLines.length &&
            this.deletedLines.every((l, i) => l === other.deletedLines[i])
        );
    }

    get estimatedHeight() {
        if (this.collapsed) {
            return this.showControls ? 56 : 28;
        }
        return this.deletedLines.length * 22 + 30;
    }
    ignoreEvent() {
        return true;
    }
}

// ---------------------------------------------------------------------------
// ViewPlugin — line decorations for added/modified lines + inline controls
// ---------------------------------------------------------------------------

function buildLineDecorations(view: EditorView): DecorationSet {
    const diffState = view.state.field(inlineDiffField);
    if (diffState.edits.length === 0 && diffState.spans.length === 0) {
        return Decoration.none;
    }

    const builder = new RangeSetBuilder<Decoration>();
    const doc = view.state.doc;
    const totalLines = doc.lines;
    const wordDiffsByEditIndex = new Map<number, HunkWordDiffs>();
    const wordDiffEditIndexes = new Set<number>();
    const reducedInlineMode = diffState.presentation.reducedInlineMode;
    const showWordDiff = diffState.presentation.showWordDiff;

    if (showWordDiff && !reducedInlineMode && diffState.diffBase.length > 0) {
        for (const [index, edit] of diffState.edits.entries()) {
            const wordDiffs = computeWordDiffsForHunk(
                diffState.diffBase,
                doc.toString(),
                edit,
                {
                    maxLines: WORD_DIFF_MAX_LINES,
                    maxChars: WORD_DIFF_MAX_CHARS,
                },
            );

            if (!wordDiffs) continue;
            wordDiffsByEditIndex.set(index, wordDiffs);
            wordDiffEditIndexes.add(index);
        }
    }

    const decos: Array<{ from: number; to: number; deco: Decoration }> = [];

    if (!reducedInlineMode) {
        for (const span of diffState.spans) {
            const from = clampOffset(doc, span.currentFrom);
            const to = clampOffset(doc, span.currentTo);
            if (!shouldRenderInlineMark(doc, span) || from === to) continue;
            if (
                spanHandledByWordDiff(
                    doc,
                    span,
                    diffState.edits,
                    wordDiffEditIndexes,
                )
            ) {
                continue;
            }

            decos.push({
                from,
                to,
                deco:
                    span.baseFrom === span.baseTo
                        ? addedInlineMarkDeco
                        : modifiedInlineMarkDeco,
            });
        }
    }

    for (const [index, edit] of diffState.edits.entries()) {
        const isAdded = edit.oldStart === edit.oldEnd;
        const isDeleted = edit.newStart === edit.newEnd;
        const wordDiffs = wordDiffsByEditIndex.get(index);
        const isFocused =
            diffState.activeEditIndex === index ||
            diffState.hoveredEditIndex === index;

        // Deletions are handled by the block-widget StateField below
        if (isDeleted) continue;

        if (wordDiffs) {
            for (
                let lineIdx = edit.newStart;
                lineIdx < edit.newEnd;
                lineIdx++
            ) {
                if (lineIdx >= totalLines) break;
                const lineFrom = doc.line(lineIdx + 1).from;
                decos.push({
                    from: lineFrom,
                    to: lineFrom,
                    deco: wordLineDeco,
                });
            }

            for (const range of wordDiffs.bufferRanges) {
                const from = clampOffset(doc, range.from);
                const to = clampOffset(doc, range.to);
                if (from === to) continue;
                decos.push({
                    from,
                    to,
                    deco: wordChangedInlineMarkDeco,
                });
            }
        } else if (
            reducedInlineMode ||
            shouldUseLineBackgroundForEdit(doc, edit, diffState.spans)
        ) {
            const lineDeco = isAdded ? addedLineDeco : modifiedLineDeco;
            for (
                let lineIdx = edit.newStart;
                lineIdx < edit.newEnd;
                lineIdx++
            ) {
                if (lineIdx >= totalLines) break;
                const lineFrom = doc.line(lineIdx + 1).from;
                decos.push({ from: lineFrom, to: lineFrom, deco: lineDeco });
            }
        }

        if (diffState.reviewState === "pending") {
            for (
                let lineIdx = edit.newStart;
                lineIdx < edit.newEnd;
                lineIdx++
            ) {
                if (lineIdx >= totalLines) break;
                const lineFrom = doc.line(lineIdx + 1).from;
                decos.push({
                    from: lineFrom,
                    to: lineFrom,
                    deco: pendingLineDeco,
                });
            }
        }

        if (isFocused) {
            for (
                let lineIdx = edit.newStart;
                lineIdx < edit.newEnd;
                lineIdx++
            ) {
                if (lineIdx >= totalLines) break;
                const lineFrom = doc.line(lineIdx + 1).from;
                decos.push({
                    from: lineFrom,
                    to: lineFrom,
                    deco: focusedLineDeco,
                });
            }
        }

        // Hunk controls on first line (inline widget, floated right via CSS)
        if (
            diffState.reviewState === "finalized" &&
            (diffState.presentation.showInlineActions || isFocused) &&
            diffState.sessionId &&
            diffState.identityKey &&
            edit.newStart < totalLines
        ) {
            const firstLineFrom = doc.line(edit.newStart + 1).from;
            decos.push({
                from: firstLineFrom,
                to: firstLineFrom,
                deco: Decoration.widget({
                    widget: new HunkControlsWidget(
                        diffState.sessionId,
                        diffState.identityKey,
                        edit.newStart,
                        edit.newEnd,
                    ),
                    side: 1,
                }),
            });
        }
    }

    decos.sort((a, b) => a.from - b.from || a.to - b.to);

    for (const { from, to, deco } of decos) {
        builder.add(from, to, deco);
    }

    return builder.finish();
}

const inlineDiffPlugin = ViewPlugin.fromClass(
    class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
            this.decorations = buildLineDecorations(view);
        }

        update(update: ViewUpdate) {
            const oldState = update.startState.field(inlineDiffField);
            const newState = update.state.field(inlineDiffField);
            if (oldState !== newState) {
                this.decorations = buildLineDecorations(update.view);
            } else if (update.docChanged) {
                // Map existing decorations through doc changes instead of
                // rebuilding from stale diff data. New diff data will trigger
                // a full rebuild via setInlineDiff when consolidation completes.
                this.decorations = this.decorations.map(update.changes);
            }
        }
    },
    { decorations: (p) => p.decorations },
);

// ---------------------------------------------------------------------------
// StateField — block widget decorations for deleted text blocks
// (ViewPlugins cannot provide block decorations — CM6 restriction)
// ---------------------------------------------------------------------------

function buildDeletedBlockDecorations(state: EditorState): DecorationSet {
    const diffState = state.field(inlineDiffField);
    if (diffState.edits.length === 0) return Decoration.none;

    const doc = state.doc;
    const totalLines = doc.lines;
    const builder = new RangeSetBuilder<Decoration>();
    const decos: Array<{ from: number; deco: Decoration }> = [];
    const collapsedDeleteIndexes = new Set(
        diffState.presentation.collapsedDeleteBlockIndexes,
    );

    for (let i = 0; i < diffState.edits.length; i++) {
        const edit = diffState.edits[i];
        if (edit.newStart !== edit.newEnd) continue; // not a pure deletion

        const deletedLines = diffState.deletedTexts[i];
        if (!deletedLines || deletedLines.length === 0) continue;
        if (!diffState.sessionId || !diffState.identityKey) continue;
        const isFocused =
            diffState.activeEditIndex === i || diffState.hoveredEditIndex === i;

        // Place the block widget before the line at newStart
        let pos: number;
        if (edit.newStart < totalLines) {
            pos = doc.line(edit.newStart + 1).from;
        } else {
            pos = doc.length;
        }

        decos.push({
            from: pos,
            deco: Decoration.widget({
                widget: new DeletedBlockWidget(
                    deletedLines,
                    diffState.sessionId,
                    diffState.identityKey,
                    edit.newStart,
                    edit.newEnd,
                    diffState.reviewState,
                    diffState.reviewState === "finalized" &&
                        (diffState.presentation.showInlineActions || isFocused),
                    collapsedDeleteIndexes.has(i),
                    isFocused,
                ),
                block: true,
                side: -1, // before the line
            }),
        });
    }

    decos.sort((a, b) => a.from - b.from);

    for (const { from, deco } of decos) {
        builder.add(from, from, deco);
    }

    return builder.finish();
}

const deletedBlockField = StateField.define<DecorationSet>({
    create(state) {
        return buildDeletedBlockDecorations(state);
    },
    update(value, tr) {
        const oldDiff = tr.startState.field(inlineDiffField);
        const newDiff = tr.state.field(inlineDiffField);
        if (oldDiff !== newDiff) {
            return buildDeletedBlockDecorations(tr.state);
        }
        if (tr.docChanged) {
            // Map through doc changes to keep positions valid.
            // Full rebuild happens when new diff data arrives.
            return value.map(tr.changes);
        }
        return value;
    },
    provide: (field) => EditorView.decorations.from(field),
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getInlineDiffExtension(): Extension {
    return [
        inlineDiffField,
        inlineDiffPlugin,
        deletedBlockField,
        inlineDiffTheme,
    ];
}
