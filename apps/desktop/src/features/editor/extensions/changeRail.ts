import { type Extension, Facet } from "@codemirror/state";
import { EditorView, type ViewUpdate, ViewPlugin } from "@codemirror/view";
import type { ReviewHunk } from "../../ai/diff/reviewProjection";
import { EditorGeometryRefreshController } from "./editorGeometryRefresh";

export interface ChangeRailGeometryMarker {
    key: string;
    topRatio: number;
    heightRatio: number;
}

// Facet to pass hunks into the plugin
export const changeRailHunksFacet = Facet.define<
    readonly ReviewHunk[],
    readonly ReviewHunk[]
>({
    combine(values) {
        return values.length > 0 ? values[0] : [];
    },
});

const RAIL_WIDTH = 3;
const MARKER_MIN_HEIGHT = 3;

function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max);
}

function clampDocPos(view: EditorView, pos: number) {
    return Math.max(0, Math.min(pos, view.state.doc.length));
}

function roundGeometry(value: number) {
    return Math.round(value * 1000) / 1000;
}

function buildMarkerSignature(markers: readonly ChangeRailGeometryMarker[]) {
    return markers
        .map(
            (marker) =>
                `${marker.key}:${roundGeometry(marker.topRatio)}:${roundGeometry(marker.heightRatio)}`,
        )
        .join(",");
}

function readChangeRailGeometryKey(view: EditorView) {
    return JSON.stringify([
        Math.round(view.contentHeight * 100) / 100,
        view.scrollDOM.clientHeight,
        view.scrollDOM.clientWidth,
        view.contentDOM.clientWidth,
        Math.round(view.defaultLineHeight * 100) / 100,
        window.devicePixelRatio || 1,
    ]);
}

export function deriveChangeRailGeometry(
    view: EditorView,
    hunks: readonly ReviewHunk[],
): ChangeRailGeometryMarker[] {
    if (hunks.length === 0) {
        return [];
    }

    const contentHeight = Math.max(view.contentHeight, 1);
    const fallbackBlockHeight = Math.max(view.defaultLineHeight, 1);

    return hunks.map((hunk) => {
        const from = clampDocPos(view, hunk.currentFrom);
        const to = clampDocPos(view, hunk.currentTo);
        const startBlock = view.lineBlockAt(from);
        const endBlock =
            to > from
                ? view.lineBlockAt(clampDocPos(view, Math.max(from, to - 1)))
                : startBlock;

        const rawTop = Number.isFinite(startBlock.top) ? startBlock.top : 0;
        const rawBottom = Number.isFinite(endBlock.bottom)
            ? endBlock.bottom
            : rawTop + fallbackBlockHeight;
        const height = Math.max(rawBottom - rawTop, fallbackBlockHeight);
        const heightRatio = clamp(height / contentHeight, 0, 1);
        const maxTopRatio = Math.max(0, 1 - heightRatio);

        return {
            key: hunk.id.key,
            topRatio: clamp(rawTop / contentHeight, 0, maxTopRatio),
            heightRatio,
        };
    });
}

const changeRailPlugin = ViewPlugin.fromClass(
    class {
        readonly rail: HTMLElement;
        private readonly view: EditorView;
        private markers: HTMLElement[] = [];
        private lastRenderSignature = "";
        private readonly geometryRefresh: EditorGeometryRefreshController;

        constructor(view: EditorView) {
            this.view = view;
            this.rail = document.createElement("div");
            this.rail.className = "cm-change-rail";
            view.dom.appendChild(this.rail);
            this.geometryRefresh = new EditorGeometryRefreshController({
                view,
                readKey: readChangeRailGeometryKey,
                onGeometryChange: () => {
                    this.render();
                },
            });
            this.render();
        }

        update(update: ViewUpdate) {
            if (
                update.docChanged ||
                update.startState.facet(changeRailHunksFacet) !==
                    update.state.facet(changeRailHunksFacet)
            ) {
                this.render();
            }
            this.geometryRefresh.update(update);
        }

        private render() {
            const hunks = this.view.state.facet(changeRailHunksFacet);
            if (hunks.length === 0) {
                if (this.markers.length > 0) {
                    this.clearMarkers();
                    this.lastRenderSignature = "";
                }
                this.rail.style.display = "none";
                return;
            }

            const markers = deriveChangeRailGeometry(this.view, hunks);
            const signature = buildMarkerSignature(markers);
            if (signature === this.lastRenderSignature) {
                this.rail.style.display = "";
                return;
            }

            this.lastRenderSignature = signature;
            this.clearMarkers();
            this.rail.style.display = "";

            for (const markerData of markers) {
                const marker = document.createElement("div");
                marker.className = "cm-change-rail-marker";
                marker.dataset.changeRailKey = markerData.key;
                marker.style.top = `${(markerData.topRatio * 100).toFixed(3)}%`;
                const heightPct = markerData.heightRatio * 100;
                marker.style.height =
                    heightPct < 0.3
                        ? `${MARKER_MIN_HEIGHT}px`
                        : `${heightPct.toFixed(3)}%`;
                this.rail.appendChild(marker);
                this.markers.push(marker);
            }
        }

        private clearMarkers() {
            for (const marker of this.markers) {
                marker.remove();
            }
            this.markers = [];
        }

        destroy() {
            this.geometryRefresh.destroy();
            this.rail.remove();
        }
    },
);

const changeRailTheme = EditorView.baseTheme({
    ".cm-change-rail": {
        position: "absolute",
        top: "0",
        right: "3px",
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

export function createChangeRailExtension(
    hunks: readonly ReviewHunk[],
): Extension[] {
    return [changeRailHunksFacet.of(hunks), changeRailPlugin, changeRailTheme];
}
