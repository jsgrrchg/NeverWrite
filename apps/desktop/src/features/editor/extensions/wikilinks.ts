import {
    Decoration,
    type DecorationSet,
    EditorView,
    ViewPlugin,
    type ViewUpdate,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { selectionTouchesRange } from "./selectionActivity";

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

interface WikilinkMatch {
    from: number;
    to: number;
    target: string;
}

function findWikilinksInText(doc: string, offset = 0): WikilinkMatch[] {
    const results: WikilinkMatch[] = [];
    let match;
    WIKILINK_RE.lastIndex = 0;
    while ((match = WIKILINK_RE.exec(doc)) !== null) {
        const inner = match[1];
        const pipeIndex = inner.indexOf("|");
        const target =
            pipeIndex >= 0 ? inner.slice(0, pipeIndex).trim() : inner.trim();
        results.push({
            from: offset + match.index,
            to: offset + match.index + match[0].length,
            target,
        });
    }
    return results;
}

function findVisibleWikilinks(view: EditorView): WikilinkMatch[] {
    const matches: WikilinkMatch[] = [];
    for (const { from, to } of view.visibleRanges) {
        const text = view.state.sliceDoc(from, to);
        matches.push(...findWikilinksInText(text, from));
    }
    return matches;
}

function findWikilinkAtPosition(
    view: EditorView,
    pos: number,
): WikilinkMatch | null {
    const line = view.state.doc.lineAt(pos);
    return (
        findWikilinksInText(line.text, line.from).find(
            (link) => pos >= link.from && pos <= link.to,
        ) ?? null
    );
}

export type WikilinkResolver = (target: string) => boolean;
export type WikilinkNavigator = (target: string) => void;

const validLinkMark = Decoration.mark({
    class: "cm-wikilink cm-wikilink-valid",
});
const brokenLinkMark = Decoration.mark({
    class: "cm-wikilink cm-wikilink-broken",
});

export function wikilinkExtension(
    resolveLink: WikilinkResolver,
    navigateToLink: WikilinkNavigator,
) {
    const plugin = ViewPlugin.fromClass(
        class {
            decorations: DecorationSet;

            constructor(view: EditorView) {
                this.decorations = this.build(view);
            }

            update(update: ViewUpdate) {
                if (
                    update.docChanged ||
                    update.viewportChanged ||
                    update.selectionSet
                ) {
                    this.decorations = this.build(update.view);
                }
            }

            build(view: EditorView): DecorationSet {
                const builder = new RangeSetBuilder<Decoration>();
                const resolved = new Map<string, boolean>();
                for (const link of findVisibleWikilinks(view)) {
                    if (selectionTouchesRange(view.state, link.from, link.to)) {
                        continue;
                    }

                    let exists = resolved.get(link.target);
                    if (exists === undefined) {
                        exists = resolveLink(link.target);
                        resolved.set(link.target, exists);
                    }
                    builder.add(
                        link.from,
                        link.to,
                        exists ? validLinkMark : brokenLinkMark,
                    );
                }
                return builder.finish();
            }
        },
        {
            decorations: (v) => v.decorations,
        },
    );

    const clickHandler = EditorView.domEventHandlers({
        click(event: MouseEvent, view: EditorView) {
            const target = event.target as HTMLElement;
            if (!target.closest(".cm-wikilink")) return false;

            const pos = view.posAtCoords({
                x: event.clientX,
                y: event.clientY,
            });
            if (pos === null) return false;

            const clicked = findWikilinkAtPosition(view, pos);
            if (clicked) {
                event.preventDefault();
                navigateToLink(clicked.target);
                return true;
            }
            return false;
        },
    });

    const theme = EditorView.baseTheme({
        ".cm-wikilink": {
            cursor: "pointer",
            textDecoration: "underline",
            textDecorationStyle: "dotted",
            textUnderlineOffset: "3px",
        },
        ".cm-wikilink-valid": {
            color: "var(--accent)",
        },
        ".cm-wikilink-broken": {
            color: "#ef4444",
            textDecorationColor: "#ef4444",
        },
    });

    return [plugin, clickHandler, theme];
}
