import { EditorView, hoverTooltip, type Tooltip } from "@codemirror/view";
import { findWikilinkAtPosition } from "./wikilinks";

// Default delay before the hover preview opens. Long enough to avoid firing on
// every sweep of the mouse across links.
export const DEFAULT_WIKILINK_HOVER_DELAY_MS = 300;

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
        padding: "8px 10px",
        font: "inherit",
        color: "var(--text-primary)",
        lineHeight: "1.4",
    },
    ".cm-wikilink-hover-title": {
        fontWeight: "600",
        fontSize: "0.85em",
        color: "var(--text-secondary)",
    },
});

/**
 * Build the hover tooltip for a document position, or null when the position
 * is not inside a wikilink. Exposed separately so the trigger logic can be unit
 * tested without simulating real mouse hover and timers.
 *
 * This commit wires only the trigger: the tooltip is a minimal anchor showing
 * the target name. Content rendering arrives in a later commit.
 */
export function buildWikilinkHoverTooltip(
    view: EditorView,
    pos: number,
): Tooltip | null {
    const match = findWikilinkAtPosition(view, pos);
    if (!match || !match.target) return null;

    return {
        pos: match.from,
        end: match.to,
        above: true,
        arrow: false,
        create() {
            const dom = document.createElement("div");
            dom.className = "cm-wikilink-hover";

            const title = document.createElement("div");
            title.className = "cm-wikilink-hover-title";
            title.textContent = match.target;
            dom.appendChild(title);

            return { dom };
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
