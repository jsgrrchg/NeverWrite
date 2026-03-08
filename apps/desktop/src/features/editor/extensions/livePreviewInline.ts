import {
    Decoration,
    type DecorationSet,
    EditorView,
    ViewPlugin,
    type ViewUpdate,
    WidgetType,
} from "@codemirror/view";
import { type EditorState, RangeSetBuilder } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";

import {
    type DecoEntry,
    type LineDecoEntry,
    hideMark,
    hideInactiveChildMarks,
    parseLinkChildren,
    buildLinkReferenceIndex,
    resolveLinkHref,
    findAncestor,
    hasDescendant,
    extendPastFollowingWhitespace,
    measureIndent,
    measureLineLeadingIndent,
    addLineDecoration,
} from "./livePreviewHelpers";
import { selectionTouchesRange } from "./selectionActivity";

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
const LOOSE_UNORDERED_LIST_RE = /^([ \t]*)([•◦▪‣–—−])([ \t]+)/;
const FOOTNOTE_REF_RE = /\[\^([^\]\s]+)\]/g;
const INLINE_HTML_RE = /<(sub|sup|kbd)>([^<\n]+)<\/\1>/gi;
const INLINE_BR_RE = /<br\s*\/?>/gi;
const INLINE_MATH_RE = /(^|[^\\$])\$(?!\$)([^\n$]|\\\$)+?\$(?!\$)/g;
const BLOCK_MATH_RE = /\$\$([\s\S]+?)\$\$/g;
const FOOTNOTE_DEF_RE = /^\[\^([^\]]+)\]:\s*(.*)$/;
const CALLOUT_RE = /^\s*>\s+\[!([a-zA-Z0-9-]+)\]([+-])?(?:\s+(.*))?$/;
const EXTENDED_TASK_RE =
    /^(\s*(?:[-+*]|\d+[.)])\s+)\[( |x|X|~|\/)\](\s+.*)?$/;
const UNORDERED_LIST_MARKER_WIDTH = "1.45em";
const TASK_LIST_MARKER_WIDTH = "1.2em";
const NARRATIVE_LIST_ITEM_THRESHOLD = 72;
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

class InlineBreakWidget extends WidgetType {
    toDOM() {
        return document.createElement("br");
    }
}

function createMathMark(display: "inline" | "block") {
    return Decoration.mark({
        class:
            display === "block" ? "cm-lp-math-block" : "cm-lp-math-inline",
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
                const marker = state.doc.sliceString(itemCursor.from, itemCursor.to);
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

function hasAdjacentListContext(state: EditorState, lineNumber: number): boolean {
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
    return entry.classes.has("cm-lp-li-line") || entry.classes.has("cm-lp-task-line");
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
    return state.doc.sliceString(0, from).trim().length === 0;
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

function pushDeco(
    context: BuildContext,
    from: number,
    to: number,
    deco: Decoration,
) {
    context.decos.push({ from, to, deco });
}

function hideRangeUnlessEditing(
    context: BuildContext,
    from: number,
    to: number,
    deco: Decoration = hideMark,
) {
    if (!selectionTouchesRange(context.state, from, to)) {
        pushDeco(context, from, to, deco);
    }
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
        addLineDecoration(context.lineDecos, line.from, className, attrs, styles);
    }
}

function createInlineFormattingRule(
    nodeName: string,
    mark: Decoration,
    markerName: string,
): NodeRule {
    return (node, context) => {
        if (node.name !== nodeName) return;
        pushDeco(context, node.from, node.to, mark);
        hideInactiveChildMarks(
            node.node,
            markerName,
            context.state,
            context.decos,
            hideMark,
        );
    };
}

const headingRule: NodeRule = (node, context) => {
    const headingLevel = getHeadingLevel(node.name);
    if (headingLevel === null) return;

    if (headingLevel === 1 && isLeadingDocumentHeading(context.state, node.from)) {
        const hideTo = getLeadingHeadingHideTo(context.state, node.to);
        hideRangeUnlessEditing(context, node.from, hideTo);
        return;
    }

    const mark = headingMarks[headingLevel];
    if (mark) {
        pushDeco(context, node.from, node.to, mark);
    }

    const cursor = node.node.cursor();
    if (!cursor.firstChild()) return;

    do {
        if (cursor.name !== "HeaderMark") continue;

        let hideFrom = cursor.from;
        let hideTo = cursor.to;

        if (node.name.startsWith("ATXHeading")) {
            if (
                hideTo < node.to &&
                context.state.doc.sliceString(hideTo, hideTo + 1) === " "
            ) {
                hideTo++;
            }
        }

        if (
            node.name.startsWith("SetextHeading") &&
            hideFrom > node.from &&
            context.state.doc.sliceString(hideFrom - 1, hideFrom) === "\n"
        ) {
            hideFrom--;
        }

        hideRangeUnlessEditing(context, hideFrom, hideTo);
    } while (cursor.nextSibling());
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
            ...(info.title ? { title: info.title } : {}),
        },
    });

    pushDeco(context, info.textFrom, info.textTo, linkMark);
    hideRangeUnlessEditing(context, node.from, info.textFrom, hideMark);
    hideRangeUnlessEditing(context, info.textTo, node.to, hideMark);
};

