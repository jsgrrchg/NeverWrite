import { describe, expect, it } from "vitest";
import { resolvePaneDropPosition } from "./workspaceTabDropPreview";

describe("workspaceTabDropPreview", () => {
    const paneRect = {
        left: 100,
        right: 500,
        top: 40,
        bottom: 340,
    };

    it("classifies the center region as add-as-tab", () => {
        expect(resolvePaneDropPosition(300, 180, paneRect)).toBe("center");
    });

    it("classifies each edge as a split target", () => {
        expect(resolvePaneDropPosition(112, 180, paneRect)).toBe("left");
        expect(resolvePaneDropPosition(488, 180, paneRect)).toBe("right");
        expect(resolvePaneDropPosition(300, 52, paneRect)).toBe("top");
        expect(resolvePaneDropPosition(300, 328, paneRect)).toBe("bottom");
    });
});
