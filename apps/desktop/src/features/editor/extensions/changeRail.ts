import { type Extension, Facet } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import type { ReviewHunk } from "../../ai/diff/reviewProjection";

// ── Facet to pass hunks into the plugin ────────────────────────
export const changeRailHunksFacet = Facet.define<
    readonly ReviewHunk[],
    readonly ReviewHunk[]
>({
    combine(values) {
        return values.length > 0 ? values[0] : [];
    },
});

// ── Constants ──────────────────────────────────────────────────
const RAIL_WIDTH = 10;
const MARKER_MIN_HEIGHT = 4;

// ── ViewPlugin ─────────────────────────────────────────────────
const changeRailPlugin = ViewPlugin.fromClass(
    class {
        readonly rail: HTMLElement;
        private view: EditorView;
        private markers: HTMLElement[] = [];
        private lastSignature = "";

        constructor(view: EditorView) {
            this.view = view;
            this.rail = document.createElement("div");
            this.rail.className = "cm-change-rail";
            view.dom.appendChild(this.rail);
            this.render();
        }

        update() {
            this.render();
        }

        private render() {
            const hunks = this.view.state.facet(changeRailHunksFacet);
            const docLines = this.view.state.doc.lines;
            if (docLines === 0 || hunks.length === 0) {
                if (this.markers.length > 0) {
                    this.clearMarkers();
                    this.lastSignature = "";
                }
                this.rail.style.display = "none";
                return;
            }

            // Build a quick signature to avoid redundant DOM work
            const sig = hunks
                .map((h) => `${h.visualStartLine}:${h.visualEndLine}`)
                .join(",");
            if (sig === this.lastSignature) {
                this.rail.style.display = "";
                return;
            }
            this.lastSignature = sig;
            this.clearMarkers();
            this.rail.style.display = "";

            for (const hunk of hunks) {
                const startFrac = hunk.visualStartLine / docLines;
                const endFrac = (hunk.visualEndLine + 1) / docLines;

                const marker = document.createElement("div");
                marker.className = "cm-change-rail-marker";
                marker.style.top = `${(startFrac * 100).toFixed(3)}%`;
                const heightPct = (endFrac - startFrac) * 100;
                marker.style.height =
                    heightPct < 0.3
                        ? `${MARKER_MIN_HEIGHT}px`
                        : `${heightPct.toFixed(3)}%`;

                this.rail.appendChild(marker);
                this.markers.push(marker);
            }
        }

        private clearMarkers() {
            for (const m of this.markers) m.remove();
            this.markers = [];
        }

        destroy() {
            this.rail.remove();
        }
    },
);

// ── Theme ──────────────────────────────────────────────────────
const changeRailTheme = EditorView.baseTheme({
    ".cm-change-rail": {
        position: "absolute",
        top: "0",
        right: "22px",
        bottom: "0",
        width: `${RAIL_WIDTH}px`,
        zIndex: "4",
        pointerEvents: "none",
    },
    ".cm-change-rail-marker": {
        position: "absolute",
        left: "0",
        width: "100%",
        minHeight: `${MARKER_MIN_HEIGHT}px`,
        borderRadius: `${RAIL_WIDTH / 2}px`,
        backgroundColor: "var(--diff-add)",
        opacity: "0.7",
    },
});

// ── Public API ─────────────────────────────────────────────────
export function createChangeRailExtension(
    hunks: readonly ReviewHunk[],
): Extension[] {
    return [changeRailHunksFacet.of(hunks), changeRailPlugin, changeRailTheme];
}