const horizontalRuleRule: NodeRule = (node, context) => {
    if (node.name !== "HorizontalRule") return;

    const line = context.state.doc.lineAt(node.from);
    if (selectionTouchesRange(context.state, line.from, line.to)) return;

    pushDeco(context, line.from, line.to, hideMark);
    addLineDecoration(context.lineDecos, line.from, "cm-lp-hr-line");
};

const listMarkRule: NodeRule = (node, context) => {
    if (node.name !== "ListMark") return;

    const listItem = findAncestor(node.node, "ListItem");
    const isTaskItem = listItem ? hasDescendant(listItem, "TaskMarker") : false;
    const line = context.state.doc.lineAt(node.from);
    const hideTo = extendPastFollowingWhitespace(context.state, node.to);
    const isEditingMarker = selectionTouchesRange(
        context.state,
        node.from,
        hideTo,
    );

    if (!isEditingMarker) {
        pushDeco(context, line.from, hideTo, hideMark);
    }

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
            "data-lp-editing-marker": isEditingMarker ? "true" : "false",
        },
        lineStyles,
    );
    addLineDecoration(
        context.lineDecos,
        line.from,
        "cm-lp-li-line",
        {
            "data-lp-editing-marker": isEditingMarker ? "true" : "false",
        },
        lineStyles,
    );
    addLineDecoration(context.lineDecos, line.from, densityClass);
    addLineDecoration(context.lineDecos, line.from, levelClass);
};

const blockquoteRule: NodeRule = (node, context) => {
    if (node.name !== "Blockquote") return;

    pushDeco(context, node.from, node.to, quoteContentMark);
    addLineClassForRange(context, node.from, node.to, "cm-lp-blockquote-line");

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

        hideRangeUnlessEditing(context, cursor.from, hideTo);
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
        hideRangeUnlessEditing(context, node.from, openEnd);
    }

    if (closeFrom > 0 && closeFrom < node.to) {
        const hideFrom =
            closeFrom > 0 &&
            context.state.doc.sliceString(closeFrom - 1, closeFrom) === "\n"
                ? closeFrom - 1
                : closeFrom;
        hideRangeUnlessEditing(context, hideFrom, node.to);
    }
};

