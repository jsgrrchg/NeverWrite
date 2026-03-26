import {
    Decoration,
    type DecorationSet,
    EditorView,
    ViewPlugin,
    type ViewUpdate,
    WidgetType,
} from "@codemirror/view";
import {
    type EditorState,
    RangeSetBuilder,
    StateEffect,
    StateField,
} from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";

import {
    type DecoEntry,
    type LineDecoEntry,
    hideMark,
    hideInlineMark,
    hideInactiveChildMarks,
    parseLinkChildren,
    linkReferenceField,
    resolveLinkHref,
    findAncestor,
    hasDescendant,
    extendPastFollowingWhitespace,
    measureIndent,
    measureLineLeadingIndent,
    addLineDecoration,
} from "./livePreviewHelpers";
import {
    selectionTouchesLine,
    selectionTouchesRange,
} from "./selectionActivity";
import { parseMarkdownListItem } from "../markdownLists";
import { FRONTMATTER_RE } from "../noteTitleHelpers";
import { InlineMathWidget } from "./livePreviewBlocks";
import {
    perfCount,
    perfMeasure,
    perfNow,
} from "../../../app/utils/perfInstrumentation";

const headingMarks: Record<number, Decoration> = {
    1: Decoration.mark({ class: "cm-lp-h1" }),
    2: Decoration.mark({ class: "cm-lp-h2" }),
    3: Decoration.mark({ class: "cm-lp-h3" }),
    4: Decoration.mark({ class: "cm-lp-h4" }),
    5: Decoration.mark({ class: "cm-lp-h5" }),
    6: Decoration.mark({ class: "cm-lp-h6" }),
};

const boldMark = Decoration.mark({ class: "cm-lp-bold" });
const italicMark = Decoration.mark({ class: "cm-lp-italic" });
const inlineCodeMark = Decoration.mark({ class: "cm-lp-code" });
const strikethroughMark = Decoration.mark({ class: "cm-lp-strikethrough" });
const highlightMark = Decoration.mark({ class: "cm-lp-highlight" });
const subscriptMark = Decoration.mark({ class: "cm-lp-subscript" });
const superscriptMark = Decoration.mark({ class: "cm-lp-superscript" });
const quoteContentMark = Decoration.mark({ class: "cm-lp-blockquote" });

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;
const HIGHLIGHT_RE = /==(?=\S)([^\n]*?\S)==/g;
const LOOSE_UNORDERED_LIST_RE = /^([ \t]*)([-+*]|[•◦▪‣–—−])([ \t]+)/;
const FOOTNOTE_REF_RE = /\[\^([^\]\s]+)\]/g;
const INLINE_HTML_RE = /<(sub|sup|kbd)>([^<\n]+)<\/\1>/gi;
const INLINE_BR_RE = /<br\s*\/?>/gi;
const BLOCK_MATH_RE = /\$\$([\s\S]+?)\$\$/g;
const FOOTNOTE_DEF_RE = /^\[\^([^\]]+)\]:\s*(.*)$/;
const CALLOUT_RE = /^\s*>\s+\[!([a-zA-Z0-9-]+)\]([+-])?(?:\s+(.*))?$/;
const EXTENDED_TASK_RE = /^(\s*(?:[-+*]|\d+[.)])\s+)\[( |x|X|~|\/)\](\s+.*)?$/;
const UNORDERED_LIST_MARKER_WIDTH = "1.45em";
const TASK_LIST_MARKER_WIDTH = "1.2em";
const NARRATIVE_LIST_ITEM_THRESHOLD = 72;

