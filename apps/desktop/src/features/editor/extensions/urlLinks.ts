import {
    Decoration,
    type DecorationSet,
    EditorView,
    ViewPlugin,
    type ViewUpdate,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { openUrl } from "@tauri-apps/plugin-opener";

const URL_RE = /https?:\/\/[^\s<>()"\]]+/g;
const EMAIL_RE = /(?:^|[\s<(])([^\s<>()"\],;:]+@[^\s<>()"\],;:]+\.[^\s<>()"\],;:]+)(?=$|[\s>)])/g;

const urlMark = Decoration.mark({ class: "cm-url-link" });

function findUrlsInText(
    doc: string,
    offset = 0,
): Array<{ from: number; to: number }> {
    const results: Array<{ from: number; to: number }> = [];
    let match;
    URL_RE.lastIndex = 0;
    while ((match = URL_RE.exec(doc)) !== null) {
        // Strip trailing punctuation that's likely not part of the URL
        let end = match.index + match[0].length;
        while (end > match.index && /[.,;:!?)}\]'"]/.test(doc[end - 1])) {
            end--;
        }
        results.push({ from: offset + match.index, to: offset + end });
    }
    return results;
}

function findVisibleUrls(
    view: EditorView,
): Array<{ from: number; to: number }> {
    const results: Array<{ from: number; to: number }> = [];
    for (const { from, to } of view.visibleRanges) {
        const text = view.state.sliceDoc(from, to);
        results.push(...findUrlsInText(text, from));
        EMAIL_RE.lastIndex = 0;
        let match;
        while ((match = EMAIL_RE.exec(text)) !== null) {
            const email = match[1];
            const localFrom = match.index + match[0].lastIndexOf(email);
            results.push({
                from: from + localFrom,
                to: from + localFrom + email.length,
            });
        }
    }
    return results;
}

function findUrlAtPosition(
    view: EditorView,
    pos: number,
): { from: number; to: number } | null {
    const line = view.state.doc.lineAt(pos);
    const urls = findUrlsInText(line.text, line.from);
    EMAIL_RE.lastIndex = 0;
    let match;
    while ((match = EMAIL_RE.exec(line.text)) !== null) {
        const email = match[1];
        const localFrom = match.index + match[0].lastIndexOf(email);
        urls.push({
            from: line.from + localFrom,
            to: line.from + localFrom + email.length,
        });
    }
    return urls.find((url) => pos >= url.from && pos <= url.to) ?? null;
}

const plugin = ViewPlugin.fromClass(
    class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
            this.decorations = this.build(view);
        }

        update(update: ViewUpdate) {
            if (update.docChanged || update.viewportChanged) {
                this.decorations = this.build(update.view);
            }
        }

        build(view: EditorView): DecorationSet {
            const builder = new RangeSetBuilder<Decoration>();
            for (const url of findVisibleUrls(view)) {
                builder.add(url.from, url.to, urlMark);
            }
            return builder.finish();
        }
    },
    { decorations: (v) => v.decorations },
);

const clickHandler = EditorView.domEventHandlers({
    click(event: MouseEvent, view: EditorView) {
        const target = event.target as HTMLElement;
        if (!target.closest(".cm-url-link")) return false;

        const pos = view.posAtCoords({
            x: event.clientX,
            y: event.clientY,
        });
        if (pos === null) return false;

        const clicked = findUrlAtPosition(view, pos);
        if (clicked) {
            event.preventDefault();
            const raw = view.state.sliceDoc(clicked.from, clicked.to);
            const url =
                /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) &&
                !/^[a-z][a-z0-9+.-]*:/i.test(raw)
                    ? `mailto:${raw}`
                    : raw;
            void openUrl(url);
            return true;
        }
        return false;
    },
});

const theme = EditorView.baseTheme({
    ".cm-url-link": {
        color: "var(--accent)",
        cursor: "pointer",
        textDecoration: "underline",
        textDecorationStyle: "solid",
        textUnderlineOffset: "3px",
    },
});

export const urlLinksExtension = [plugin, clickHandler, theme];