const taskMarkerRule: NodeRule = (node, context) => {
    if (node.name !== "TaskMarker") return;

    const prefixEnd = extendPastFollowingWhitespace(context.state, node.to);
    const isEditingMarker = selectionTouchesRange(
        context.state,
        node.from,
        prefixEnd,
    );

    const text = context.state.doc.sliceString(node.from, node.to);
    const checked = text.includes("x") || text.includes("X");
    const line = context.state.doc.lineAt(node.from);
    const indentWidth = measureLineLeadingIndent(line.text);
    const densityClass = getListDensityClass(
        context.state.doc.sliceString(prefixEnd, line.to),
    );
    const levelClass = getListLevelClass(getListLevel(node.node));

    if (!isEditingMarker) {
        pushDeco(context, node.from, prefixEnd, hideMark);
    }
    addLineDecoration(
        context.lineDecos,
        line.from,
        "cm-lp-task-line",
        {
            "data-lp-checked": checked ? "true" : "false",
            "data-lp-task-state": checked ? "done" : "open",
            "data-lp-task-from": String(line.from),
            "data-lp-task-marker": checked ? "x" : " ",
            "data-lp-editing-marker": isEditingMarker ? "true" : "false",
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
                hideRangeUnlessEditing(
                    context,
                    absFrom,
                    absFrom + 2 + pipeIndex + 1,
                    hideMark,
                );
            } else {
                hideRangeUnlessEditing(
                    context,
                    absFrom,
                    absFrom + 2,
                    hideMark,
                );
            }

            hideRangeUnlessEditing(context, absTo - 2, absTo, hideMark);
        },
    },
    {
        pattern: HIGHLIGHT_RE,
        apply(_match, absFrom, absTo, context) {
            hideRangeUnlessEditing(
                context,
                absFrom,
                absFrom + 2,
                hideMark,
            );
            pushDeco(context, absFrom + 2, absTo - 2, highlightMark);
            hideRangeUnlessEditing(
                context,
                absTo - 2,
                absTo,
                hideMark,
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
            if (node.name === "Table") {
                context.blockRanges.push({ from: node.from, to: node.to });
                return false;
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

function rangeOverlapsBlock(
    context: BuildContext,
    from: number,
    to: number,
) {
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
        if (lineHasListDecoration(context.lineDecos, line.from)) continue;

        const match = line.text.match(LOOSE_UNORDERED_LIST_RE);
        if (!match) continue;

        const [, indent, marker, spacing] = match;
        const indentWidth = measureIndent(indent);
        const shouldTreatAsList =
            marker !== "–" && marker !== "—" && marker !== "−"
                ? true
                : indentWidth > 0 || hasAdjacentListContext(context.state, line.number);

        if (!shouldTreatAsList) continue;

        const markerFrom = line.from + indent.length;
        const hideTo = markerFrom + marker.length + spacing.length;
        const isEditingMarker = selectionTouchesRange(
            context.state,
            markerFrom,
            hideTo,
        );

        if (!isEditingMarker) {
            pushDeco(context, line.from, hideTo, hideMark);
        }

        addLineDecoration(
            context.lineDecos,
            line.from,
            "cm-lp-li-unordered",
            {
                "data-lp-editing-marker": isEditingMarker ? "true" : "false",
            },
            {
                "--cm-lp-indent": `${indentWidth}ch`,
                "--cm-lp-marker-width": UNORDERED_LIST_MARKER_WIDTH,
            },
        );
        addLineDecoration(
            context.lineDecos,
            line.from,
            "cm-lp-li-line",
            {
                "data-lp-editing-marker": isEditingMarker ? "true" : "false",
            },
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

function normalizeCalloutType(type: string): string {
    return type.trim().toLowerCase();
}

function applyCalloutDecorations(context: BuildContext) {
    const startLine = context.state.doc.lineAt(context.vpFrom).number;
    const endLine = context.state.doc.lineAt(context.vpTo).number;

    for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
        const line = context.state.doc.line(lineNumber);
        const match = line.text.match(CALLOUT_RE);
        if (!match) continue;

        const calloutType = normalizeCalloutType(match[1]);
        const markerStart = line.text.indexOf("[!");
        const markerEnd = line.text.indexOf("]", markerStart);
        if (markerStart < 0 || markerEnd < 0) continue;

        let blockEnd = lineNumber;
        while (blockEnd < context.state.doc.lines) {
            const nextLine = context.state.doc.line(blockEnd + 1);
            if (!nextLine || !/^\s*>/.test(nextLine.text)) break;
            blockEnd++;
        }

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

        const absoluteMarkerFrom = line.from + markerStart;
        let absoluteMarkerTo = line.from + markerEnd + 1;
        if (match[2]) {
            absoluteMarkerTo += match[2].length;
        }
        if (
            absoluteMarkerTo < line.to &&
            context.state.doc.sliceString(absoluteMarkerTo, absoluteMarkerTo + 1) ===
                " "
        ) {
            absoluteMarkerTo++;
        }
        hideRangeUnlessEditing(context, absoluteMarkerFrom, absoluteMarkerTo);
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
        hideRangeUnlessEditing(context, line.from, markerTo);
        if (
            markerTo < line.to &&
            context.state.doc.sliceString(markerTo, markerTo + 1) === " "
        ) {
            hideRangeUnlessEditing(context, markerTo, markerTo + 1);
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
        if (lineHasListDecoration(context.lineDecos, line.from)) continue;

        const match = line.text.match(EXTENDED_TASK_RE);
        if (!match) continue;

        const markerState = match[2];
        if (markerState !== "~" && markerState !== "/") continue;

        const prefix = match[1];
        const markerStart = line.from + prefix.length;
        const markerEnd = markerStart + 3;
        const isEditingMarker = selectionTouchesRange(
            context.state,
            markerStart,
            markerEnd + 1,
        );
        const indentWidth = measureLineLeadingIndent(line.text);
        const taskState = "partial";

        if (!isEditingMarker) {
            pushDeco(context, line.from, Math.min(line.to, markerEnd + 1), hideMark);
        }

        addLineDecoration(
            context.lineDecos,
            line.from,
            "cm-lp-task-line",
            {
                "data-lp-task-state": taskState,
                "data-lp-task-from": String(line.from),
                "data-lp-task-marker": markerState,
                "data-lp-editing-marker": isEditingMarker ? "true" : "false",
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
        pushDeco(
            context,
            absFrom,
            absTo,
            Decoration.mark({
                class: "cm-lp-footnote-ref",
                attributes: { "data-footnote-id": id },
            }),
        );
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

        hideRangeUnlessEditing(context, absFrom, contentFrom);
        pushDeco(
            context,
            contentFrom,
            contentTo,
            Decoration.mark({ class: className }),
        );
        hideRangeUnlessEditing(context, contentTo, absTo);
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

    BLOCK_MATH_RE.lastIndex = 0;
    let blockMathMatch: RegExpExecArray | null;
    while ((blockMathMatch = BLOCK_MATH_RE.exec(context.vpText)) !== null) {
        const absFrom = context.vpFrom + blockMathMatch.index;
        const absTo = absFrom + blockMathMatch[0].length;
        if (rangeOverlapsBlock(context, absFrom, absTo)) continue;
        if (!blockMathMatch[1].includes("\n")) continue;

        pushDeco(context, absFrom, absTo, createMathMark("block"));
        hideRangeUnlessEditing(context, absFrom, absFrom + 2);
        hideRangeUnlessEditing(context, absTo - 2, absTo);
        addLineClassForRange(context, absFrom, absTo, "cm-lp-math-block-line");
    }

    INLINE_MATH_RE.lastIndex = 0;
    let inlineMathMatch: RegExpExecArray | null;
    while ((inlineMathMatch = INLINE_MATH_RE.exec(context.vpText)) !== null) {
        const prefixLength = inlineMathMatch[1]?.length ?? 0;
        const absFrom = context.vpFrom + inlineMathMatch.index + prefixLength;
        const absTo = context.vpFrom + inlineMathMatch.index + inlineMathMatch[0].length;
        if (rangeOverlapsBlock(context, absFrom, absTo)) continue;

        const contentFrom = absFrom + 1;
        const contentTo = absTo - 1;
        if (contentTo <= contentFrom) continue;

        hideRangeUnlessEditing(context, absFrom, contentFrom);
        pushDeco(context, contentFrom, contentTo, createMathMark("inline"));
        hideRangeUnlessEditing(context, contentTo, absTo);
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
): DecorationSet {
    const context: BuildContext = {
        state,
        decos: [],
        lineDecos: new Map<number, LineDecoEntry>(),
        blockRanges: [],
        orderedListMarkerWidths: new Map<string, string>(),
        linkReferences: buildLinkReferenceIndex(state),
        vpFrom,
        vpTo,
        vpText: state.doc.sliceString(vpFrom, vpTo),
    };

    applyNodeRules(context);
    applyLooseListFallback(context);
    applyExtendedTaskFallback(context);
    applyRegexRules(context);
    applyRichRegexRules(context);
    applyFootnoteDefinitionDecorations(context);
    applyCalloutDecorations(context);
    appendLineDecorations(context);

    context.decos.sort((left, right) => left.from - right.from || left.to - right.to);

    const builder = new RangeSetBuilder<Decoration>();
    for (const deco of context.decos) {
        builder.add(deco.from, deco.to, deco.deco);
    }
    return builder.finish();
}

export function createInlineLivePreviewPlugin() {
    return ViewPlugin.fromClass(
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
                const { from, to } = view.viewport;
                return buildInlineDecorations(view.state, from, to);
            }
        },
        { decorations: (value) => value.decorations },
    );
}