// Characters that can affect markdown structure.  When an edit only involves
// characters NOT in this set we can skip the full decoration rebuild and simply
// map existing decorations through the position changes.
const MARKDOWN_SIGNIFICANT = /(?:[!#$()*+./:<=>\\\]^_`{|}~\n\r-]|\[)/;
const MAX_STYLED_LIST_LEVEL = 3;

type LivePreviewNode = {
    name: string;
    from: number;
    to: number;
    node: SyntaxNode;
};

interface BuildContext {
    state: EditorState;
    decos: DecoEntry[];
    lineDecos: Map<number, LineDecoEntry>;
    blockRanges: Array<{ from: number; to: number }>;
    orderedListMarkerWidths: Map<string, string>;
    linkReferences: Map<string, { url: string; title: string | null }>;
    vpFrom: number;
    vpTo: number;
    vpText: string;
    revealSensitiveRanges: RevealSensitiveRange[];
    revealSensitiveRangeKeys: Set<string>;
}

type NodeRule = (node: LivePreviewNode, context: BuildContext) => void;
type RegexRule = (
    match: RegExpExecArray,
    absFrom: number,
    absTo: number,
    context: BuildContext,
) => void;

type ListItemPresentation = {
    densityClass: string;
    levelClass: string;
    lineStyles: Record<string, string>;
    markerLineNumber: number;
};

type RevealSensitiveRange = {
    key: string;
    from: number;
    to: number;
    strategy: "line" | "range";
};

class InlineBreakWidget extends WidgetType {
    toDOM() {
        return document.createElement("br");
    }
}

function createMathMark(display: "inline" | "block") {
    return Decoration.mark({
        class: display === "block" ? "cm-lp-math-block" : "cm-lp-math-inline",
    });
}

function getHeadingLevel(nodeName: string): number | null {
    if (nodeName.startsWith("ATXHeading")) {
        return parseInt(nodeName.slice(10), 10);
    }
    if (nodeName === "SetextHeading1") return 1;
    if (nodeName === "SetextHeading2") return 2;
    return null;
}

function getOrderedListCacheKey(node: SyntaxNode): string {
    return `${node.from}:${node.to}`;
}

function getOrderedListReservedMarkerWidth(
    listNode: SyntaxNode,
    state: EditorState,
    cache: Map<string, string>,
): string {
    const cacheKey = getOrderedListCacheKey(listNode);
    const cachedWidth = cache.get(cacheKey);
    if (cachedWidth) return cachedWidth;

    let maxWidth = 2.2;
    const cursor = listNode.cursor();

    if (cursor.firstChild()) {
        do {
            if (cursor.name !== "ListItem") continue;
            const itemCursor = cursor.node.cursor();
            if (!itemCursor.firstChild()) continue;

            do {
                if (itemCursor.name !== "ListMark") continue;
                const marker = state.doc.sliceString(
                    itemCursor.from,
                    itemCursor.to,
                );
                const normalizedMarker = marker.trim();
                maxWidth = Math.max(
                    maxWidth,
                    measureIndent(normalizedMarker) + 0.35,
                );
                break;
            } while (itemCursor.nextSibling());
        } while (cursor.nextSibling());
    }

    const width = `${maxWidth}ch`;
    cache.set(cacheKey, width);
    return width;
}

function getListDensityClass(content: string): string {
    return content.trim().length >= NARRATIVE_LIST_ITEM_THRESHOLD
        ? "cm-lp-list-narrative"
        : "cm-lp-list-dense";
}

function getListLevel(node: SyntaxNode): number {
    let level = 0;
    let current: SyntaxNode | null = node;

    while (current) {
        if (current.name === "BulletList" || current.name === "OrderedList") {
            level++;
        }
        current = current.parent;
    }

    return Math.max(level, 1);
}

function getListLevelClass(level: number): string {
    return `cm-lp-list-level-${Math.min(level, MAX_STYLED_LIST_LEVEL)}`;
}

function getLooseListLevel(indentWidth: number): number {
    return Math.min(Math.floor(indentWidth / 4) + 1, MAX_STYLED_LIST_LEVEL);
}

function isListLikeLine(text: string): boolean {
    return /^(\s*)(?:[-+*]|\d+[.)]|\[[ xX]\]|[•◦▪‣–—−])\s+/.test(text);
}

function hasAdjacentListContext(
    state: EditorState,
    lineNumber: number,
): boolean {
    for (let current = lineNumber - 1; current >= 1; current--) {
        const line = state.doc.line(current);
        if (line.text.trim().length === 0) continue;
        return isListLikeLine(line.text);
    }

    for (let current = lineNumber + 1; current <= state.doc.lines; current++) {
        const line = state.doc.line(current);
        if (line.text.trim().length === 0) continue;
        return isListLikeLine(line.text);
    }

    return false;
}

function lineHasListDecoration(
    lineDecos: Map<number, LineDecoEntry>,
    lineFrom: number,
): boolean {
    const entry = lineDecos.get(lineFrom);
    if (!entry) return false;
    return (
        entry.classes.has("cm-lp-li-line") ||
        entry.classes.has("cm-lp-task-line") ||
        entry.classes.has("cm-lp-list-continuation")
    );
}

function lineHasPrimaryListDecoration(
    lineDecos: Map<number, LineDecoEntry>,
    lineFrom: number,
): boolean {
    const entry = lineDecos.get(lineFrom);
    if (!entry) return false;
    return (
        entry.classes.has("cm-lp-li-line") ||
        entry.classes.has("cm-lp-task-line")
    );
}

function isActiveEmptyListLine(
    state: EditorState,
    lineFrom: number,
    lineTo: number,
) {
    if (!selectionTouchesLine(state, lineFrom, lineTo)) return false;
    const item = parseMarkdownListItem(state.doc.sliceString(lineFrom, lineTo));
    return item?.isEmpty === true;
}

function getListItemPresentation(
    listItem: SyntaxNode,
    state: EditorState,
    orderedListMarkerWidths: Map<string, string>,
): ListItemPresentation | null {
    const cursor = listItem.cursor();
    let listMarkNode: SyntaxNode | null = null;
    let taskMarkerNode: SyntaxNode | null = null;

    if (cursor.firstChild()) {
        do {
            if (cursor.name === "ListMark") {
                listMarkNode = cursor.node;
                continue;
            }

            if (cursor.name !== "Task") continue;
            const taskCursor = cursor.node.cursor();
            if (!taskCursor.firstChild()) continue;

            do {
                if (taskCursor.name === "TaskMarker") {
                    taskMarkerNode = taskCursor.node;
                    break;
                }
            } while (taskCursor.nextSibling());
        } while (cursor.nextSibling());
    }

    const markerNode = taskMarkerNode ?? listMarkNode;
    if (!markerNode) return null;

    const markerLine = state.doc.lineAt(markerNode.from);
    const orderedList = findAncestor(listItem, "OrderedList");
    const densityClass = getListDensityClass(
        state.doc.sliceString(markerNode.to, listItem.to),
    );
    const levelClass = getListLevelClass(getListLevel(listItem));
    const lineStyles = taskMarkerNode
        ? {
              "--cm-lp-indent": `${measureLineLeadingIndent(markerLine.text)}ch`,
              "--cm-lp-marker-width": TASK_LIST_MARKER_WIDTH,
          }
        : {
              "--cm-lp-indent": `${measureIndent(
                  state.doc.sliceString(
                      markerLine.from,
                      listMarkNode?.from ?? markerLine.from,
                  ),
              )}ch`,
              "--cm-lp-marker-width": orderedList
                  ? getOrderedListReservedMarkerWidth(
                        orderedList,
                        state,
                        orderedListMarkerWidths,
                    )
                  : UNORDERED_LIST_MARKER_WIDTH,
          };

    return {
        densityClass,
        levelClass,
        lineStyles,
        markerLineNumber: markerLine.number,
    };
}

function applyListContinuationLines(
    blockNode: SyntaxNode,
    listItem: SyntaxNode,
    context: BuildContext,
) {
    const presentation = getListItemPresentation(
        listItem,
        context.state,
        context.orderedListMarkerWidths,
    );
    if (!presentation) return;

    const startLine = context.state.doc.lineAt(blockNode.from).number;
    const endLine = context.state.doc.lineAt(blockNode.to).number;

    for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
        if (
            lineNumber === presentation.markerLineNumber &&
            blockNode.from >= context.state.doc.line(lineNumber).from
        ) {
            continue;
        }

        const line = context.state.doc.line(lineNumber);
        if (lineHasListDecoration(context.lineDecos, line.from)) continue;

        const leadingWhitespace = line.text.match(/^\s*/)?.[0] ?? "";
        const hideTo = line.from + leadingWhitespace.length;

        if (hideTo > line.from) {
            hideRangeUnlessEditing(context, line.from, hideTo, hideMark);
        }

        addLineDecoration(
            context.lineDecos,
            line.from,
            "cm-lp-list-continuation",
            undefined,
            presentation.lineStyles,
        );
        addLineDecoration(
            context.lineDecos,
            line.from,
            presentation.densityClass,
        );
        addLineDecoration(
            context.lineDecos,
            line.from,
            presentation.levelClass,
        );
    }
}

function isLeadingDocumentHeading(state: EditorState, from: number): boolean {
    const before = state.doc.sliceString(0, from);
    const withoutFrontmatter = before.replace(FRONTMATTER_RE, "");
    return withoutFrontmatter.trim().length === 0;
}

function getLeadingHeadingHideTo(
    state: EditorState,
    headingTo: number,
): number {
    const headingLine = state.doc.lineAt(headingTo);
    const nextLineNumber = headingLine.number + 1;
    if (nextLineNumber > state.doc.lines) {
        return headingLine.to;
    }

    const nextLine = state.doc.line(nextLineNumber);
    if (nextLine.text.trim().length === 0) {
        return nextLine.to;
    }

    return headingLine.to;
}

