import {
    Decoration,
    type DecorationSet,
    EditorView,
    ViewPlugin,
    type ViewUpdate,
} from "@codemirror/view";
import { type EditorState, RangeSetBuilder } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";

// ---------------------------------------------------------------------------
// Cursor-awareness helpers
// ---------------------------------------------------------------------------

/** Block-level check: is any cursor/selection on the same line(s) as [from, to]? */
function isLineActive(state: EditorState, from: number, to: number): boolean {
    const lineFrom = state.doc.lineAt(from).number;
    const lineTo = state.doc.lineAt(to).number;
    for (const range of state.selection.ranges) {
        const curFrom = state.doc.lineAt(range.from).number;
        const curTo = state.doc.lineAt(range.to).number;
        if (curTo >= lineFrom && curFrom <= lineTo) return true;
    }
    return false;
}

/** Editing-specific check: is there a caret on the same line(s) as [from, to]? */
function hasCaretOnLine(state: EditorState, from: number, to: number): boolean {
    const lineFrom = state.doc.lineAt(from).number;
    const lineTo = state.doc.lineAt(to).number;
    for (const range of state.selection.ranges) {
        if (!range.empty) continue;
        const caretLine = state.doc.lineAt(range.from).number;
        if (caretLine >= lineFrom && caretLine <= lineTo) return true;
    }
    return false;
}

