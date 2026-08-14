import { beforeEach, describe, expect, it } from "vitest";
import {
    createDefaultLayoutState,
    MIN_SIDEBAR_WIDTH,
    readHydratedLayoutSnapshot,
    useLayoutStore,
} from "./layoutStore";

describe("layoutStore", () => {
    beforeEach(() => {
        localStorage.clear();
        useLayoutStore.setState({
            ...createDefaultLayoutState(),
            rightPanelExpanded: false,
            editorPaneSizes: [1],
        });
    });

    it("moves an active view atomically and opens its destination", () => {
        useLayoutStore.getState().moveSidebarView("files", "left");
        useLayoutStore.setState({
            rightPanelCollapsed: true,
            rightPanelWidth: 200,
        });
        useLayoutStore.getState().moveSidebarView("files", "right");

        const state = useLayoutStore.getState();
        expect(state.movableSidebarPlacement.files).toBe("right");
        expect(state.activeSidebarView).toEqual({
            left: "agents",
            right: "files",
        });
        expect(state.rightPanelCollapsed).toBe(false);
        expect(state.rightPanelWidth).toBe(280);
    });

    it("moves an inactive view without changing the source selection", () => {
        useLayoutStore.getState().moveSidebarView("agents", "right");
        expect(useLayoutStore.getState().activeSidebarView).toEqual({
            left: "tags",
            right: "agents",
        });
    });

    it("shows a view on its current side", () => {
        useLayoutStore.setState({
            rightPanelCollapsed: true,
            activeSidebarView: { left: "tags", right: "outline" },
        });
        useLayoutStore.getState().showSidebarView("files");
        expect(useLayoutStore.getState()).toMatchObject({
            rightPanelCollapsed: false,
            activeSidebarView: { left: "tags", right: "files" },
        });
    });

    it("uses the active right view minimum while preserving broad expansion", () => {
        useLayoutStore.getState().activateSidebarView("right", "outline");
        useLayoutStore.getState().showRightPanelAtWidth(200);
        expect(useLayoutStore.getState().rightPanelWidth).toBe(200);
        useLayoutStore.getState().activateSidebarView("right", "files");
        useLayoutStore.getState().showRightPanelAtWidth(220);
        expect(useLayoutStore.getState().rightPanelWidth).toBe(280);
        useLayoutStore.getState().showRightPanelAtWidth(1600);
        expect(useLayoutStore.getState().rightPanelWidth).toBe(1600);
    });

    it("hydrates persisted placement and active selections", () => {
        localStorage.setItem(
            "neverwrite.sidebar.movable-placement.v1",
            JSON.stringify({ files: "right" }),
        );
        localStorage.setItem(
            "neverwrite.sidebar.active-views.v1",
            JSON.stringify({ left: "agents", right: "files" }),
        );
        expect(readHydratedLayoutSnapshot()).toMatchObject({
            movableSidebarPlacement: { files: "right", agents: "left" },
            activeSidebarView: { left: "agents", right: "files" },
        });
    });

    it("falls back safely for invalid persisted JSON and incompatible views", () => {
        localStorage.setItem("neverwrite.sidebar.movable-placement.v1", "{");
        localStorage.setItem(
            "neverwrite.sidebar.active-views.v1",
            JSON.stringify({ left: "outline", right: "maps" }),
        );
        expect(readHydratedLayoutSnapshot()).toMatchObject({
            movableSidebarPlacement: { files: "right", agents: "left" },
            activeSidebarView: { left: "agents", right: "outline" },
        });
    });

    it("uses the new layout for users without placement preferences", () => {
        localStorage.setItem("neverwrite.sidebar.view", "files");
        localStorage.setItem("neverwrite.rightpanel.view", "outline");
        expect(readHydratedLayoutSnapshot()).toMatchObject({
            movableSidebarPlacement: { files: "right", agents: "left" },
            activeSidebarView: { left: "agents", right: "files" },
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