function applyFrontmatterHiding(context: BuildContext) {
    const docText = context.state.doc.sliceString(0, context.state.doc.length);
    const fmMatch = docText.match(FRONTMATTER_RE);
    if (!fmMatch) return;

    const fmFrom = 0;
    let fmTo = fmMatch[0].length;

    // Extend past trailing blank line (like getLeadingHeadingHideTo)
    const fmEndLine = context.state.doc.lineAt(fmTo > 0 ? fmTo - 1 : 0);
    const nextLineNumber = fmEndLine.number + 1;
    if (nextLineNumber <= context.state.doc.lines) {
        const nextLine = context.state.doc.line(nextLineNumber);
        if (nextLine.text.trim().length === 0) {
            fmTo = nextLine.to;
        }
    }

    registerRevealSensitiveRange(context, "line", fmFrom, fmTo);
    if (!selectionTouchesLine(context.state, fmFrom, fmTo)) {
        hideRange(context, fmFrom, fmTo);
    }
}

function pushDeco(
    context: BuildContext,
    from: number,
    to: number,
    deco: Decoration,
) {
    context.decos.push({ from, to, deco });
}

function hideRange(
    context: BuildContext,
    from: number,
    to: number,
    deco: Decoration = hideMark,
) {
    if (from >= to) return;
    pushDeco(context, from, to, deco);
}

function registerRevealSensitiveRange(
    context: BuildContext,
    strategy: RevealSensitiveRange["strategy"],
    from: number,
    to: number,
) {
    if (from >= to) return;

    const key = `${strategy}:${from}:${to}`;
    if (context.revealSensitiveRangeKeys.has(key)) return;

    context.revealSensitiveRangeKeys.add(key);
    context.revealSensitiveRanges.push({
        key,
        from,
        to,
        strategy,
    });
}

function hideRangeUnlessEditing(
    context: BuildContext,
    from: number,
    to: number,
    deco: Decoration = hideMark,
) {
    if (from >= to) return;
    registerRevealSensitiveRange(context, "line", from, to);
    if (!selectionTouchesLine(context.state, from, to)) {
        pushDeco(context, from, to, deco);
    }
}

function hideRangeUnlessTokenActive(
    context: BuildContext,
    from: number,
    to: number,
    activeFrom: number,
    activeTo: number,
    deco: Decoration = hideMark,
) {
    if (from >= to) return;
    registerRevealSensitiveRange(context, "range", activeFrom, activeTo);
    if (!selectionTouchesRange(context.state, activeFrom, activeTo)) {
        pushDeco(context, from, to, deco);
    }
}

function getRevealSensitiveSignature(
    state: EditorState,
    ranges: readonly RevealSensitiveRange[],
) {
    if (!ranges.length) return "";

    const activeKeys: string[] = [];

    for (const range of ranges) {
        const active =
            range.strategy === "line"
                ? selectionTouchesLine(state, range.from, range.to)
                : selectionTouchesRange(state, range.from, range.to);

        if (active) {
            activeKeys.push(range.key);
        }
    }

    return activeKeys.join("|");
}

function addLineClassForRange(
    context: BuildContext,
    from: number,
    to: number,
    className: string,
    attrs?: Record<string, string>,
    styles?: Record<string, string>,
) {
    const startLine = context.state.doc.lineAt(from).number;
    const endLine = context.state.doc.lineAt(to).number;

    for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
        const line = context.state.doc.line(lineNumber);
        addLineDecoration(
            context.lineDecos,
            line.from,
            className,
            attrs,
            styles,
        );
    }
}

function createInlineFormattingRule(
    nodeName: string,
    mark: Decoration,
    markerName: string,
): NodeRule {
    return (node, context) => {
        if (node.name !== nodeName) return;
        registerRevealSensitiveRange(context, "range", node.from, node.to);
        pushDeco(context, node.from, node.to, mark);
        hideInactiveChildMarks(
            node.node,
            markerName,
            node.from,
            node.to,
            context.state,
            context.decos,
            hideInlineMark,
        );
    };
}

const headingRule: NodeRule = (node, context) => {
    const headingLevel = getHeadingLevel(node.name);
    if (headingLevel === null) return;

    registerRevealSensitiveRange(context, "line", node.from, node.to);
    if (selectionTouchesLine(context.state, node.from, node.to)) {
        return;
    }

    if (
        headingLevel === 1 &&
        isLeadingDocumentHeading(context.state, node.from)
    ) {
        const hideTo = getLeadingHeadingHideTo(context.state, node.to);
        hideRange(context, node.from, hideTo);
        return;
    }

    const isSetext = node.name.startsWith("SetextHeading");

    // Collect header marks in a single pass
    const headerMarks: Array<{ from: number; to: number }> = [];
    const childCursor = node.node.cursor();
    if (childCursor.firstChild()) {
        do {
            if (childCursor.name === "HeaderMark") {
                headerMarks.push({
                    from: childCursor.from,
                    to: childCursor.to,
                });
            }
        } while (childCursor.nextSibling());
    }

    // For setext headings, don't apply heading style while editing the
    // underline.  This prevents the paragraph from suddenly becoming an h2
    // when the user types "-" to start a list below it.
    let editingUnderline = false;
    if (isSetext) {
        editingUnderline = headerMarks.some((markRange) => {
            registerRevealSensitiveRange(
                context,
                "line",
                markRange.from,
                markRange.to,
            );
            return selectionTouchesLine(
                context.state,
                markRange.from,
                markRange.to,
            );
        });
    }

    if (!editingUnderline) {
        const mark = headingMarks[headingLevel];
        if (mark) {
            pushDeco(context, node.from, node.to, mark);
        }
    }

    for (const hm of headerMarks) {
        let hideFrom = hm.from;
        let hideTo = hm.to;

        if (node.name.startsWith("ATXHeading")) {
            if (
                hideTo < node.to &&
                context.state.doc.sliceString(hideTo, hideTo + 1) === " "
            ) {
                hideTo++;
            }
        }

        if (
            isSetext &&
            hideFrom > node.from &&
            context.state.doc.sliceString(hideFrom - 1, hideFrom) === "\n"
        ) {
            hideFrom--;
        }

        hideRange(context, hideFrom, hideTo);
    }
};

const linkRule: NodeRule = (node, context) => {
    if (node.name !== "Link" && node.name !== "Autolink") return;

    const info = parseLinkChildren(node.node, context.state);
    if (!info) return;

    const href = resolveLinkHref(info, context.linkReferences);
    if (!href) return;

    const linkMark = Decoration.mark({
        class: "cm-lp-link",
        attributes: {
            "data-href": href,
            tabindex: "0",
            role: "link",
            ...(info.title ? { title: info.title } : {}),
        },
    });

    pushDeco(context, info.textFrom, info.textTo, linkMark);
    hideRangeUnlessTokenActive(
        context,
        node.from,
        info.textFrom,
        node.from,
        node.to,
        hideMark,
    );
    hideRangeUnlessTokenActive(
        context,
        info.textTo,
        node.to,
        node.from,
        node.to,
        hideMark,
    );
};