/** Inline-level check: does any cursor/selection overlap the range [from, to]? */
function isRangeActive(state: EditorState, from: number, to: number): boolean {
    for (const range of state.selection.ranges) {
        if (range.to >= from && range.from <= to) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Decoration constants
// ---------------------------------------------------------------------------

// Using mark-based hiding is much safer than structural replace decorations.
const hideMark = Decoration.mark({ class: "cm-lp-hidden" });

const headingMarks: Record<number, Decoration> = {
    1: Decoration.mark({ class: "cm-lp-h1" }),
    2: Decoration.mark({ class: "cm-lp-h2" }),
    3: Decoration.mark({ class: "cm-lp-h3" }),
    4: Decoration.mark({ class: "cm-lp-h4" }),
    5: Decoration.mark({ class: "cm-lp-h5" }),
    6: Decoration.mark({ class: "cm-lp-h6" }),
};

function getHeadingLevel(nodeName: string): number | null {
    if (nodeName.startsWith("ATXHeading")) {
        return parseInt(nodeName.slice(10), 10);
    }
    if (nodeName === "SetextHeading1") return 1;
    if (nodeName === "SetextHeading2") return 2;
    return null;
}

const boldMark = Decoration.mark({ class: "cm-lp-bold" });
const italicMark = Decoration.mark({ class: "cm-lp-italic" });
const inlineCodeMark = Decoration.mark({ class: "cm-lp-code" });
const strikethroughMark = Decoration.mark({ class: "cm-lp-strikethrough" });
const highlightMark = Decoration.mark({ class: "cm-lp-highlight" });
const linkTextMark = Decoration.mark({ class: "cm-lp-link" });
const quoteContentMark = Decoration.mark({ class: "cm-lp-blockquote" });

// ---------------------------------------------------------------------------
// Accumulated decoration entry (sorted before building RangeSet)
// ---------------------------------------------------------------------------

interface DecoEntry {
    from: number;
    to: number;
    deco: Decoration;
}

interface LineDecoEntry {
    classes: Set<string>;
    attrs: Record<string, string>;
    styles: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Helper: hide all child nodes with a given name
// ---------------------------------------------------------------------------

function hideChildMarks(
    parentNode: SyntaxNode,
    markName: string,
    decos: DecoEntry[],
) {
    const cursor = parentNode.cursor();
    if (cursor.firstChild()) {
        do {
            if (cursor.name === markName) {
                decos.push({
                    from: cursor.from,
                    to: cursor.to,
                    deco: hideMark,
                });
            }
        } while (cursor.nextSibling());
    }
}

// ---------------------------------------------------------------------------
// Helper: parse Link/Image children to extract text range and URL presence
// ---------------------------------------------------------------------------

interface LinkInfo {
    textFrom: number;
    textTo: number;
    hasUrl: boolean;
}

function parseLinkChildren(
    linkNode: SyntaxNode,
    state: EditorState,
): LinkInfo | null {
    const cur = linkNode.cursor();
    let textFrom = -1;
    let textTo = -1;
    let hasUrl = false;

    if (cur.firstChild()) {
        do {
            if (cur.name === "LinkMark") {
                const ch = state.doc.sliceString(cur.from, cur.to);
                if (ch === "[" || ch === "![") textFrom = cur.to;
                else if (ch === "]" && textTo < 0) textTo = cur.from;
            }
            if (cur.name === "URL") hasUrl = true;
        } while (cur.nextSibling());
    }

    if (textFrom >= 0 && textTo > textFrom) {
        return { textFrom, textTo, hasUrl };
    }
    return null;
}

function findAncestor(
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

function hasDescendant(node: SyntaxNode, name: string): boolean {
    const nodeFrom = node.from;
    const nodeTo = node.to;
    const cursor = node.cursor();
    if (!cursor.firstChild()) return false;

    do {
        if (cursor.from < nodeFrom || cursor.to > nodeTo) break;
        if (cursor.name === name) return true;
    } while (cursor.next());

    return false;
}

function extendPastFollowingWhitespace(state: EditorState, to: number): number {
    let end = to;
    while (end < state.doc.length) {
        const char = state.doc.sliceString(end, end + 1);
        if (char !== " " && char !== "\t") break;
        end++;
    }
    return end;
}

function measureIndent(prefix: string): number {
    let width = 0;
    for (const char of prefix) {
        width += char === "\t" ? 4 : 1;
    }
    return width;
}

function measureLineLeadingIndent(lineText: string): number {
    const leadingWhitespace = lineText.match(/^\s*/)?.[0] ?? "";
    return measureIndent(leadingWhitespace);
}

function measureListPrefixWidth(lineText: string): number {
    const match = lineText.match(
        /^\s*(?:[-+*]\s+|\d+[.)]\s+)(?:\[(?: |x|X)\]\s+)?/,
    );
    return match ? measureIndent(match[0]) : 0;
}

function addLineDecoration(
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

// ---------------------------------------------------------------------------
// ViewPlugin
// ---------------------------------------------------------------------------

const livePreviewPlugin = ViewPlugin.fromClass(
    class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
            this.decorations = this.build(view);
        }

        update(update: ViewUpdate) {
            if (
                update.docChanged ||
                update.selectionSet ||
                update.viewportChanged
            ) {
                this.decorations = this.build(update.view);
            }
        }

        build(view: EditorView): DecorationSet {
            const { state } = view;
            const decos: DecoEntry[] = [];
            const lineDecos = new Map<number, LineDecoEntry>();
            const tree = syntaxTree(state);
            const { from: vpFrom, to: vpTo } = view.viewport;

            tree.iterate({
                from: vpFrom,
                to: vpTo,
                enter(node) {
                    // --- HEADINGS ---
                    const headingLevel = getHeadingLevel(node.name);
                    if (headingLevel !== null) {
                        const level = headingLevel;
                        const mark = headingMarks[level];
                        if (mark) {
                            decos.push({
                                from: node.from,
                                to: node.to,
                                deco: mark,
                            });
                        }

                        if (!isLineActive(state, node.from, node.to)) {
                            // Hide heading markers so headings are distinguished
                            // only by typography in live preview.
                            const cur = node.node.cursor();
                            if (cur.firstChild()) {
                                do {
                                    if (cur.name === "HeaderMark") {
                                        let hideFrom = cur.from;
                                        let hideTo = cur.to;

                                        // ATX headings: also hide the space after #
                                        if (
                                            node.name.startsWith("ATXHeading")
                                        ) {
                                            if (
                                                hideTo < node.to &&
                                                state.doc.sliceString(
                                                    hideTo,
                                                    hideTo + 1,
                                                ) === " "
                                            ) {
                                                hideTo++;
                                            }
                                        }

                                        // Setext headings: also hide the preceding newline
                                        // so the underline line disappears entirely.
                                        if (
                                            node.name.startsWith(
                                                "SetextHeading",
                                            ) &&
                                            hideFrom > node.from &&
                                            state.doc.sliceString(
                                                hideFrom - 1,
                                                hideFrom,
                                            ) === "\n"
                                        ) {
                                            hideFrom--;
                                        }

                                        decos.push({
                                            from: hideFrom,
                                            to: hideTo,
                                            deco: hideMark,
                                        });
                                    }
                                } while (cur.nextSibling());
                            }
                        }
                    }

                    // --- BOLD ---
                    if (node.name === "StrongEmphasis") {
                        decos.push({
                            from: node.from,
                            to: node.to,
                            deco: boldMark,
                        });
                        if (!isRangeActive(state, node.from, node.to)) {
                            hideChildMarks(node.node, "EmphasisMark", decos);
                        }
                    }

                    // --- ITALIC ---
                    if (node.name === "Emphasis") {
                        decos.push({
                            from: node.from,
                            to: node.to,
                            deco: italicMark,
                        });
                        if (!isRangeActive(state, node.from, node.to)) {
                            hideChildMarks(node.node, "EmphasisMark", decos);
                        }
                    }

                    // --- INLINE CODE ---
                    if (node.name === "InlineCode") {
                        decos.push({
                            from: node.from,
                            to: node.to,
                            deco: inlineCodeMark,
                        });
                        if (!isRangeActive(state, node.from, node.to)) {
                            hideChildMarks(node.node, "CodeMark", decos);
                        }
                    }

                    // --- LINKS [text](url) ---
                    // Skip Link nodes without URL child (e.g. [[wikilink]] misparsed)
                    if (node.name === "Link" || node.name === "Image") {
                        const info = parseLinkChildren(node.node, state);
                        // Only decorate if there's a real URL
                        if (info && info.hasUrl) {
                            if (!isRangeActive(state, node.from, node.to)) {
                                // Hide opening [  or ![
                                decos.push({
                                    from: node.from,
                                    to: info.textFrom,
                                    deco: hideMark,
                                });
                                // Hide ](url)
                                decos.push({
                                    from: info.textTo,
                                    to: node.to,
                                    deco: hideMark,
                                });
                                // Style the visible text as a link
                                decos.push({
                                    from: info.textFrom,
                                    to: info.textTo,
                                    deco: linkTextMark,
                                });
                            } else {
                                // When active, still style link text
                                decos.push({
                                    from: info.textFrom,
                                    to: info.textTo,
                                    deco: linkTextMark,
                                });
                            }
                        }
                    }

                    // --- HORIZONTAL RULE ---
                    if (node.name === "HorizontalRule") {
                        if (hasCaretOnLine(state, node.from, node.to)) return;
                        const line = state.doc.lineAt(node.from);
                        decos.push({
                            from: line.from,
                            to: line.to,
                            deco: hideMark,
                        });
                        addLineDecoration(
                            lineDecos,
                            line.from,
                            "cm-lp-hr-line",
                        );
                    }

                    // --- LIST MARKERS ---
                    if (node.name === "ListMark") {
                        const listItem = findAncestor(node.node, "ListItem");
                        const isTaskItem = listItem
                            ? hasDescendant(listItem, "TaskMarker")
                            : false;
                        const line = state.doc.lineAt(node.from);
                        if (hasCaretOnLine(state, node.from, node.to)) {
                            addLineDecoration(
                                lineDecos,
                                line.from,
                                "cm-lp-list-editing",
                                undefined,
                                {
                                    "--cm-lp-active-prefix": `${measureListPrefixWidth(line.text)}ch`,
                                },
                            );
                            return;
                        }
                        const indentWidth = measureIndent(
                            state.doc.sliceString(line.from, node.from),
                        );
                        const hideTo = extendPastFollowingWhitespace(
                            state,
                            node.to,
                        );

                        decos.push({
                            from: line.from,
                            to: hideTo,
                            deco: hideMark,
                        });

                        if (!isTaskItem) {
                            const ordered =
                                findAncestor(node.node, "OrderedList") !== null;
                            addLineDecoration(
                                lineDecos,
                                line.from,
                                ordered
                                    ? "cm-lp-li-ordered"
                                    : "cm-lp-li-unordered",
                                ordered
                                    ? {
                                          "data-lp-marker":
                                              state.doc.sliceString(
                                                  node.from,
                                                  node.to,
                                              ),
                                      }
                                    : undefined,
                                {
                                    "--cm-lp-indent": `${indentWidth}ch`,
                                },
                            );
                            addLineDecoration(
                                lineDecos,
                                line.from,
                                "cm-lp-li-line",
                                undefined,
                                {
                                    "--cm-lp-indent": `${indentWidth}ch`,
                                },
                            );
                        }
                    }

                    // --- BLOCKQUOTE ---
                    if (node.name === "Blockquote") {
                        decos.push({
                            from: node.from,
                            to: node.to,
                            deco: quoteContentMark,
                        });
                        if (!isLineActive(state, node.from, node.to)) {
                            // Hide QuoteMark (>) and the space after it
                            const cur = node.node.cursor();
                            if (cur.firstChild()) {
                                do {
                                    if (cur.name === "QuoteMark") {
                                        let end = cur.to;
                                        if (
                                            end < node.to &&
                                            state.doc.sliceString(
                                                end,
                                                end + 1,
                                            ) === " "
                                        ) {
                                            end++;
                                        }
                                        decos.push({
                                            from: cur.from,
                                            to: end,
                                            deco: hideMark,
                                        });
                                    }
                                } while (cur.nextSibling());
                            }
                        }
                    }

                    // --- STRIKETHROUGH ---
                    if (node.name === "Strikethrough") {
                        decos.push({
                            from: node.from,
                            to: node.to,
                            deco: strikethroughMark,
                        });
                        if (!isRangeActive(state, node.from, node.to)) {
                            hideChildMarks(
                                node.node,
                                "StrikethroughMark",
                                decos,
                            );
                        }
                    }

                    // --- FENCED CODE ---
                    if (node.name === "FencedCode") {
                        if (!isLineActive(state, node.from, node.to)) {
                            // Hide opening fence line (```lang) and closing fence (```)
                            const cur = node.node.cursor();
                            let openEnd = -1;
                            let closeFrom = -1;
                            if (cur.firstChild()) {
                                do {
                                    if (
                                        cur.name === "CodeMark" &&
                                        openEnd < 0
                                    ) {
                                        // First CodeMark = opening ```
                                        // Hide up to end of line (including newline)
                                        const line = state.doc.lineAt(cur.from);
                                        openEnd = Math.min(
                                            line.to + 1,
                                            node.to,
                                        );
                                    } else if (cur.name === "CodeMark") {
                                        // Subsequent CodeMark = closing ```
                                        closeFrom = cur.from;
                                    }
                                } while (cur.nextSibling());
                            }
                            if (openEnd > node.from) {
                                decos.push({
                                    from: node.from,
                                    to: openEnd,
                                    deco: hideMark,
                                });
                            }
                            if (closeFrom > 0 && closeFrom < node.to) {
                                // Include the newline before the closing fence
                                const hideFrom =
                                    closeFrom > 0 &&
                                    state.doc.sliceString(
                                        closeFrom - 1,
                                        closeFrom,
                                    ) === "\n"
                                        ? closeFrom - 1
                                        : closeFrom;
                                decos.push({
                                    from: hideFrom,
                                    to: node.to,
                                    deco: hideMark,
                                });
                            }
                        }
                    }

                    // --- TASK LISTS ---
                    if (node.name === "TaskMarker") {
                        if (hasCaretOnLine(state, node.from, node.to)) return;
                        const text = state.doc.sliceString(node.from, node.to);
                        const checked =
                            text.includes("x") || text.includes("X");
                        const line = state.doc.lineAt(node.from);
                        const indentWidth = measureLineLeadingIndent(line.text);
                        decos.push({
                            from: node.from,
                            to: extendPastFollowingWhitespace(state, node.to),
                            deco: hideMark,
                        });
                        addLineDecoration(
                            lineDecos,
                            line.from,
                            "cm-lp-task-line",
                            {
                                "data-lp-checked": checked ? "true" : "false",
                            },
                            {
                                "--cm-lp-indent": `${indentWidth}ch`,
                            },
                        );
                        if (checked) {
                            addLineDecoration(
                                lineDecos,
                                line.from,
                                "cm-lp-task-checked",
                            );
                        }
                    }
                },
            });

            // --- WIKILINKS [[target]] / [[target|alias]] ---
            // Wikilinks are regex-based (not in the Lezer tree), so we scan the viewport text
            const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;
            const vpText = state.doc.sliceString(vpFrom, vpTo);
            let wlMatch;
            while ((wlMatch = WIKILINK_RE.exec(vpText)) !== null) {
                const absFrom = vpFrom + wlMatch.index;
                const absTo = absFrom + wlMatch[0].length;
                if (!isRangeActive(state, absFrom, absTo)) {
                    const inner = wlMatch[1];
                    const pipeIdx = inner.indexOf("|");
                    if (pipeIdx >= 0) {
                        // [[target|alias]] → hide [[target| and ]]
                        decos.push({
                            from: absFrom,
                            to: absFrom + 2 + pipeIdx + 1,
                            deco: hideMark,
                        });
                    } else {
                        // [[target]] → hide [[ and ]]
                        decos.push({
                            from: absFrom,
                            to: absFrom + 2,
                            deco: hideMark,
                        });
                    }
                    decos.push({
                        from: absTo - 2,
                        to: absTo,
                        deco: hideMark,
                    });
                }
            }

            // --- HIGHLIGHT ==text== ---
            // Highlight is regex-based, same approach as wikilinks.
            const HIGHLIGHT_RE = /==(?=\S)([^\n]*?\S)==/g;
            let hlMatch;
            while ((hlMatch = HIGHLIGHT_RE.exec(vpText)) !== null) {
                const absFrom = vpFrom + hlMatch.index;
                const absTo = absFrom + hlMatch[0].length;
                if (isRangeActive(state, absFrom, absTo)) continue;

                decos.push({
                    from: absFrom,
                    to: absFrom + 2,
                    deco: hideMark,
                });
                decos.push({
                    from: absFrom + 2,
                    to: absTo - 2,
                    deco: highlightMark,
                });
                decos.push({
                    from: absTo - 2,
                    to: absTo,
                    deco: hideMark,
                });
            }

            const sortedLineDecos = [...lineDecos.entries()].sort(
                ([a], [b]) => a - b,
            );
            for (const [lineFrom, spec] of sortedLineDecos) {
                const style = Object.entries(spec.styles)
                    .map(([name, value]) => `${name}: ${value}`)
                    .join("; ");
                decos.push({
                    from: lineFrom,
                    to: lineFrom,
                    deco: Decoration.line({
                        attributes: {
                            ...spec.attrs,
                            class: [...spec.classes].join(" "),
                            ...(style ? { style } : {}),
                        },
                    }),
                });
            }

            // RangeSetBuilder requires decorations in document order
            decos.sort((a, b) => a.from - b.from || a.to - b.to);

            const builder = new RangeSetBuilder<Decoration>();
            for (const d of decos) {
                builder.add(d.from, d.to, d.deco);
            }
            return builder.finish();
        }
    },
    { decorations: (v) => v.decorations },
);

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const livePreviewTheme = EditorView.baseTheme({
    ".cm-lp-hidden": {
        display: "none",
    },
    ".cm-lp-h1": { fontSize: "1.8em", fontWeight: "700", lineHeight: "1.3" },
    ".cm-lp-h2": { fontSize: "1.5em", fontWeight: "600", lineHeight: "1.35" },
    ".cm-lp-h3": { fontSize: "1.25em", fontWeight: "600", lineHeight: "1.4" },
    ".cm-lp-h4": { fontSize: "1.1em", fontWeight: "600", lineHeight: "1.45" },
    ".cm-lp-h5": { fontSize: "1.05em", fontWeight: "600", lineHeight: "1.5" },
    ".cm-lp-h6": {
        fontSize: "1em",
        fontWeight: "600",
        lineHeight: "1.5",
        color: "var(--text-secondary)",
    },
    ".cm-lp-bold": { fontWeight: "700" },
    ".cm-lp-italic": { fontStyle: "italic" },
    ".cm-lp-code": {
        fontFamily:
            "ui-monospace, 'SF Mono', Monaco, 'Cascadia Code', monospace",
        fontSize: "0.9em",
        backgroundColor: "var(--bg-tertiary)",
        borderRadius: "3px",
        padding: "1px 4px",
    },
    ".cm-lp-strikethrough": { textDecoration: "line-through" },
    ".cm-lp-highlight": {
        backgroundColor:
            "color-mix(in srgb, var(--accent) 26%, rgb(255 235 130 / 0.9))",
        color: "var(--text-primary)",
        borderRadius: "3px",
        padding: "0 2px",
        boxDecorationBreak: "clone",
        WebkitBoxDecorationBreak: "clone",
    },
    ".cm-lp-link": {
        color: "var(--accent)",
        textDecoration: "underline",
        textDecorationStyle: "solid",
        textUnderlineOffset: "3px",
        cursor: "pointer",
    },
    ".cm-lp-blockquote": {
        borderLeft: "3px solid var(--accent)",
        paddingLeft: "12px",
        color: "var(--text-secondary)",
    },
    ".cm-lp-hr-line": {
        position: "relative",
        minHeight: "1.2em",
    },
    ".cm-lp-hr-line::before": {
        content: '""',
        position: "absolute",
        left: 0,
        right: 0,
        top: "50%",
        borderTop: "1px solid var(--border)",
        transform: "translateY(-50%)",
    },
    ".cm-lp-li-line, .cm-lp-task-line": {
        position: "relative",
        paddingLeft: "calc(var(--cm-lp-indent, 0ch) + 2.1em) !important",
    },
    ".cm-lp-list-editing": {
        paddingLeft: "var(--cm-lp-active-prefix, 0ch) !important",
        textIndent: "calc(-1 * var(--cm-lp-active-prefix, 0ch))",
    },
    ".cm-lp-li-line::before": {
        position: "absolute",
        left: "calc(var(--cm-lp-indent, 0ch) + 0.1em)",
        top: "0.02em",
        content: '"•"',
        color: "var(--text-secondary)",
        width: "1.45em",
        textAlign: "right",
        pointerEvents: "none",
        lineHeight: "inherit",
    },
    ".cm-lp-li-unordered::before": {
        content: '"•"',
        fontSize: "0.95em",
    },
    ".cm-lp-li-ordered::before": {
        content: "attr(data-lp-marker)",
        fontVariantNumeric: "tabular-nums",
        fontWeight: "600",
    },
    ".cm-lp-task-line::before": {
        position: "absolute",
        content: '""',
        width: "0.92em",
        height: "0.92em",
        left: "calc(var(--cm-lp-indent, 0ch) + 0.35em)",
        top: "0.3em",
        borderRadius: "0.22em",
        border: "1.5px solid color-mix(in srgb, var(--text-secondary) 40%, var(--border))",
        background:
            "color-mix(in srgb, var(--bg-primary) 96%, var(--bg-secondary))",
        boxSizing: "border-box",
        pointerEvents: "none",
    },
    ".cm-lp-task-line::after": {
        content: '""',
        position: "absolute",
        left: "calc(var(--cm-lp-indent, 0ch) + 0.64em)",
        top: "0.56em",
        width: "0.31em",
        height: "0.17em",
        borderLeft: "2px solid transparent",
        borderBottom: "2px solid transparent",
        transform: "rotate(-45deg)",
        pointerEvents: "none",
        opacity: 0,
    },
    ".cm-lp-task-checked": {
        color: "var(--text-secondary)",
    },
    ".cm-lp-task-checked::before": {
        borderColor: "color-mix(in srgb, var(--accent) 55%, var(--border))",
        background: "color-mix(in srgb, var(--accent) 12%, var(--bg-primary))",
    },
    ".cm-lp-task-checked::after": {
        borderLeftColor: "var(--accent)",
        borderBottomColor: "var(--accent)",
        opacity: 1,
    },
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const livePreviewExtension = [livePreviewPlugin, livePreviewTheme];
