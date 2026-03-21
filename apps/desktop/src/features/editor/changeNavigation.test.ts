import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import type { ChangeRailMarker } from "./changePresentationModel";
import {
    getAdjacentMarker,
    getMarkerKeyForLine,
    getMarkerKeyForSelection,
    getMarkerKeyForViewport,
    revealChangeMarker,
} from "./changeNavigation";

function makeMarker(
    key: string,
    kind: ChangeRailMarker["kind"],
    startLine: number,
    endLine: number,
): ChangeRailMarker {
    return {
        key,
        startLine,
        endLine,
        anchorLine: startLine,
        kind,
        reviewState: "finalized",
        topRatio: 0,
        heightRatio: 0.25,
    };
}

function makeViewMock(doc: string, anchor = 0) {
    const lineBlockAtHeight = vi.fn(() => ({ from: 0 }));

    return {
        state: EditorState.create({
            doc,
            selection: { anchor },
        }),
        dispatch: vi.fn(),
        focus: vi.fn(),
        scrollDOM: { scrollTop: 0 },
        dom: document.createElement("div"),
        lineBlockAtHeight,
    } as unknown as EditorView;
}

describe("changeNavigation", () => {
    it("wraps around to the first and last marker when stepping", () => {
        const markers = [
            makeMarker("edit-0", "add", 0, 1),
            makeMarker("edit-1", "modify", 4, 5),
            makeMarker("edit-2", "delete", 8, 8),
        ];

        expect(getAdjacentMarker(markers, null, 1)?.key).toBe("edit-0");
        expect(getAdjacentMarker(markers, null, -1)?.key).toBe("edit-2");
        expect(getAdjacentMarker(markers, "edit-2", 1)?.key).toBe("edit-0");
        expect(getAdjacentMarker(markers, "edit-0", -1)?.key).toBe("edit-2");
    });

    it("finds the matching marker or the nearest marker for a line", () => {
        const markers = [
            makeMarker("edit-0", "add", 0, 1),
            makeMarker("edit-1", "modify", 4, 6),
            makeMarker("edit-2", "delete", 9, 9),
        ];

        expect(getMarkerKeyForLine(markers, 0)).toBe("edit-0");
        expect(getMarkerKeyForLine(markers, 4)).toBe("edit-1");
        expect(getMarkerKeyForLine(markers, 8)).toBe("edit-2");
        expect(getMarkerKeyForLine([], 2)).toBeNull();
    });

    it("reads marker keys from the selection and viewport", () => {
        const markers = [
            makeMarker("edit-0", "add", 0, 1),
            makeMarker("edit-1", "modify", 2, 3),
        ];
        const view = makeViewMock("alpha\nbeta\ngamma", 12);
        (view.lineBlockAtHeight as ReturnType<typeof vi.fn>).mockReturnValueOnce({
            from: 12,
        });

        expect(getMarkerKeyForSelection(view, markers)).toBe("edit-1");
        expect(getMarkerKeyForViewport(view, markers)).toBe("edit-1");
    });

    it("reveals the marker and clamps the anchor to the document end", () => {
        const view = makeViewMock("alpha\nbeta");
        const marker = makeMarker("edit-0", "add", 5, 6);

        revealChangeMarker(view, marker);

        expect(view.dispatch).toHaveBeenCalledWith({
            selection: {
                anchor: 6,
                head: 6,
            },
            scrollIntoView: true,
        });
        expect(view.focus).toHaveBeenCalled();
    });
});