const horizontalRuleRule: NodeRule = (node, context) => {
    if (node.name !== "HorizontalRule") return;

    const line = context.state.doc.lineAt(node.from);
    hideRange(context, line.from, line.to);
    registerRevealSensitiveRange(context, "line", line.from, line.to);
    if (!selectionTouchesLine(context.state, line.from, line.to)) {
        addLineDecoration(context.lineDecos, line.from, "cm-lp-hr-line");
    }
};

const listMarkRule: NodeRule = (node, context) => {
    if (node.name !== "ListMark") return;

    const listItem = findAncestor(node.node, "ListItem");
    const isTaskItem = listItem ? hasDescendant(listItem, "TaskMarker") : false;
    const line = context.state.doc.lineAt(node.from);
    const hideTo = extendPastFollowingWhitespace(context.state, node.to);
    const activeEmptyItem = isActiveEmptyListLine(
        context.state,
        line.from,
        line.to,
    );

    hideRange(context, line.from, activeEmptyItem ? node.to : hideTo);

    if (isTaskItem) return;

    const orderedList = findAncestor(node.node, "OrderedList");
    const ordered = orderedList !== null;
    const markerText = context.state.doc.sliceString(node.from, node.to);
    const indentWidth = measureIndent(
        context.state.doc.sliceString(line.from, node.from),
    );
    const densityClass = getListDensityClass(
        context.state.doc.sliceString(hideTo, line.to),
    );
    const levelClass = getListLevelClass(getListLevel(node.node));
    const lineStyles = {
        "--cm-lp-indent": `${indentWidth}ch`,
        "--cm-lp-marker-width": ordered
            ? getOrderedListReservedMarkerWidth(
                  orderedList,
                  context.state,
                  context.orderedListMarkerWidths,
              )
            : UNORDERED_LIST_MARKER_WIDTH,
    };

    addLineDecoration(
        context.lineDecos,
        line.from,
        ordered ? "cm-lp-li-ordered" : "cm-lp-li-unordered",
        {
            ...(ordered
                ? {
                      "data-lp-marker": markerText,
                  }
                : {}),
        },
        lineStyles,
    );
    addLineDecoration(
        context.lineDecos,
        line.from,
        "cm-lp-li-line",
        undefined,
        lineStyles,
    );
    addLineDecoration(context.lineDecos, line.from, densityClass);
    addLineDecoration(context.lineDecos, line.from, levelClass);
};

const blockquoteRule: NodeRule = (node, context) => {
    if (node.name !== "Blockquote") return;

    const firstLine = context.state.doc.lineAt(node.from);
    if (CALLOUT_RE.test(firstLine.text)) return;

    // Calculate nesting level
    let level = 0;
    let cur: SyntaxNode | null = node.node;
    while (cur) {
        if (cur.name === "Blockquote") level++;
        cur = cur.parent;
    }

    if (level === 1) {
        // Outermost blockquote: text styling + border line
        pushDeco(context, node.from, node.to, quoteContentMark);
        addLineClassForRange(
            context,
            node.from,
            node.to,
            "cm-lp-blockquote-line",
        );
    } else {
        // Nested: add level class (border via pseudo-elements in CSS)
        addLineClassForRange(
            context,
            node.from,
            node.to,
            `cm-lp-blockquote-level-${Math.min(level, 3)}`,
        );
    }

    // Hide QuoteMarks for all levels
    const cursor = node.node.cursor();
    if (!cursor.firstChild()) return;

    do {
        if (cursor.name !== "QuoteMark") continue;

        let hideTo = cursor.to;
        if (
            hideTo < node.to &&
            context.state.doc.sliceString(hideTo, hideTo + 1) === " "
        ) {
            hideTo++;
        }

        hideRange(context, cursor.from, hideTo);
    } while (cursor.nextSibling());
};

const fencedCodeRule: NodeRule = (node, context) => {
    if (node.name !== "FencedCode") return;

    const cursor = node.node.cursor();
    let openEnd = -1;
    let closeFrom = -1;

    if (cursor.firstChild()) {
        do {
            if (cursor.name !== "CodeMark") continue;

            if (openEnd < 0) {
                const line = context.state.doc.lineAt(cursor.from);
                openEnd = Math.min(line.to + 1, node.to);
                continue;
            }

            closeFrom = cursor.from;
        } while (cursor.nextSibling());
    }

    if (openEnd > node.from) {
        hideRange(context, node.from, openEnd);
    }

    if (closeFrom >= 0 && closeFrom < node.to) {
        const hideFrom =
            closeFrom > 0 &&
            context.state.doc.sliceString(closeFrom - 1, closeFrom) === "\n"
                ? closeFrom - 1
                : closeFrom;
        hideRange(context, hideFrom, node.to);
    }
};

const taskMarkerRule: NodeRule = (node, context) => {
    if (node.name !== "TaskMarker") return;

    const prefixEnd = extendPastFollowingWhitespace(context.state, node.to);
    const text = context.state.doc.sliceString(node.from, node.to);
    const checked = text.includes("x") || text.includes("X");
    const line = context.state.doc.lineAt(node.from);
    const indentWidth = measureLineLeadingIndent(line.text);
    const activeEmptyItem = isActiveEmptyListLine(
        context.state,
        line.from,
        line.to,
    );
    const densityClass = getListDensityClass(
        context.state.doc.sliceString(prefixEnd, line.to),
    );
    const levelClass = getListLevelClass(getListLevel(node.node));

    hideRange(context, node.from, activeEmptyItem ? node.to : prefixEnd);
    addLineDecoration(
        context.lineDecos,
        line.from,
        "cm-lp-task-line",
        {
            "data-lp-checked": checked ? "true" : "false",
            "data-lp-task-state": checked ? "done" : "open",
            "data-lp-task-from": String(line.from),
            "data-lp-task-marker": checked ? "x" : " ",
            tabindex: "0",
            role: "checkbox",
            "aria-checked": checked ? "true" : "false",
        },
        {
            "--cm-lp-indent": `${indentWidth}ch`,
            "--cm-lp-marker-width": TASK_LIST_MARKER_WIDTH,
        },
    );
    addLineDecoration(context.lineDecos, line.from, densityClass);
    addLineDecoration(context.lineDecos, line.from, levelClass);

    if (checked) {
        addLineDecoration(context.lineDecos, line.from, "cm-lp-task-checked");
    }
};

const listContinuationRule: NodeRule = (node, context) => {
    if (node.name !== "Paragraph" && node.name !== "Task") return;

    const listItem = findAncestor(node.node, "ListItem");
    if (!listItem) return;

    applyListContinuationLines(node.node, listItem, context);
};

