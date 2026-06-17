import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import {
    type EditorState,
    type Transaction,
    StateEffect,
    StateField,
} from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import {
    selectionTouchesLine,
    selectionTouchesRange,
    selectionTouchesRangeBoundary,
} from "./selectionActivity";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DecoEntry {
    from: number;
    to: number;
    deco: Decoration;
}

export interface LineDecoEntry {
    classes: Set<string>;
    attrs: Record<string, string>;
    styles: Record<string, string>;
}

export interface LinkInfo {
    textFrom: number;
    textTo: number;
    hasUrl: boolean;
    url: string | null;
    title: string | null;
    label: string | null;
    isAutolink: boolean;
    isEmail: boolean;
}

export interface HighlightRange {
    from: number;
    to: number;
    contentFrom: number;
    contentTo: number;
}

// ---------------------------------------------------------------------------
// Shared decorations
// ---------------------------------------------------------------------------

/** Hides block-level marks (list markers, heading marks, link brackets) as zero-width inline elements. */
export const hideMark = Decoration.mark({ class: "cm-lp-hidden" });

/** Hides inline syntax marks (bold/italic/code delimiters) as zero-width inline elements. */
export const hideInlineMark = Decoration.mark({ class: "cm-lp-hidden-inline" });

// ---------------------------------------------------------------------------
// Cursor-awareness helpers
// ---------------------------------------------------------------------------

/** Block-level check: is any cursor/selection on the same line(s) as [from, to]? */
export function isLineActive(
    state: EditorState,
    from: number,
    to: number,
): boolean {
    return selectionTouchesLine(state, from, to);
}

/** Inline-level check: does any cursor/selection overlap the range [from, to]? */
export function isRangeActive(
    state: EditorState,
    from: number,
    to: number,
): boolean {
    return selectionTouchesRange(state, from, to);
}

// ---------------------------------------------------------------------------
// Tree / node helpers
// ---------------------------------------------------------------------------

export function hideChildMarks(
    parentNode: SyntaxNode,
    markName: string,
    decos: DecoEntry[],
) {
    const cursor = parentNode.cursor();
    if (cursor.firstChild()) {
        do {
            if (cursor.name === markName && cursor.from < cursor.to) {
                decos.push({
                    from: cursor.from,
                    to: cursor.to,
                    deco: hideMark,
                });
            }
        } while (cursor.nextSibling());
    }
}

export function hideChildInlineMarks(
    parentNode: SyntaxNode,
    markName: string,
    decos: DecoEntry[],
) {
    const cursor = parentNode.cursor();
    if (cursor.firstChild()) {
        do {
            if (cursor.name === markName && cursor.from < cursor.to) {
                decos.push({
                    from: cursor.from,
                    to: cursor.to,
                    deco: hideInlineMark,
                });
            }
        } while (cursor.nextSibling());
    }
}

export function hideInactiveChildMarks(
    parentNode: SyntaxNode,
    markName: string,
    activeFrom: number,
    activeTo: number,
    state: EditorState,
    decos: DecoEntry[],
    hiddenDeco: Decoration,
    includeEndBoundary = false,
) {
    const tokenActive = includeEndBoundary
        ? selectionTouchesRangeBoundary(state, activeFrom, activeTo)
        : selectionTouchesRange(state, activeFrom, activeTo);
    if (tokenActive) return;

    const cursor = parentNode.cursor();
    if (cursor.firstChild()) {
        do {
            if (cursor.name === markName && cursor.from < cursor.to) {
                decos.push({
                    from: cursor.from,
                    to: cursor.to,
                    deco: hiddenDeco,
                });
            }
        } while (cursor.nextSibling());
    }
}

