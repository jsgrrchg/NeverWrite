import { describe, expect, it } from "vitest";
import { findAdjacentPane } from "./workspaceLayoutNavigation";
import type { WorkspaceLayoutNode } from "./workspaceLayoutTree";

describe("workspaceLayoutNavigation", () => {
    it("finds left, right, up and down neighbors from a grid-like split tree", () => {
        const tree = {
            type: "split",
            id: "split-root",
            direction: "column",
            sizes: [0.5, 0.5],
            children: [
                {
                    type: "split",
                    id: "split-top",
                    direction: "row",
                    sizes: [0.5, 0.5],
                    children: [
                        { type: "pane", id: "pane-a", paneId: "pane-a" },
                        { type: "pane", id: "pane-b", paneId: "pane-b" },
                    ],
                },
                {
                    type: "split",
                    id: "split-bottom",
                    direction: "row",
                    sizes: [0.5, 0.5],
                    children: [
                        { type: "pane", id: "pane-c", paneId: "pane-c" },
                        { type: "pane", id: "pane-d", paneId: "pane-d" },
                    ],
                },
            ],
        } satisfies WorkspaceLayoutNode;

        expect(findAdjacentPane(tree, "pane-a", "right")).toBe("pane-b");
        expect(findAdjacentPane(tree, "pane-a", "down")).toBe("pane-c");
        expect(findAdjacentPane(tree, "pane-d", "left")).toBe("pane-c");
        expect(findAdjacentPane(tree, "pane-d", "up")).toBe("pane-b");
        expect(findAdjacentPane(tree, "pane-a", "left")).toBeNull();
        expect(findAdjacentPane(tree, "pane-a", "up")).toBeNull();
    });

    it("prefers the nearest overlapping pane in the requested direction", () => {
        const tree = {
            type: "split",
            id: "split-root",
            direction: "row",
            sizes: [0.5, 0.5],
            children: [
                { type: "pane", id: "pane-a", paneId: "pane-a" },
                {
                    type: "split",
                    id: "split-right",
                    direction: "column",
                    sizes: [0.6, 0.4],
                    children: [
                        { type: "pane", id: "pane-b", paneId: "pane-b" },
                        { type: "pane", id: "pane-c", paneId: "pane-c" },
                    ],
                },
            ],
        } satisfies WorkspaceLayoutNode;

        expect(findAdjacentPane(tree, "pane-c", "up")).toBe("pane-b");
        expect(findAdjacentPane(tree, "pane-b", "down")).toBe("pane-c");
    });
});
