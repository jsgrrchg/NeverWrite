import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { extractHeadings, type OutlineHeading } from "../../notes/outlineModel";
import { revealOutlineSelection } from "../outlineNavigation";

export interface EditorOutlineSnapshot {
    headings: readonly OutlineHeading[];
    activeId: string | null;
    width: number;
    height: number;
    rightInset: number;
    gutter: number;
}

export function findActiveHeading(headings: readonly OutlineHeading[], position: number) {
    let low = 0;
    let high = headings.length;
    while (low < high) {
        const mid = (low + high) >>> 1;
        if (headings[mid].anchor <= position) low = mid + 1;
        else high = mid;
    }
    return headings[Math.max(0, low - 1)]?.id ?? null;
}

/** One bridge per Editor instance, including independent copies of the same note. */
export function createEditorOutlineBridge() {
    let view: EditorView | null = null;
    let snapshot: EditorOutlineSnapshot = {
        headings: [], activeId: null, width: 0, height: 0, rightInset: 0, gutter: 0,
    };
    const listeners = new Set<() => void>();
    const publish = (next: EditorOutlineSnapshot) => {
        if (Object.keys(next).every((key) => next[key as keyof EditorOutlineSnapshot] === snapshot[key as keyof EditorOutlineSnapshot])) return;
        snapshot = next;
        for (const listener of listeners) listener();
    };

    const extension = ViewPlugin.fromClass(class {
        readonly editor: EditorView;

        constructor(editor: EditorView) {
            this.editor = editor;
            view = editor;
            this.readDocument();
            this.measure();
        }

        readDocument() {
            const headings = extractHeadings(this.editor.state.doc.toString());
            publish({ ...snapshot, headings, activeId: null });
        }

        update(update: ViewUpdate) {
            if (update.docChanged) this.readDocument();
            if (update.docChanged || update.geometryChanged || update.viewportChanged) this.measure();
        }

        measure() {
            this.editor.requestMeasure({
                key: this,
                read: (editor) => {
                    const rect = editor.scrollDOM.getBoundingClientRect();
                    const contentRect = editor.contentDOM.getBoundingClientRect();
                    const padding = parseFloat(getComputedStyle(editor.contentDOM).paddingRight) || 0;
                    const rightInset = Math.max(0, rect.width - editor.scrollDOM.clientWidth);
                    const gutter = Math.max(0, rect.right - rightInset - (contentRect.right - padding));
                    // viewport.from includes CM's off-screen render buffer. Measure
                    // the actual reading position, including variable-height widgets.
                    const height = editor.scrollDOM.clientHeight;
                    const atBottom = editor.scrollDOM.scrollTop > 0 &&
                        editor.scrollDOM.scrollHeight - height - editor.scrollDOM.scrollTop <= 2;
                    const position = atBottom ? editor.state.doc.length : editor.lineBlockAtHeight(
                        Math.max(0, rect.top + Math.min(32, height / 4) - editor.documentTop),
                    ).from;
                    return {
                        width: rect.width, height, rightInset, gutter,
                        activeId: findActiveHeading(snapshot.headings, position),
                    };
                },
                write: (measurement) => {
                    if (view === this.editor) publish({ ...snapshot, ...measurement });
                },
            });
        }

        destroy() {
            if (view !== this.editor) return;
            view = null;
            publish({ headings: [], activeId: null, width: 0, height: 0, rightInset: 0, gutter: 0 });
        }
    }, {
        eventHandlers: {
            scroll() { this.measure(); },
        },
    });

    return {
        extension,
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        select: (heading: OutlineHeading) => {
            // Reject stale UI destinations instead of jumping into unrelated text.
            if (!view || !snapshot.headings.includes(heading)) return;
            revealOutlineSelection(view, heading);
        },
    };
}

export type EditorOutlineBridge = ReturnType<typeof createEditorOutlineBridge>;