export function parseLinkChildren(
    linkNode: SyntaxNode,
    state: EditorState,
): LinkInfo | null {
    const cur = linkNode.cursor();
    let textFrom = -1;
    let textTo = -1;
    let hasUrl = false;
    let url: string | null = null;
    let title: string | null = null;
    let label: string | null = null;
    let seenOpenMark = false;

    if (cur.firstChild()) {
        do {
            if (cur.name === "LinkMark") {
                const ch = state.doc.sliceString(cur.from, cur.to);
                if (ch === "<") {
                    seenOpenMark = true;
                    textFrom = cur.to;
                } else if (ch === "[" || ch === "![") {
                    seenOpenMark = true;
                    textFrom = cur.to;
                } else if (ch === "]" && textTo < 0) textTo = cur.from;
                else if (ch === ">" && textTo < 0 && seenOpenMark)
                    textTo = cur.from;
            }
            if (cur.name === "URL") {
                hasUrl = true;
                url = state.doc.sliceString(cur.from, cur.to);
            }
            if (cur.name === "LinkTitle") {
                const rawTitle = state.doc.sliceString(cur.from, cur.to);
                title = rawTitle.slice(1, -1);
            }
            if (cur.name === "LinkLabel") {
                label = state.doc.sliceString(cur.from, cur.to);
            }
        } while (cur.nextSibling());
    }

    if (textFrom >= 0 && textTo >= textFrom) {
        const cleanedUrl = url?.trim() ?? null;
        const isEmail =
            cleanedUrl !== null &&
            !/^[a-z][a-z0-9+.-]*:/i.test(cleanedUrl) &&
            /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanedUrl);
        return {
            textFrom,
            textTo,
            hasUrl,
            url: cleanedUrl,
            title,
            label,
            isAutolink: linkNode.name === "Autolink",
            isEmail,
        };
    }
    return null;
}

export function unwrapLinkLabel(label: string): string {
    return label.trim().replace(/^\[/, "").replace(/\]$/, "").trim();
}

export function normalizeReferenceLabel(label: string): string {
    return unwrapLinkLabel(label)
        .replace(/\\(\[|\])/g, "$1")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

export function resolveLinkHref(
    info: Pick<LinkInfo, "url" | "label" | "isEmail">,
    references?: Map<string, { url: string; title: string | null }>,
): string | null {
    const directUrl = info.url?.trim();
    const resolved = directUrl
        ? directUrl
        : info.label && references
          ? (references.get(normalizeReferenceLabel(info.label))?.url ?? null)
          : null;
    if (!resolved) return null;

    if (
        info.isEmail ||
        (!/^[a-z][a-z0-9+.-]*:/i.test(resolved) &&
            /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(resolved))
    ) {
        return `mailto:${resolved}`;
    }
    return resolved;
}

function isEscapedAt(text: string, index: number) {
    let backslashCount = 0;
    let cursor = index - 1;

    while (cursor >= 0 && text[cursor] === "\\") {
        backslashCount++;
        cursor--;
    }

    return backslashCount % 2 === 1;
}

function isHighlightLineBreak(char: string) {
    return char === "\n" || char === "\r";
}

function isHighlightTrailingWhitespace(char: string) {
    return char === " " || char === "\t";
}

export function findHighlightRanges(text: string): HighlightRange[] {
    const ranges: HighlightRange[] = [];
    let index = 0;

    while (index < text.length - 1) {
        if (
            text[index] !== "=" ||
            text[index + 1] !== "=" ||
            isEscapedAt(text, index)
        ) {
            index++;
            continue;
        }

        const contentFrom = index + 2;
        const firstContentChar = text[contentFrom];
        if (!firstContentChar || /\s/u.test(firstContentChar)) {
            index += 2;
            continue;
        }

        let search = contentFrom;
        let lastNonWhitespace = -1;
        let matched = false;

        while (search < text.length - 1) {
            const char = text[search];
            if (isHighlightLineBreak(char)) {
                break;
            }

            if (
                char === "=" &&
                text[search + 1] === "=" &&
                !isEscapedAt(text, search)
            ) {
                if (lastNonWhitespace >= contentFrom) {
                    ranges.push({
                        from: index,
                        to: search + 2,
                        contentFrom,
                        contentTo: lastNonWhitespace + 1,
                    });
                    index = search + 2;
                    matched = true;
                }
                break;
            }

            if (!isHighlightTrailingWhitespace(char)) {
                lastNonWhitespace = search;
            }
            search++;
        }

        if (!matched) {
            index += 2;
        }
    }

    return ranges;
}

export function buildLinkReferenceIndex(state: EditorState) {
    const references = new Map<string, { url: string; title: string | null }>();
    syntaxTree(state).iterate({
        enter(node) {
            if (node.name !== "LinkReference") return;
            const cursor = node.node.cursor();
            let label: string | null = null;
            let url: string | null = null;
            let title: string | null = null;

            if (cursor.firstChild()) {
                do {
                    if (cursor.name === "LinkLabel") {
                        label = state.doc.sliceString(cursor.from, cursor.to);
                    } else if (cursor.name === "URL") {
                        url = state.doc
                            .sliceString(cursor.from, cursor.to)
                            .trim();
                    } else if (cursor.name === "LinkTitle") {
                        const rawTitle = state.doc.sliceString(
                            cursor.from,
                            cursor.to,
                        );
                        title = rawTitle.slice(1, -1);
                    }
                } while (cursor.nextSibling());
            }

            if (!label || !url) return;
            references.set(normalizeReferenceLabel(label), { url, title });
        },
    });

    return references;
}

export type LinkReferenceMap = Map<
    string,
    { url: string; title: string | null }
>;

// Characters that can affect link reference definitions: [label]: url
const LINK_REF_SIGNIFICANT = /(?:[\]:]|\[)/;

function linkRefNeedsRebuild(transaction: Transaction): boolean {
    if (!transaction.docChanged) return false;
    let dominated = true;
    transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
        if (!dominated) return;
        if (toA > fromA) {
            if (
                LINK_REF_SIGNIFICANT.test(
                    transaction.startState.doc.sliceString(fromA, toA),
                )
            ) {
                dominated = false;
                return;
            }
        }
        if (toB > fromB) {
            if (
                LINK_REF_SIGNIFICANT.test(
                    transaction.state.doc.sliceString(fromB, toB),
                )
            ) {
                dominated = false;
            }
        }
    });
    return !dominated;
}