const nodeRules: NodeRule[] = [
    headingRule,
    createInlineFormattingRule("StrongEmphasis", boldMark, "EmphasisMark"),
    createInlineFormattingRule("Emphasis", italicMark, "EmphasisMark"),
    createInlineFormattingRule("InlineCode", inlineCodeMark, "CodeMark"),
    createInlineFormattingRule("Subscript", subscriptMark, "SubscriptMark"),
    createInlineFormattingRule(
        "Superscript",
        superscriptMark,
        "SuperscriptMark",
    ),
    linkRule,
    horizontalRuleRule,
    listMarkRule,
    blockquoteRule,
    createInlineFormattingRule(
        "Strikethrough",
        strikethroughMark,
        "StrikethroughMark",
    ),
    fencedCodeRule,
    taskMarkerRule,
    listContinuationRule,
];

const regexRules: Array<{
    pattern: RegExp;
    apply: RegexRule;
}> = [
    {
        pattern: WIKILINK_RE,
        apply(match, absFrom, absTo, context) {
            const inner = match[1];
            const pipeIndex = inner.indexOf("|");

            if (pipeIndex >= 0) {
                hideRangeUnlessTokenActive(
                    context,
                    absFrom,
                    absFrom + 2 + pipeIndex + 1,
                    absFrom,
                    absTo,
                    hideInlineMark,
                );
            } else {
                hideRangeUnlessTokenActive(
                    context,
                    absFrom,
                    absFrom + 2,
                    absFrom,
                    absTo,
                    hideInlineMark,
                );
            }

            hideRangeUnlessTokenActive(
                context,
                absTo - 2,
                absTo,
                absFrom,
                absTo,
                hideInlineMark,
            );
        },
    },
    {
        pattern: HIGHLIGHT_RE,
        apply(_match, absFrom, absTo, context) {
            hideRangeUnlessTokenActive(
                context,
                absFrom,
                absFrom + 2,
                absFrom,
                absTo,
                hideInlineMark,
            );
            pushDeco(context, absFrom + 2, absTo - 2, highlightMark);
            hideRangeUnlessTokenActive(
                context,
                absTo - 2,
                absTo,
                absFrom,
                absTo,
                hideInlineMark,
            );
        },
    },
];

function applyNodeRules(context: BuildContext) {
    const tree = syntaxTree(context.state);

    tree.iterate({
        from: context.vpFrom,
        to: context.vpTo,
        enter(node) {
            if (node.name === "Table" || node.name === "FencedCode") {
                context.blockRanges.push({ from: node.from, to: node.to });
                if (node.name === "Table") return false;
            }
            if (node.name === "InlineCode") {
                context.blockRanges.push({ from: node.from, to: node.to });
            }

            const liveNode: LivePreviewNode = {
                name: node.name,
                from: node.from,
                to: node.to,
                node: node.node,
            };

            for (const rule of nodeRules) {
                rule(liveNode, context);
            }
        },
    });
}

function rangeOverlapsBlock(context: BuildContext, from: number, to: number) {
    return context.blockRanges.some(
        (range) => to >= range.from && from <= range.to,
    );
}

function applyRegexRules(context: BuildContext) {
    for (const { pattern, apply } of regexRules) {
        pattern.lastIndex = 0;

        let match: RegExpExecArray | null;
        while ((match = pattern.exec(context.vpText)) !== null) {
            const absFrom = context.vpFrom + match.index;
            const absTo = absFrom + match[0].length;
            if (rangeOverlapsBlock(context, absFrom, absTo)) {
                continue;
            }
            apply(match, absFrom, absTo, context);
        }
    }
}

function applyLooseListFallback(context: BuildContext) {
    const startLine = context.state.doc.lineAt(context.vpFrom).number;
    const endLine = context.state.doc.lineAt(context.vpTo).number;

    for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
        const line = context.state.doc.line(lineNumber);
        if (lineHasPrimaryListDecoration(context.lineDecos, line.from)) {
            continue;
        }

        const match = line.text.match(LOOSE_UNORDERED_LIST_RE);
        if (!match) continue;

        const [, indent, marker, spacing] = match;
        const indentWidth = measureIndent(indent);
        const requiresListContext =
            marker === "-" ||
            marker === "+" ||
            marker === "*" ||
            marker === "–" ||
            marker === "—" ||
            marker === "−";
        const shouldTreatAsList = !requiresListContext
            ? true
            : indentWidth > 0 &&
              hasAdjacentListContext(context.state, line.number);

        if (!shouldTreatAsList) continue;

        const markerFrom = line.from + indent.length;
        const hideTo = markerFrom + marker.length + spacing.length;

        hideRange(context, line.from, hideTo);

        addLineDecoration(
            context.lineDecos,
            line.from,
            "cm-lp-li-unordered",
            undefined,
            {
                "--cm-lp-indent": `${indentWidth}ch`,
                "--cm-lp-marker-width": UNORDERED_LIST_MARKER_WIDTH,
            },
        );
        addLineDecoration(
            context.lineDecos,
            line.from,
            "cm-lp-li-line",
            undefined,
            {
                "--cm-lp-indent": `${indentWidth}ch`,
                "--cm-lp-marker-width": UNORDERED_LIST_MARKER_WIDTH,
            },
        );
        addLineDecoration(
            context.lineDecos,
            line.from,
            getListDensityClass(line.text.slice(match[0].length)),
        );
        addLineDecoration(
            context.lineDecos,
            line.from,
            getListLevelClass(getLooseListLevel(indentWidth)),
        );
    }
}

export const toggleCalloutFold = StateEffect.define<number>();

export const calloutFoldState = StateField.define<Map<number, boolean>>({
    create: () => new Map(),
    update(folds, tr) {
        if (!tr.docChanged && tr.effects.length === 0) return folds;

        let result = folds;
        if (tr.docChanged) {
            const newFolds = new Map<number, boolean>();
            for (const [pos, collapsed] of folds) {
                const mapped = tr.changes.mapPos(pos, 1);
                newFolds.set(mapped, collapsed);
            }
            result = newFolds;
        }
        for (const effect of tr.effects) {
            if (effect.is(toggleCalloutFold)) {
                if (result === folds) result = new Map(folds);
                const current = result.get(effect.value) ?? false;
                result.set(effect.value, !current);
            }
        }
        return result;
    },
});

const CALLOUT_ALIASES: Record<string, string> = {
    info: "note",
    check: "success",
    done: "success",
    faq: "question",
    help: "question",
    cite: "quote",
    tldr: "abstract",
    summary: "abstract",
};

function normalizeCalloutType(type: string): string {
    const normalized = type.trim().toLowerCase();
    return CALLOUT_ALIASES[normalized] ?? normalized;
}

