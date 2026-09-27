import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { extractHeadings, type OutlineHeading } from "../../notes/outlineModel";
import { revealOutlineSelection } from "../outlineNavigation";

export interface EditorOutlineSnapshot {
    headings: readonly OutlineHeading[];
    /** Inclusive index range of headings lit on the rail, or -1/-1 when none. */
    inViewStart: number;
    inViewEnd: number;
    width: number;
    height: number;
    rightInset: number;
    gutter: number;
}

/** Index of the last heading starting at or before `position`, or -1. */
function headingIndexAt(headings: readonly OutlineHeading[], position: number) {
    let low = 0;
    let high = headings.length;
    while (low < high) {
        const mid = (low + high) >>> 1;
        if (headings[mid].anchor <= position) low = mid + 1;
        else high = mid;
    }
    return low - 1;
}

/**
 * Headings lit on the rail: the section containing the top of the viewport
 * plus every heading whose line starts inside it. Sorted anchors make the
 * result a contiguous range.
 */
export function resolveHeadingsInView(
    headings: readonly OutlineHeading[],
    top: number,
    bottom: number,
) {
    const start = Math.max(0, headingIndexAt(headings, top));
    const end = headingIndexAt(headings, bottom);
    return end < start ? { inViewStart: -1, inViewEnd: -1 } : { inViewStart: start, inViewEnd: end };
}

const EMPTY_SNAPSHOT: EditorOutlineSnapshot = {
    headings: [], inViewStart: -1, inViewEnd: -1, width: 0, height: 0, rightInset: 0, gutter: 0,
};

/** One bridge per Editor instance, including independent copies of the same note. */
export function createEditorOutlineBridge() {
    let view: EditorView | null = null;
    let snapshot = EMPTY_SNAPSHOT;
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
            publish({ ...snapshot, headings, inViewStart: -1, inViewEnd: -1 });
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
                    const scrolled = rect.top - editor.documentTop;
                    const atBottom = editor.scrollDOM.scrollTop > 0 &&
                        editor.scrollDOM.scrollHeight - height - editor.scrollDOM.scrollTop <= 2;
                    const top = editor.lineBlockAtHeight(
                        Math.max(0, scrolled + Math.min(32, height / 4)),
                    ).from;
                    // A heading counts once a sliver of its line is visible.
                    const bottom = atBottom ? editor.state.doc.length : editor.lineBlockAtHeight(
                        Math.max(0, scrolled + height - 8),
                    ).from;
                    return {
                        width: rect.width, height, rightInset, gutter,
                        ...resolveHeadingsInView(snapshot.headings, top, bottom),
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
            publish(EMPTY_SNAPSHOT);
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
