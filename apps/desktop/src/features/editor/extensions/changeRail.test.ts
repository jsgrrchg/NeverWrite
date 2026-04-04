/**
 * @vitest-environment jsdom
 */
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewHunk } from "../../ai/diff/reviewProjection";
import {
    createChangeRailExtension,
    deriveChangeRailGeometry,
} from "./changeRail";

function makeReviewHunk(overrides: Partial<ReviewHunk> = {}): ReviewHunk {
    return {
        id: { trackedVersion: 1, key: "hunk-1" },
        identityKey: "note.md",
        trackedVersion: 1,
        oldStartLine: 0,
        oldEndLine: 1,
        newStartLine: 0,
        newEndLine: 1,
        visualStartLine: 0,
        visualEndLine: 1,
        baseFrom: 0,
        baseTo: 5,
        currentFrom: 6,
        currentTo: 16,
        memberSpans: [
            {
                spanIndex: 0,
                baseFrom: 0,
                baseTo: 5,
                currentFrom: 6,
                currentTo: 16,
            },
        ],
        chunkId: { trackedVersion: 1, key: "chunk-1" },
        overlapGroupId: "chunk-1::hunk-1",
        overlapGroupSize: 1,
        hasConflict: false,
        ambiguous: false,
        ...overrides,
    };
}

function mountChangeRailView(hunks: readonly ReviewHunk[]) {
    const parent = document.createElement("div");
    document.body.appendChild(parent);

    const state = EditorState.create({
        doc: "alpha\nbeta\ngamma\n",
        extensions: [createChangeRailExtension(hunks)],
    });
    const view = new EditorView({ state, parent });

    return {
        view,
        destroy() {
            view.destroy();
            parent.remove();
        },
    };
}

function readMarkerStyle(view: EditorView, key: string) {
    const marker = view.dom.querySelector<HTMLElement>(
        `[data-change-rail-key="${key}"]`,
    );
    expect(marker).not.toBeNull();
    return marker as HTMLElement;
}

async function waitForAnimationFrame() {
    await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
    });
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("changeRail", () => {
    it("derives marker geometry from rendered block positions instead of doc line ratios", () => {
        let contentHeight = 200;
        vi.spyOn(
            EditorView.prototype,
            "contentHeight",
            "get",
        ).mockImplementation(() => contentHeight);
        vi.spyOn(
            EditorView.prototype,
            "defaultLineHeight",
            "get",
        ).mockImplementation(() => 20);
        vi.spyOn(EditorView.prototype, "lineBlockAt").mockImplementation(
            (pos) => {
                if (pos < 6) {
                    return { top: 10, bottom: 30 } as never;
                }
                if (pos < 15) {
                    return { top: 80, bottom: 120 } as never;
                }
                return { top: 150, bottom: 190 } as never;
            },
        );

        const parent = document.createElement("div");
        document.body.appendChild(parent);
        const view = new EditorView({
            state: EditorState.create({ doc: "alpha\nbeta\ngamma\n" }),
            parent,
        });

        const [marker] = deriveChangeRailGeometry(view, [makeReviewHunk()]);
        expect(marker).toEqual({
            key: "hunk-1",
            topRatio: 0.4,
            heightRatio: 0.55,
        });

        view.destroy();
        parent.remove();
    });

    it("refreshes marker positions when layout geometry changes without changing hunks", async () => {
        let contentHeight = 200;
        let geometryMode: "initial" | "wrapped" = "initial";
        vi.spyOn(
            EditorView.prototype,
            "contentHeight",
            "get",
        ).mockImplementation(() => contentHeight);
        vi.spyOn(
            EditorView.prototype,
            "defaultLineHeight",
            "get",
        ).mockImplementation(() => 20);
        vi.spyOn(EditorView.prototype, "lineBlockAt").mockImplementation(() =>
            geometryMode === "initial"
                ? ({ top: 20, bottom: 40 } as never)
                : ({ top: 90, bottom: 170 } as never),
        );

        const { view, destroy } = mountChangeRailView([makeReviewHunk()]);
        const marker = readMarkerStyle(view, "hunk-1");
        expect(parseFloat(marker.style.top)).toBeCloseTo(10, 3);
        expect(parseFloat(marker.style.height)).toBeCloseTo(10, 3);

        geometryMode = "wrapped";
        contentHeight = 300;
        window.dispatchEvent(new Event("resize"));
        await waitForAnimationFrame();

        const refreshedMarker = readMarkerStyle(view, "hunk-1");
        expect(parseFloat(refreshedMarker.style.top)).toBeCloseTo(30, 3);
        expect(parseFloat(refreshedMarker.style.height)).toBeCloseTo(26.667, 3);

        destroy();
    });
});
