import { beforeEach, describe, expect, it } from "vitest";
import {
    DEFAULT_BOTTOM_PANEL_HEIGHT,
    MAX_BOTTOM_PANEL_HEIGHT_RATIO,
    MIN_BOTTOM_PANEL_HEIGHT,
    useLayoutStore,
} from "./layoutStore";

describe("layoutStore bottom panel", () => {
    beforeEach(() => {
        Object.defineProperty(window, "innerHeight", {
            value: 1000,
            configurable: true,
        });
        useLayoutStore.setState({
            bottomPanelCollapsed: true,
            bottomPanelHeight: DEFAULT_BOTTOM_PANEL_HEIGHT,
            bottomPanelView: "terminal",
        });
    });

    it("shows the bottom panel and persists its height", () => {
        useLayoutStore.getState().showBottomPanelAtHeight(320);

        expect(useLayoutStore.getState()).toMatchObject({
            bottomPanelCollapsed: false,
            bottomPanelHeight: 320,
            bottomPanelView: "terminal",
        });
        expect(localStorage.getItem("neverwrite.bottompanel.height")).toBe(
            "320",
        );
        expect(localStorage.getItem("neverwrite.bottompanel.collapsed")).toBe(
            "false",
        );
    });

    it("clamps and persists collapsed bottom panel height", () => {
        useLayoutStore.getState().collapseBottomPanelToHeight(9999);

        expect(useLayoutStore.getState().bottomPanelCollapsed).toBe(true);
        expect(useLayoutStore.getState().bottomPanelHeight).toBe(
            Math.round(1000 * MAX_BOTTOM_PANEL_HEIGHT_RATIO),
        );
    });

    it("activates the bottom view and expands the panel", () => {
        useLayoutStore.getState().collapseBottomPanelToHeight(40);
        useLayoutStore.getState().activateBottomView("terminal");

        expect(useLayoutStore.getState()).toMatchObject({
            bottomPanelCollapsed: false,
            bottomPanelHeight: MIN_BOTTOM_PANEL_HEIGHT,
            bottomPanelView: "terminal",
        });
        expect(localStorage.getItem("neverwrite.bottompanel.view")).toBe(
            "terminal",
        );
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
});