function applyCalloutDecorations(context: BuildContext) {
    const startLine = context.state.doc.lineAt(context.vpFrom).number;
    const endLine = context.state.doc.lineAt(context.vpTo).number;
    const folds = context.state.field(calloutFoldState, false);

    for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
        const line = context.state.doc.line(lineNumber);
        const match = line.text.match(CALLOUT_RE);
        if (!match) continue;

        const calloutType = normalizeCalloutType(match[1]);
        const foldMarker = match[2] as "+" | "-" | undefined;
        const markerStart = line.text.indexOf("[!");
        const markerEnd = line.text.indexOf("]", markerStart);
        if (markerStart < 0 || markerEnd < 0) continue;

        let blockEnd = lineNumber;
        while (blockEnd < context.state.doc.lines) {
            const nextLine = context.state.doc.line(blockEnd + 1);
            if (!nextLine || !/^\s*>/.test(nextLine.text)) break;
            blockEnd++;
        }

        const isCollapsible = foldMarker === "+" || foldMarker === "-";
        const defaultCollapsed = foldMarker === "-";
        const isCollapsed = isCollapsible
            ? (folds?.get(line.from) ?? defaultCollapsed)
            : false;

        addLineClassForRange(
            context,
            line.from,
            context.state.doc.line(blockEnd).to,
            "cm-lp-callout",
            {
                "data-callout-type": calloutType,
            },
        );
        addLineDecoration(context.lineDecos, line.from, "cm-lp-callout-head");
        addLineDecoration(
            context.lineDecos,
            line.from,
            `cm-lp-callout-${calloutType}`,
        );

        if (isCollapsible) {
            addLineDecoration(
                context.lineDecos,
                line.from,
                "cm-lp-callout-collapsible",
                {
                    "data-callout-from": String(line.from),
                    "data-callout-collapsed": isCollapsed ? "true" : "false",
                },
            );
        }

        let absoluteMarkerTo = line.from + markerEnd + 1;
        if (match[2]) {
            absoluteMarkerTo += match[2].length;
        }
        if (
            absoluteMarkerTo < line.to &&
            context.state.doc.sliceString(
                absoluteMarkerTo,
                absoluteMarkerTo + 1,
            ) === " "
        ) {
            absoluteMarkerTo++;
        }
        hideRange(context, line.from, absoluteMarkerTo);

        for (
            let currentLineNumber = lineNumber + 1;
            currentLineNumber <= blockEnd;
            currentLineNumber++
        ) {
            const currentLine = context.state.doc.line(currentLineNumber);
            const quotePrefix = currentLine.text.match(/^\s*>\s?/);
            if (!quotePrefix || quotePrefix[0].length === 0) continue;

            hideRange(
                context,
                currentLine.from,
                currentLine.from + quotePrefix[0].length,
            );
        }

        // Hide body lines when collapsed
        if (isCollapsed && blockEnd > lineNumber) {
            const bodyFrom = context.state.doc.line(lineNumber + 1).from - 1;
            const bodyTo = context.state.doc.line(blockEnd).to;
            if (bodyFrom < bodyTo) {
                registerRevealSensitiveRange(context, "line", bodyFrom, bodyTo);
            }
            if (
                bodyFrom < bodyTo &&
                !selectionTouchesLine(context.state, bodyFrom, bodyTo)
            ) {
                pushDeco(context, bodyFrom, bodyTo, Decoration.replace({}));
            }
        }
    }
}

function applyFootnoteDefinitionDecorations(context: BuildContext) {
    const startLine = context.state.doc.lineAt(context.vpFrom).number;
    const endLine = context.state.doc.lineAt(context.vpTo).number;

    for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
        const line = context.state.doc.line(lineNumber);
        const match = line.text.match(FOOTNOTE_DEF_RE);
        if (!match) continue;

        const label = match[1];
        const marker = `[^${label}]:`;
        const markerTo = line.from + marker.length;

        addLineDecoration(context.lineDecos, line.from, "cm-lp-footnote-def", {
            "data-footnote-id": label,
        });
        hideRange(context, line.from, markerTo);
        if (
            markerTo < line.to &&
            context.state.doc.sliceString(markerTo, markerTo + 1) === " "
        ) {
            hideRange(context, markerTo, markerTo + 1);
        }

        let continuation = lineNumber + 1;
        while (continuation <= context.state.doc.lines) {
            const nextLine = context.state.doc.line(continuation);
            if (!nextLine.text.trim()) {
                addLineDecoration(
                    context.lineDecos,
                    nextLine.from,
                    "cm-lp-footnote-def",
                    { "data-footnote-id": label },
                );
                continuation++;
                continue;
            }
            if (!/^[ \t]{2,}|^\t/.test(nextLine.text)) break;
            addLineDecoration(
                context.lineDecos,
                nextLine.from,
                "cm-lp-footnote-def",
                { "data-footnote-id": label },
            );
            continuation++;
        }
    }
}

function applyExtendedTaskFallback(context: BuildContext) {
    const startLine = context.state.doc.lineAt(context.vpFrom).number;
    const endLine = context.state.doc.lineAt(context.vpTo).number;

    for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
        const line = context.state.doc.line(lineNumber);
        if (lineHasPrimaryListDecoration(context.lineDecos, line.from)) {
            continue;
        }

        const match = line.text.match(EXTENDED_TASK_RE);
        if (!match) continue;

        const markerState = match[2];
        if (markerState !== "~" && markerState !== "/") continue;

        const prefix = match[1];
        const markerStart = line.from + prefix.length;
        const markerEnd = markerStart + 3;
        const indentWidth = measureLineLeadingIndent(line.text);
        const taskState = "partial";

        hideRange(context, line.from, Math.min(line.to, markerEnd + 1));

        addLineDecoration(
            context.lineDecos,
            line.from,
            "cm-lp-task-line",
            {
                "data-lp-task-state": taskState,
                "data-lp-task-from": String(line.from),
                "data-lp-task-marker": markerState,
                tabindex: "0",
                role: "checkbox",
                "aria-checked": "mixed",
            },
            {
                "--cm-lp-indent": `${indentWidth}ch`,
                "--cm-lp-marker-width": TASK_LIST_MARKER_WIDTH,
            },
        );
        addLineDecoration(context.lineDecos, line.from, "cm-lp-task-partial");
    }
}

