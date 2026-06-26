import { EditorView, hoverTooltip, type Tooltip } from "@codemirror/view";
import { findWikilinkAtPosition } from "./wikilinks";
import {
    findPreviewNote,
    getNotePreviewContentState,
    renderEmbedPreview,
} from "./notePreviewSource";

// Default delay before the hover preview opens. Long enough to avoid firing on
// every sweep of the mouse across links.
export const DEFAULT_WIKILINK_HOVER_DELAY_MS = 300;

// Lines of the target note to show in the floating preview. Bounded so large
// notes never load or render in full just for a hover.
const HOVER_MAX_LINES = 8;

const hoverTheme = EditorView.baseTheme({
    ".cm-tooltip:has(.cm-wikilink-hover)": {
        border: "1px solid var(--border)",
        borderRadius: "8px",
        backgroundColor: "var(--bg-elevated, var(--bg-secondary))",
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.18)",
        maxWidth: "420px",
        overflow: "hidden",
    },
    ".cm-wikilink-hover": {
        padding: "10px 12px",
        font: "inherit",
        color: "var(--text-primary)",
        lineHeight: "1.4",
    },
    ".cm-wikilink-hover-title": {
        fontWeight: "700",
        color: "var(--text-primary)",
        marginBottom: "4px",
    },
    ".cm-wikilink-hover-meta": {
        color: "var(--text-secondary)",
        fontSize: "0.82em",
    },
    ".cm-wikilink-hover-body": {
        fontSize: "0.88em",
        color: "var(--text-secondary)",
        lineHeight: "1.5",
    },
    ".cm-wikilink-hover-body > div": {
        marginBottom: "2px",
    },
    ".cm-wikilink-hover-body .cm-note-embed-h1, .cm-wikilink-hover-body .cm-note-embed-h2, .cm-wikilink-hover-body .cm-note-embed-h3, .cm-wikilink-hover-body .cm-note-embed-h4, .cm-wikilink-hover-body .cm-note-embed-h5, .cm-wikilink-hover-body .cm-note-embed-h6":
        {
            fontWeight: "600",
            color: "var(--text-primary)",
        },
    ".cm-wikilink-hover-body .cm-note-embed-h1": { fontSize: "1.15em" },
    ".cm-wikilink-hover-body .cm-note-embed-h2": { fontSize: "1.08em" },
    ".cm-wikilink-hover-body .cm-note-embed-li": {
        paddingLeft: "1.2em",
        position: "relative",
    },
    ".cm-wikilink-hover-body .cm-note-embed-li::before": {
        content: '"\\2022"',
        position: "absolute",
        left: "0.3em",
        color: "var(--text-secondary)",
    },
    ".cm-wikilink-hover-body code": {
        fontSize: "0.9em",
        padding: "1px 4px",
        borderRadius: "3px",
        background:
            "color-mix(in srgb, var(--bg-tertiary) 60%, var(--bg-primary))",
    },
    ".cm-wikilink-hover-body .cm-note-embed-wikilink": {
        color: "var(--accent)",
        textDecoration: "underline",
        textDecorationStyle: "dotted",
        textUnderlineOffset: "2px",
    },
});

/**
 * Build the hover tooltip for a document position, or null when the position
 * is not inside a wikilink. Exposed separately so the trigger logic can be unit
 * tested without simulating real mouse hover and timers.
 */
export function buildWikilinkHoverTooltip(
    view: EditorView,
    pos: number,
): Tooltip | null {
    const match = findWikilinkAtPosition(view, pos);
    if (!match || !match.target) return null;

    const target = match.target;

    return {
        pos: match.from,
        end: match.to,
        above: true,
        arrow: false,
        create() {
            const dom = document.createElement("div");
            dom.className = "cm-wikilink-hover";

            const note = findPreviewNote(target);

            const title = document.createElement("div");
            title.className = "cm-wikilink-hover-title";
            title.textContent = note?.title ?? target;
            dom.appendChild(title);

            const body = document.createElement("div");
            body.className = "cm-wikilink-hover-body";
            dom.appendChild(body);

            // Track teardown so an async content load can't repaint a tooltip
            // CodeMirror has already closed.
            let active = true;

            const renderPreview = (content: string) => {
                body.replaceChildren(
                    renderEmbedPreview(content, HOVER_MAX_LINES),
                );
            };

            const showPlaceholder = (text: string) => {
                const meta = document.createElement("div");
                meta.className = "cm-wikilink-hover-meta";
                meta.textContent = text;
                body.replaceChildren(meta);
            };

            const { content, load } = getNotePreviewContentState(note, target);
            if (content !== null) {
                renderPreview(content);
            } else if (load) {
                showPlaceholder("Loading…");
                void load().then((loaded) => {
                    if (!active || loaded === null) return;
                    renderPreview(loaded);
                });
            }

            return {
                dom,
                destroy() {
                    active = false;
                },
            };
        },
    };
}

/**
 * Show a floating preview when hovering over a `[[wikilink]]`.
 */
export function wikilinkHoverPreviewExtension(
    hoverTime: number = DEFAULT_WIKILINK_HOVER_DELAY_MS,
) {
    const tooltip = hoverTooltip(buildWikilinkHoverTooltip, { hoverTime });
    return [tooltip, hoverTheme];
}