/** StateField that caches the link reference index, rebuilding only on doc changes. */
export const linkReferenceField = StateField.define<LinkReferenceMap>({
    create(state) {
        return buildLinkReferenceIndex(state);
    },
    update(refs, transaction) {
        if (!linkRefNeedsRebuild(transaction)) return refs;
        return buildLinkReferenceIndex(transaction.state);
    },
});

// ---------------------------------------------------------------------------
// Footnote numbering
// ---------------------------------------------------------------------------

/** Maps a footnote id to the compact number shown in the live preview. */
export type FootnoteNumberMap = Map<string, number>;

// Footnote token: [^id]. The id cannot contain whitespace or ']'.
const FOOTNOTE_TOKEN_RE = /\[\^([^\]\s]+)\]/g;

/**
 * Assigns every footnote a compact, stable display number so the live preview
 * can render `[^descriptive-label]` as a tidy superscript index instead of the
 * raw label (which reads as noise — see issue #196).
 *
 * Numbering matches the reader's mental model used by Pandoc/Obsidian/GitHub:
 * footnotes are numbered by the order their *references* first appear in the
 * document. `[^id]:` definition markers are skipped while scanning references;
 * a footnote that is only ever defined (never referenced) is then appended so
 * it still receives a stable number.
 */
export function buildFootnoteNumberIndex(state: EditorState): FootnoteNumberMap {
    const numbers: FootnoteNumberMap = new Map();
    const text = state.doc.toString();
    const definedOnly: string[] = [];
    let next = 1;

    FOOTNOTE_TOKEN_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = FOOTNOTE_TOKEN_RE.exec(text)) !== null) {
        const id = match[1];
        const lineStart = text.lastIndexOf("\n", match.index - 1) + 1;
        // A definition marker is `[^id]:` at the start of its line. Defer those
        // so references drive the numbering order.
        const isDefinition =
            text[match.index + match[0].length] === ":" &&
            text.slice(lineStart, match.index).trim() === "";
        if (isDefinition) {
            definedOnly.push(id);
            continue;
        }
        if (!numbers.has(id)) numbers.set(id, next++);
    }

    for (const id of definedOnly) {
        if (!numbers.has(id)) numbers.set(id, next++);
    }

    return numbers;
}

// Characters that can change footnote markers: [ ^ ] :
const FOOTNOTE_SIGNIFICANT = /(?:[\]:^]|\[)/;

function footnoteNumbersNeedRebuild(transaction: Transaction): boolean {
    if (!transaction.docChanged) return false;
    let dominated = true;
    transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
        if (!dominated) return;
        if (
            toA > fromA &&
            FOOTNOTE_SIGNIFICANT.test(
                transaction.startState.doc.sliceString(fromA, toA),
            )
        ) {
            dominated = false;
            return;
        }
        if (
            toB > fromB &&
            FOOTNOTE_SIGNIFICANT.test(
                transaction.state.doc.sliceString(fromB, toB),
            )
        ) {
            dominated = false;
        }
    });
    return !dominated;
}

/** StateField caching footnote display numbers, rebuilt only when markers change. */
export const footnoteNumberField = StateField.define<FootnoteNumberMap>({
    create(state) {
        return buildFootnoteNumberIndex(state);
    },
    update(numbers, transaction) {
        if (!footnoteNumbersNeedRebuild(transaction)) return numbers;
        return buildFootnoteNumberIndex(transaction.state);
    },
});

// Footnote definition marker at the start of a line: `[^id]:`.
const FOOTNOTE_DEF_LINE_RE = /^\[\^([^\]\s]+)\]:/gm;