function applyRichRegexRules(context: BuildContext) {
    FOOTNOTE_REF_RE.lastIndex = 0;
    let footnoteMatch: RegExpExecArray | null;
    while ((footnoteMatch = FOOTNOTE_REF_RE.exec(context.vpText)) !== null) {
        const absFrom = context.vpFrom + footnoteMatch.index;
        const absTo = absFrom + footnoteMatch[0].length;
        if (rangeOverlapsBlock(context, absFrom, absTo)) continue;

        const id = footnoteMatch[1];
        const contentFrom = absFrom + 2;
        const contentTo = absTo - 1;
        registerRevealSensitiveRange(context, "range", absFrom, absTo);

        if (!selectionTouchesRange(context.state, absFrom, absTo)) {
            hideRange(context, absFrom, contentFrom, hideInlineMark);
            hideRange(context, contentTo, absTo, hideInlineMark);
            pushDeco(
                context,
                contentFrom,
                contentTo,
                Decoration.mark({
                    class: "cm-lp-footnote-ref",
                    attributes: {
                        "data-footnote-id": id,
                        tabindex: "0",
                        role: "button",
                    },
                }),
            );
        }
    }

    INLINE_HTML_RE.lastIndex = 0;
    let htmlMatch: RegExpExecArray | null;
    while ((htmlMatch = INLINE_HTML_RE.exec(context.vpText)) !== null) {
        const absFrom = context.vpFrom + htmlMatch.index;
        const absTo = absFrom + htmlMatch[0].length;
        if (rangeOverlapsBlock(context, absFrom, absTo)) continue;

        const tag = htmlMatch[1].toLowerCase();
        const openTag = `<${tag}>`;
        const closeTag = `</${tag}>`;
        const contentFrom = absFrom + openTag.length;
        const contentTo = absTo - closeTag.length;
        const className =
            tag === "kbd"
                ? "cm-lp-kbd"
                : tag === "sub"
                  ? "cm-lp-subscript"
                  : "cm-lp-superscript";

        hideRangeUnlessTokenActive(
            context,
            absFrom,
            contentFrom,
            absFrom,
            absTo,
        );
        pushDeco(
            context,
            contentFrom,
            contentTo,
            Decoration.mark({ class: className }),
        );
        hideRangeUnlessTokenActive(context, contentTo, absTo, absFrom, absTo);
    }

    INLINE_BR_RE.lastIndex = 0;
    let breakMatch: RegExpExecArray | null;
    while ((breakMatch = INLINE_BR_RE.exec(context.vpText)) !== null) {
        const absFrom = context.vpFrom + breakMatch.index;
        const absTo = absFrom + breakMatch[0].length;
        if (rangeOverlapsBlock(context, absFrom, absTo)) continue;
        pushDeco(
            context,
            absFrom,
            absTo,
            Decoration.replace({ widget: new InlineBreakWidget() }),
        );
    }

    // Block math ($$...$$) that spans multiple lines is handled by
    // createBlockMathLivePreviewExtension (StateField in livePreviewBlocks.ts).
    // Single-line block math still gets styled here.
    BLOCK_MATH_RE.lastIndex = 0;
    let blockMathMatch: RegExpExecArray | null;
    while ((blockMathMatch = BLOCK_MATH_RE.exec(context.vpText)) !== null) {
        const absFrom = context.vpFrom + blockMathMatch.index;
        const absTo = absFrom + blockMathMatch[0].length;
        if (rangeOverlapsBlock(context, absFrom, absTo)) continue;
        if (blockMathMatch[1].includes("\n")) continue; // handled by StateField

        const tex = blockMathMatch[1].trim();
        if (!tex) continue;
        registerRevealSensitiveRange(context, "range", absFrom, absTo);

        if (!selectionTouchesRange(context.state, absFrom, absTo)) {
            pushDeco(
                context,
                absFrom,
                absTo,
                Decoration.replace({
                    widget: new InlineMathWidget(tex),
                }),
            );
        } else {
            pushDeco(context, absFrom + 2, absTo - 2, createMathMark("block"));
        }
    }
}

function appendLineDecorations(context: BuildContext) {
    const sortedLineDecos = [...context.lineDecos.entries()].sort(
        ([left], [right]) => left - right,
    );

    for (const [lineFrom, spec] of sortedLineDecos) {
        const style = Object.entries(spec.styles)
            .map(([name, value]) => `${name}: ${value}`)
            .join("; ");

        pushDeco(
            context,
            lineFrom,
            lineFrom,
            Decoration.line({
                attributes: {
                    ...spec.attrs,
                    class: [...spec.classes].join(" "),
                    ...(style ? { style } : {}),
                },
            }),
        );
    }
}

function buildInlineDecorations(
    state: EditorState,
    vpFrom: number,
    vpTo: number,
): {
    decorations: DecorationSet;
    revealSensitiveRanges: RevealSensitiveRange[];
    activeRevealSignature: string;
} {
    const context: BuildContext = {
        state,
        decos: [],
        lineDecos: new Map<number, LineDecoEntry>(),
        blockRanges: [],
        orderedListMarkerWidths: new Map<string, string>(),
        linkReferences: state.field(linkReferenceField),
        vpFrom,
        vpTo,
        vpText: state.doc.sliceString(vpFrom, vpTo),
        revealSensitiveRanges: [],
        revealSensitiveRangeKeys: new Set<string>(),
    };

    applyFrontmatterHiding(context);
    applyNodeRules(context);
    applyLooseListFallback(context);
    applyExtendedTaskFallback(context);
    applyRegexRules(context);
    applyRichRegexRules(context);
    applyFootnoteDefinitionDecorations(context);
    applyCalloutDecorations(context);
    appendLineDecorations(context);

    context.decos.sort(
        (left, right) =>
            left.from - right.from ||
            left.deco.startSide - right.deco.startSide ||
            left.to - right.to,
    );

    const builder = new RangeSetBuilder<Decoration>();
    for (const deco of context.decos) {
        builder.add(deco.from, deco.to, deco.deco);
    }
    return {
        decorations: builder.finish(),
        revealSensitiveRanges: context.revealSensitiveRanges,
        activeRevealSignature: getRevealSensitiveSignature(
            state,
            context.revealSensitiveRanges,
        ),
    };
}

function touchesLeadingWhitespace(
    lineText: string,
    fromOffset: number,
    toOffset: number,
) {
    const leadingWhitespaceLength = lineText.match(/^[ \t]*/)?.[0].length ?? 0;
    return (
        fromOffset <= leadingWhitespaceLength ||
        toOffset <= leadingWhitespaceLength
    );
}

function touchesLineIndentation(update: ViewUpdate): boolean {
    let touched = false;

    update.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
        if (touched) return;

        const oldLine = update.startState.doc.lineAt(fromA);
        const newLine = update.state.doc.lineAt(fromB);

        if (
            touchesLeadingWhitespace(
                oldLine.text,
                fromA - oldLine.from,
                toA - oldLine.from,
            ) ||
            touchesLeadingWhitespace(
                newLine.text,
                fromB - newLine.from,
                toB - newLine.from,
            )
        ) {
            touched = true;
        }
    });

    return touched;
}

