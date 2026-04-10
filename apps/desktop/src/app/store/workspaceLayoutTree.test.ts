import { describe, expect, it } from "vitest";
import {
    assertLayoutInvariants,
    balanceSplit,
    closePaneAndCollapse,
    createInitialLayout,
    DEFAULT_EDITOR_PANE_ID,
    findPanePath,
    getLayoutPaneIds,
    getNextGeneratedPaneId,
    MAX_EDITOR_PANES,
    movePane,
    normalizeLayoutTree,
    resizeSplit,
    splitPane,
    type WorkspaceLayoutNode,
} from "./workspaceLayoutTree";

function makeThreePaneRow(): WorkspaceLayoutNode {
    return {
        type: "split",
        id: "split-1",
        direction: "row",
        sizes: [0.5, 0.25, 0.25],
        children: [
            { type: "pane", id: "pane-a", paneId: "pane-a" },
            { type: "pane", id: "pane-b", paneId: "pane-b" },
            { type: "pane", id: "pane-c", paneId: "pane-c" },
        ],
    };
}

describe("workspaceLayoutTree", () => {
    it("creates the initial layout as a single pane", () => {
        const tree = createInitialLayout();

        expect(tree).toEqual({
            type: "pane",
            id: DEFAULT_EDITOR_PANE_ID,
            paneId: DEFAULT_EDITOR_PANE_ID,
        });
    });

    it("generates pane ids dynamically while preserving legacy slots", () => {
        expect(getNextGeneratedPaneId(["primary"])).toBe("pane-2");
        expect(getNextGeneratedPaneId(["primary", "secondary"])).toBe("pane-3");
        expect(
            getNextGeneratedPaneId([
                "primary",
                "secondary",
                "tertiary",
                "pane-4",
                "pane-5",
            ]),
        ).toBe("pane-6");
        expect(
            getNextGeneratedPaneId([
                "primary",
                "secondary",
                "tertiary",
                "pane-4",
                "pane-5",
                "pane-6",
            ]),
        ).toBeNull();
        expect(MAX_EDITOR_PANES).toBe(6);
    });

    it("finds a pane path as child indexes from the root", () => {
        const tree = {
            type: "split",
            id: "split-1",
            direction: "row",
            sizes: [0.5, 0.5],
            children: [
                { type: "pane", id: "pane-a", paneId: "pane-a" },
                {
                    type: "split",
                    id: "split-2",
                    direction: "column",
                    sizes: [0.5, 0.5],
                    children: [
                        { type: "pane", id: "pane-b", paneId: "pane-b" },
                        { type: "pane", id: "pane-c", paneId: "pane-c" },
                    ],
                },
            ],
        } satisfies WorkspaceLayoutNode;

        expect(findPanePath(tree, "pane-a")).toEqual([0]);
        expect(findPanePath(tree, "pane-c")).toEqual([1, 1]);
        expect(findPanePath(tree, "missing")).toBeNull();
    });

    it("splits into the same direction without creating an extra nested split", () => {
        const tree = {
            type: "split",
            id: "split-1",
            direction: "row",
            sizes: [0.5, 0.5],
            children: [
                { type: "pane", id: "pane-a", paneId: "pane-a" },
                { type: "pane", id: "pane-b", paneId: "pane-b" },
            ],
        } satisfies WorkspaceLayoutNode;

        const next = splitPane(tree, "pane-a", "row", "pane-c");

        expect(next.type).toBe("split");
        if (next.type !== "split") {
            return;
        }

        expect(next.direction).toBe("row");
        expect(getLayoutPaneIds(next)).toEqual(["pane-a", "pane-c", "pane-b"]);
        expect(next.sizes).toEqual([0.25, 0.25, 0.5]);
    });

    it("splits into a perpendicular direction by nesting only the target pane", () => {
        const tree = {
            type: "split",
            id: "split-1",
            direction: "row",
            sizes: [0.5, 0.5],
            children: [
                { type: "pane", id: "pane-a", paneId: "pane-a" },
                { type: "pane", id: "pane-b", paneId: "pane-b" },
            ],
        } satisfies WorkspaceLayoutNode;

        const next = splitPane(tree, "pane-a", "column", "pane-c");

        expect(next.type).toBe("split");
        if (next.type !== "split") {
            return;
        }

        expect(next.direction).toBe("row");
        expect(next.children[0]).toMatchObject({
            type: "split",
            direction: "column",
        });
        expect(getLayoutPaneIds(next)).toEqual(["pane-a", "pane-c", "pane-b"]);
    });

    it("collapses a parent split when closing a pane leaves a single child", () => {
        const tree = {
            type: "split",
            id: "split-1",
            direction: "row",
            sizes: [0.5, 0.5],
            children: [
                { type: "pane", id: "pane-a", paneId: "pane-a" },
                {
                    type: "split",
                    id: "split-2",
                    direction: "column",
                    sizes: [0.5, 0.5],
                    children: [
                        { type: "pane", id: "pane-b", paneId: "pane-b" },
                        { type: "pane", id: "pane-c", paneId: "pane-c" },
                    ],
                },
            ],
        } satisfies WorkspaceLayoutNode;

        const next = closePaneAndCollapse(tree, "pane-b");

        expect(next.type).toBe("split");
        if (next.type !== "split") {
            return;
        }
        expect(getLayoutPaneIds(next)).toEqual(["pane-a", "pane-c"]);
        expect(next.children[1]).toMatchObject({
            type: "pane",
            paneId: "pane-c",
        });
    });

    it("moves panes around the tree and normalizes the result", () => {
        const tree = makeThreePaneRow();

        const next = movePane(tree, "pane-c", "pane-a", "down");

        expect(next.type).toBe("split");
        if (next.type !== "split") {
            return;
        }

        expect(getLayoutPaneIds(next)).toEqual(["pane-a", "pane-c", "pane-b"]);
        expect(next.children[0]).toMatchObject({
            type: "split",
            direction: "column",
        });
    });

    it("resizes and balances splits with normalized proportions", () => {
        const tree = makeThreePaneRow();

        const resized = resizeSplit(tree, "split-1", [2, 1, 1]);
        expect(resized).toMatchObject({
            type: "split",
            sizes: [0.5, 0.25, 0.25],
        });

        const balanced = balanceSplit(resized, "split-1");
        expect(balanced).toMatchObject({
            type: "split",
            sizes: [1 / 3, 1 / 3, 1 / 3],
        });
    });

    it("normalizes nested same-direction splits", () => {
        const tree = {
            type: "split",
            id: "split-1",
            direction: "row",
            sizes: [0.4, 0.6],
            children: [
                {
                    type: "split",
                    id: "split-2",
                    direction: "row",
                    sizes: [0.25, 0.75],
                    children: [
                        { type: "pane", id: "pane-a", paneId: "pane-a" },
                        { type: "pane", id: "pane-b", paneId: "pane-b" },
                    ],
                },
                { type: "pane", id: "pane-c", paneId: "pane-c" },
            ],
        } satisfies WorkspaceLayoutNode;

        const next = normalizeLayoutTree(tree);

        expect(next).toMatchObject({
            type: "split",
            direction: "row",
        });
        if (next.type !== "split") {
            return;
        }

        expect(getLayoutPaneIds(next)).toEqual(["pane-a", "pane-b", "pane-c"]);
        expect(next.sizes[0]).toBeCloseTo(0.1);
        expect(next.sizes[1]).toBeCloseTo(0.3);
        expect(next.sizes[2]).toBeCloseTo(0.6);
    });

    it("detects invalid trees eagerly in dev mode", () => {
        expect(() =>
            assertLayoutInvariants({
                type: "split",
                id: "split-1",
                direction: "row",
                sizes: [1],
                children: [{ type: "pane", id: "pane-a", paneId: "pane-a" }],
            }),
        ).toThrow(/at least two children/);

        expect(() =>
            assertLayoutInvariants({
                type: "split",
                id: "split-1",
                direction: "row",
                sizes: [0.5, 0.25],
                children: [
                    { type: "pane", id: "pane-a", paneId: "pane-a" },
                    { type: "pane", id: "pane-b", paneId: "pane-b" },
                ],
            }),
        ).toThrow(/sizes must sum to 1/);

        expect(() =>
            assertLayoutInvariants({
                type: "split",
                id: "split-1",
                direction: "row",
                sizes: [0.5, 0.5],
                children: [
                    { type: "pane", id: "pane-a", paneId: "pane-a" },
                    { type: "pane", id: "pane-b", paneId: "pane-a" },
                ],
            }),
        ).toThrow(/duplicate pane id/);
    });
});
