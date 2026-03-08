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
import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { SyntaxNode } from "@lezer/common";

import {
    type DecoEntry,
    type LineDecoEntry,
    hideMark,
    hideInactiveChildMarks,
    parseLinkChildren,
    findAncestor,
    hasDescendant,
    extendPastFollowingWhitespace,
    measureIndent,
    measureLineLeadingIndent,
    addLineDecoration,
} from "./livePreviewHelpers";
import { selectionTouchesRange } from "./selectionActivity";
import { livePreviewTheme } from "./livePreviewTheme";

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
const linkTextMark = Decoration.mark({ class: "cm-lp-link" });
const quoteContentMark = Decoration.mark({ class: "cm-lp-blockquote" });

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|svg|webp|bmp|ico|avif)([?#].*)?$/i;
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;
const HIGHLIGHT_RE = /==(?=\S)([^\n]*?\S)==/g;

type LivePreviewNode = {
    name: string;
    from: number;
    to: number;
    node: SyntaxNode;
};

interface BuildContext {
    state: EditorState;
    vaultRoot: string | null;
    decos: DecoEntry[];
    lineDecos: Map<number, LineDecoEntry>;
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

function getHeadingLevel(nodeName: string): number | null {
    if (nodeName.startsWith("ATXHeading")) {
        return parseInt(nodeName.slice(10), 10);
    }
    if (nodeName === "SetextHeading1") return 1;
    if (nodeName === "SetextHeading2") return 2;
    return null;
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

class ImageWidget extends WidgetType {
    private src: string;
    private alt: string;
    private href: string | null;

    constructor(
        src: string,
        alt: string,
        href: string | null = null,
    ) {
        super();
        this.src = src;
        this.alt = alt;
        this.href = href;
    }

    eq(other: ImageWidget) {
        return this.src === other.src;
    }

    toDOM() {
        const wrapper = document.createElement("div");
        wrapper.className = "cm-inline-image-wrapper";
        if (this.href) {
            wrapper.classList.add("cm-inline-image-link");
            wrapper.dataset.href = this.href;
        }

        const img = document.createElement("img");
        img.src = this.src;
        img.alt = this.alt;
        img.className = "cm-inline-image";
        img.draggable = false;

        img.onerror = () => {
            img.style.display = "none";
            const fallback = document.createElement("span");
            fallback.className = "cm-inline-image-fallback";
            fallback.textContent = `Image not found: ${this.alt || this.src}`;
            wrapper.appendChild(fallback);
        };

        wrapper.appendChild(img);
        return wrapper;
    }

    ignoreEvent() {
        return false;
    }
}

function resolveImageUrl(rawUrl: string, vaultRoot: string | null): string {
    if (
        rawUrl.startsWith("http://") ||
        rawUrl.startsWith("https://") ||
        rawUrl.startsWith("data:")
    ) {
        return rawUrl;
    }
    if (!vaultRoot) return rawUrl;
    const path = rawUrl.startsWith("/") ? rawUrl : `${vaultRoot}/${rawUrl}`;
    return convertFileSrc(path);
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

const imageRule: NodeRule = (node, context) => {
    if (node.name !== "Image") return;

    const info = parseLinkChildren(node.node, context.state);
    if (!info?.hasUrl || !info.url || !IMAGE_EXTENSIONS.test(info.url)) return;
    if (selectionTouchesRange(context.state, node.from, node.to)) return;

    const altText = context.state.doc.sliceString(info.textFrom, info.textTo);
    const resolvedUrl = resolveImageUrl(info.url, context.vaultRoot);
    const parentLink = findAncestor(node.node.parent, "Link");
    const outerLinkInfo = parentLink
        ? parseLinkChildren(parentLink, context.state)
        : null;
    const href = outerLinkInfo?.url ?? null;

    pushDeco(
        context,
        node.from,
        node.to,
        Decoration.replace({
            widget: new ImageWidget(resolvedUrl, altText, href),
            block: false,
        }),
    );
};

const linkRule: NodeRule = (node, context) => {
    if (node.name !== "Link") return;

    const info = parseLinkChildren(node.node, context.state);
    if (!info?.hasUrl) return;

    pushDeco(context, info.textFrom, info.textTo, linkTextMark);
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

    const ordered = findAncestor(node.node, "OrderedList") !== null;
    const indentWidth = measureIndent(
        context.state.doc.sliceString(line.from, node.from),
    );
    const lineStyles = { "--cm-lp-indent": `${indentWidth}ch` };

    addLineDecoration(
        context.lineDecos,
        line.from,
        ordered ? "cm-lp-li-ordered" : "cm-lp-li-unordered",
        {
            ...(ordered
                ? {
                      "data-lp-marker": context.state.doc.sliceString(
                          node.from,
                          node.to,
                      ),
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

    if (!isEditingMarker) {
        pushDeco(context, node.from, prefixEnd, hideMark);
    }
    addLineDecoration(
        context.lineDecos,
        line.from,
        "cm-lp-task-line",
        {
            "data-lp-checked": checked ? "true" : "false",
            "data-lp-editing-marker": isEditingMarker ? "true" : "false",
        },
        {
            "--cm-lp-indent": `${indentWidth}ch`,
        },
    );

    if (checked) {
        addLineDecoration(context.lineDecos, line.from, "cm-lp-task-checked");
    }
};

const nodeRules: NodeRule[] = [
    headingRule,
    createInlineFormattingRule("StrongEmphasis", boldMark, "EmphasisMark"),
    createInlineFormattingRule("Emphasis", italicMark, "EmphasisMark"),
    createInlineFormattingRule("InlineCode", inlineCodeMark, "CodeMark"),
    imageRule,
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

function applyRegexRules(context: BuildContext) {
    for (const { pattern, apply } of regexRules) {
        pattern.lastIndex = 0;

        let match: RegExpExecArray | null;
        while ((match = pattern.exec(context.vpText)) !== null) {
            const absFrom = context.vpFrom + match.index;
            const absTo = absFrom + match[0].length;
            apply(match, absFrom, absTo, context);
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

function buildDecorations(
    state: EditorState,
    vaultRoot: string | null,
    vpFrom: number,
    vpTo: number,
): DecorationSet {
    const context: BuildContext = {
        state,
        vaultRoot,
        decos: [],
        lineDecos: new Map<number, LineDecoEntry>(),
        vpFrom,
        vpTo,
        vpText: state.doc.sliceString(vpFrom, vpTo),
    };

    applyNodeRules(context);
    applyRegexRules(context);
    appendLineDecorations(context);

    context.decos.sort((left, right) => left.from - right.from || left.to - right.to);

    const builder = new RangeSetBuilder<Decoration>();
    for (const deco of context.decos) {
        builder.add(deco.from, deco.to, deco.deco);
    }
    return builder.finish();
}

function createLivePreviewPlugin(vaultRoot: string | null) {
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
                return buildDecorations(view.state, vaultRoot, from, to);
            }
        },
        { decorations: (value) => value.decorations },
    );
}

export function livePreviewExtension(vaultRoot: string | null) {
    const clickHandler = EditorView.domEventHandlers({
        click(event: MouseEvent, view: EditorView) {
            const target = event.target as HTMLElement;
            const linkedImage = target.closest(
                ".cm-inline-image-link",
            ) as HTMLElement | null;

            if (linkedImage?.dataset.href) {
                event.preventDefault();
                void openUrl(linkedImage.dataset.href);
                return true;
            }

            if (!target.closest(".cm-lp-link")) return false;

            const pos = view.posAtCoords({
                x: event.clientX,
                y: event.clientY,
            });
            if (pos === null) return false;

            const resolved = syntaxTree(view.state).resolveInner(pos, -1);
            const linkNode = findAncestor(resolved, "Link");
            if (!linkNode) return false;

            const info = parseLinkChildren(linkNode, view.state);
            if (!info?.url) return false;

            event.preventDefault();
            void openUrl(info.url);
            return true;
        },
    });

    return [createLivePreviewPlugin(vaultRoot), clickHandler, livePreviewTheme];
}