function touchesListPresentationTransition(update: ViewUpdate): boolean {
    let touched = false;

    update.changes.iterChangedRanges((fromA, _toA, fromB) => {
        if (touched) return;

        const oldLine = update.startState.doc.lineAt(fromA);
        const newLine = update.state.doc.lineAt(fromB);
        const oldItem = parseMarkdownListItem(oldLine.text);
        const newItem = parseMarkdownListItem(newLine.text);

        if (!oldItem && !newItem) return;
        if (!oldItem || !newItem) {
            touched = true;
            return;
        }

        if (
            oldItem.isEmpty !== newItem.isEmpty ||
            oldItem.isTask !== newItem.isTask ||
            oldItem.taskMarker !== newItem.taskMarker ||
            oldItem.marker !== newItem.marker ||
            oldItem.indent !== newItem.indent
        ) {
            touched = true;
        }
    });

    return touched;
}

function isSimpleEdit(update: ViewUpdate): boolean {
    if (
        touchesLineIndentation(update) ||
        touchesListPresentationTransition(update)
    ) {
        return false;
    }

    let safe = true;
    update.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
        if (!safe) return;
        if (toA > fromA) {
            if (
                MARKDOWN_SIGNIFICANT.test(
                    update.startState.doc.sliceString(fromA, toA),
                )
            ) {
                safe = false;
                return;
            }
        }
        if (toB > fromB) {
            if (
                MARKDOWN_SIGNIFICANT.test(
                    update.state.doc.sliceString(fromB, toB),
                )
            ) {
                safe = false;
            }
        }
    });
    return safe;
}

export function createInlineLivePreviewPlugin() {
    return ViewPlugin.fromClass(
        class {
            decorations: DecorationSet;
            revealSensitiveRanges: RevealSensitiveRange[] = [];
            activeRevealSignature = "";

            constructor(view: EditorView) {
                this.decorations = this.build(view, "initial");
            }

            update(update: ViewUpdate) {
                if (update.docChanged) {
                    // Fast path: for edits that don't involve markdown-significant
                    // characters, just remap decoration positions instead of
                    // rebuilding the entire viewport.
                    if (isSimpleEdit(update)) {
                        this.decorations = this.decorations.map(update.changes);
                        perfCount("editor.livePreviewInline.docChanged.mapped");
                        return;
                    }
                    this.decorations = this.build(update.view, "docChanged");
                    return;
                }

                if (update.viewportChanged) {
                    this.decorations = this.build(
                        update.view,
                        "viewportChanged",
                    );
                    return;
                }

                if (!update.selectionSet) return;
                const nextRevealSignature = getRevealSensitiveSignature(
                    update.state,
                    this.revealSensitiveRanges,
                );
                if (nextRevealSignature === this.activeRevealSignature) {
                    perfCount("editor.livePreviewInline.selectionSet.skipped", {
                        revealSensitiveRanges:
                            this.revealSensitiveRanges.length,
                    });
                    return;
                }
                this.decorations = this.build(update.view, "selectionSet");
            }

            build(
                view: EditorView,
                reason:
                    | "initial"
                    | "docChanged"
                    | "viewportChanged"
                    | "selectionSet",
            ): DecorationSet {
                const { from, to } = view.viewport;
                const startMs = perfNow();
                const buildResult = buildInlineDecorations(
                    view.state,
                    from,
                    to,
                );
                this.revealSensitiveRanges = buildResult.revealSensitiveRanges;
                this.activeRevealSignature = buildResult.activeRevealSignature;
                const visibleLines =
                    view.state.doc.lineAt(to).number -
                    view.state.doc.lineAt(from).number +
                    1;

                if (reason === "docChanged") {
                    perfCount("editor.livePreviewInline.docChanged");
                }

                perfMeasure(
                    `editor.livePreviewInline.build.${reason}`,
                    startMs,
                    {
                        viewportFrom: from,
                        viewportTo: to,
                        viewportChars: Math.max(0, to - from),
                        visibleLines,
                        docLines: view.state.doc.lines,
                        revealSensitiveRanges:
                            this.revealSensitiveRanges.length,
                    },
                );

                return buildResult.decorations;
            }
        },
        { decorations: (value) => value.decorations },
    );
}

/* ── StateField: collapse frontmatter + leading H1 ────────────── */

function selectionOnLine(state: EditorState, from: number, to: number) {
    return state.selection.ranges.some((range) => {
        const rangeFrom = state.doc.lineAt(range.from).from;
        const rangeTo = state.doc.lineAt(range.to).to;
        return rangeFrom <= to && rangeTo >= from;
    });
}

function buildCollapseDecorations(state: EditorState): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    const docText = state.doc.sliceString(0, Math.min(state.doc.length, 2000));

    let contentStart = 0;

    // Collapse frontmatter block
    const fmMatch = docText.match(FRONTMATTER_RE);
    if (fmMatch) {
        let fmTo = fmMatch[0].length;

        // Extend past trailing blank line
        const fmEndLine = state.doc.lineAt(fmTo > 0 ? fmTo - 1 : 0);
        const nextNum = fmEndLine.number + 1;
        if (nextNum <= state.doc.lines) {
            const nextLine = state.doc.line(nextNum);
            if (nextLine.text.trim().length === 0) {
                fmTo = nextLine.to;
            }
        }

        if (!selectionOnLine(state, 0, fmTo)) {
            builder.add(0, fmTo, Decoration.replace({ block: true }));
        }
        contentStart = fmTo;
    }

    // Collapse leading H1 (after optional frontmatter)
    const afterFm = state.doc.sliceString(contentStart, contentStart + 500);
    const h1Match = afterFm.match(/^(\s*)(# .+)/);
    if (h1Match) {
        const h1From = contentStart + h1Match[1].length;
        const h1LineEnd = contentStart + h1Match[1].length + h1Match[2].length;
        let h1To = h1LineEnd;

        // Extend past trailing blank line
        const h1Line = state.doc.lineAt(h1LineEnd);
        const nextNum = h1Line.number + 1;
        if (nextNum <= state.doc.lines) {
            const nextLine = state.doc.line(nextNum);
            if (nextLine.text.trim().length === 0) {
                h1To = nextLine.to;
            }
        }

        if (!selectionOnLine(state, h1From, h1To) && h1From < h1To) {
            builder.add(h1From, h1To, Decoration.replace({ block: true }));
        }
    }

    return builder.finish();
}

export function createLeadingContentCollapseField() {
    return StateField.define<DecorationSet>({
        create(state) {
            return buildCollapseDecorations(state);
        },
        update(decos, tr) {
            if (!tr.docChanged && !tr.selection) {
                return decos;
            }
            return buildCollapseDecorations(tr.state);
        },
        provide(field) {
            return EditorView.decorations.from(field);
        },
    });
}