/**
 * Resolves the definition line for a footnote id by scanning the document text.
 * The live preview virtualizes the DOM, so the definition is usually not
 * rendered when a reference is clicked — resolving the position from the text
 * lets us jump to it regardless of what is currently on screen.
 */
export function findFootnoteDefinition(
    state: EditorState,
    id: string,
): { from: number; to: number } | null {
    const text = state.doc.toString();
    FOOTNOTE_DEF_LINE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = FOOTNOTE_DEF_LINE_RE.exec(text)) !== null) {
        if (match[1] === id) {
            const line = state.doc.lineAt(match.index);
            return { from: line.from, to: line.to };
        }
    }
    return null;
}

// Footnote reference token, scanned within a single line.
const FOOTNOTE_REF_AT_RE = /\[\^([^\]\s]+)\]/g;

/**
 * Returns the footnote reference covering a document position, if any. Pointer
 * hits resolve to a position rather than a DOM node — the reference renders as a
 * tiny superscript widget flanked by CM widget buffers, so the click target is
 * unreliable, but the position is not. Definition markers (`[^id]:` at the start
 * of a line) are excluded.
 */
export function footnoteRefAt(
    state: EditorState,
    pos: number,
): { id: string; from: number; to: number } | null {
    const line = state.doc.lineAt(pos);
    const offset = pos - line.from;
    FOOTNOTE_REF_AT_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = FOOTNOTE_REF_AT_RE.exec(line.text)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        const isDefinition =
            line.text.slice(0, start).trim() === "" && line.text[end] === ":";
        if (isDefinition) continue;
        if (offset >= start && offset <= end) {
            return { id: match[1], from: line.from + start, to: line.from + end };
        }
    }
    return null;
}

/** Effect: flash a jumped-to footnote definition line (a range, or null to clear). */
export const flashFootnoteDefEffect = StateEffect.define<{
    from: number;
    to: number;
} | null>();

const footnoteDefFlashMark = Decoration.line({
    class: "cm-lp-footnote-def-flash",
});

/**
 * Holds the transient highlight shown on the footnote definition a reference
 * jumped to, so the destination is obvious even when it was already on screen.
 */
export const footnoteDefFlashField = StateField.define<DecorationSet>({
    create() {
        return Decoration.none;
    },
    update(deco, transaction) {
        deco = deco.map(transaction.changes);
        for (const effect of transaction.effects) {
            if (!effect.is(flashFootnoteDefEffect)) continue;
            deco =
                effect.value === null
                    ? Decoration.none
                    : Decoration.set(
                          footnoteDefFlashMark.range(
                              transaction.state.doc.lineAt(effect.value.from)
                                  .from,
                          ),
                      );
        }
        return deco;
    },
    provide: (field) => EditorView.decorations.from(field),
});

export function findAncestor(
    node: SyntaxNode | null,
    name: string,
): SyntaxNode | null {
    let current: SyntaxNode | null = node;
    while (current) {
        if (current.name === name) return current;
        current = current.parent;
    }
    return null;
}

export function hasDescendant(node: SyntaxNode, name: string): boolean {
    const cursor = node.cursor();
    if (!cursor.firstChild()) return false;
    do {
        if (cursor.name === name) return true;
    } while (cursor.next() && cursor.from < node.to);
    return false;
}

// ---------------------------------------------------------------------------
// Text / indentation utilities
// ---------------------------------------------------------------------------

export function extendPastFollowingWhitespace(
    state: EditorState,
    to: number,
): number {
    let end = to;
    while (end < state.doc.length) {
        const char = state.doc.sliceString(end, end + 1);
        if (char !== " " && char !== "\t") break;
        end++;
    }
    return end;
}

export function measureIndent(prefix: string): number {
    let width = 0;
    for (const char of prefix) {
        width += char === "\t" ? 4 : 1;
    }
    return width;
}

export function measureLineLeadingIndent(lineText: string): number {
    const leadingWhitespace = lineText.match(/^\s*/)?.[0] ?? "";
    return measureIndent(leadingWhitespace);
}

export function addLineDecoration(
    lineDecos: Map<number, LineDecoEntry>,
    lineFrom: number,
    className: string,
    attrs?: Record<string, string>,
    styles?: Record<string, string>,
) {
    const entry = lineDecos.get(lineFrom) ?? {
        classes: new Set<string>(),
        attrs: {},
        styles: {},
    };
    entry.classes.add(className);
    if (attrs) {
        Object.assign(entry.attrs, attrs);
    }
    if (styles) {
        Object.assign(entry.styles, styles);
    }
    lineDecos.set(lineFrom, entry);
}
