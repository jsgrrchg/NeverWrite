import { beforeEach, describe, expect, it } from "vitest";
import { MIN_SIDEBAR_WIDTH, useLayoutStore } from "./layoutStore";

describe("layoutStore", () => {
    beforeEach(() => {
        useLayoutStore.setState({
            editorPaneSizes: [1],
        });
    });

    it("normalizes and persists editor pane proportions", () => {
        useLayoutStore.getState().setEditorPaneSizes(3, [2, 1, 1]);

        expect(useLayoutStore.getState().editorPaneSizes).toEqual([
            0.5, 0.25, 0.25,
        ]);
        expect(localStorage.getItem("neverwrite.editor-pane.sizes")).toBe(
            JSON.stringify([0.5, 0.25, 0.25]),
        );
    });

    it("supports more than three persisted editor pane proportions", () => {
        useLayoutStore.getState().setEditorPaneSizes(6, [3, 1, 1, 1, 1, 1]);

        expect(useLayoutStore.getState().editorPaneSizes).toEqual([
            3 / 8,
            1 / 8,
            1 / 8,
            1 / 8,
            1 / 8,
            1 / 8,
        ]);
        expect(localStorage.getItem("neverwrite.editor-pane.sizes")).toBe(
            JSON.stringify([3 / 8, 1 / 8, 1 / 8, 1 / 8, 1 / 8, 1 / 8]),
        );
    });

    it("clamps the sidebar width to its minimum", () => {
        useLayoutStore.getState().setSidebarWidth(120);

        expect(useLayoutStore.getState().sidebarWidth).toBe(MIN_SIDEBAR_WIDTH);
        expect(localStorage.getItem("neverwrite.sidebar.width")).toBe(
            String(MIN_SIDEBAR_WIDTH),
        );
    });
});
