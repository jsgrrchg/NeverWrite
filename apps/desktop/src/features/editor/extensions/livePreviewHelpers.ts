import { Decoration } from "@codemirror/view";
import {
    type EditorState,
    type Transaction,
    StateField,
} from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import {
    selectionTouchesLine,
    selectionTouchesRange,
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

// ---------------------------------------------------------------------------
// Shared decorations
// ---------------------------------------------------------------------------

/** Removes element from layout (for block-level marks: list markers, heading marks, link brackets). */
export const hideMark = Decoration.mark({ class: "cm-lp-hidden" });

/** Hides inline syntax marks while collapsing their visual width. */
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
) {
    const tokenActive = selectionTouchesRange(state, activeFrom, activeTo);
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
