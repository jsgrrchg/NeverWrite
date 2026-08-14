import { describe, expect, it } from "vitest";
import {
    getSidebarFallbackView,
    getSidebarViews,
    normalizeActiveSidebarView,
    normalizeMovableSidebarPlacement,
} from "./sidebarViews";

describe("sidebarViews", () => {
    it("returns the canonical default order", () => {
        const placement = { files: "left", agents: "left" } as const;
        expect(getSidebarViews("left", placement)).toEqual([
            "files",
            "agents",
            "tags",
            "bookmarks",
            "maps",
        ]);
        expect(getSidebarViews("right", placement)).toEqual([
            "outline",
            "links",
        ]);
    });

    it.each([
        ["left", "left"],
        ["left", "right"],
        ["right", "left"],
        ["right", "right"],
    ] as const)(
        "places every view exactly once for files=%s agents=%s",
        (files, agents) => {
            const placement = { files, agents };
            const all = [
                ...getSidebarViews("left", placement),
                ...getSidebarViews("right", placement),
            ];
            expect(all).toHaveLength(7);
            expect(new Set(all).size).toBe(7);
        },
    );

    it("normalizes corrupt and partial placements", () => {
        expect(normalizeMovableSidebarPlacement(undefined)).toEqual({
            files: "left",
            agents: "left",
        });
        expect(
            normalizeMovableSidebarPlacement({
                files: "right",
                agents: "elsewhere",
            }),
        ).toEqual({ files: "right", agents: "left" });
    });

    it("uses deterministic side fallbacks", () => {
        const placement = { files: "right", agents: "left" } as const;
        expect(getSidebarFallbackView("left", placement)).toBe("agents");
        expect(getSidebarFallbackView("right", placement)).toBe("outline");
        expect(normalizeActiveSidebarView("left", "files", placement)).toBe(
            "agents",
        );
    });
});
