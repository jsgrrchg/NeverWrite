import { describe, expect, it } from "vitest";
import {
    WORKSPACE_PINNED_TAB_SIZE,
    WORKSPACE_TAB_HEIGHT,
    WORKSPACE_TAB_RADIUS,
    getWorkspaceTabStyle,
} from "./workspaceTabChrome";

describe("getWorkspaceTabStyle", () => {
    it("renders idle tabs as floating capsules instead of flush chrome tabs", () => {
        const style = getWorkspaceTabStyle({
            isActive: false,
            isDragging: false,
            tabWidth: 144,
            tabGap: 6,
            tabPaddingX: 12,
        });

        expect(style.height).toBe(WORKSPACE_TAB_HEIGHT);
        expect(style.borderRadius).toBe(WORKSPACE_TAB_RADIUS);
        expect(style.background).toBe("transparent");
        expect(style.border).toBe("1px solid transparent");
        expect(style.boxShadow).toBe("none");
    });

    it("marks the active tab with a lifted surface", () => {
        const style = getWorkspaceTabStyle({
            isActive: true,
            isDragging: false,
            tabWidth: 144,
            tabGap: 6,
            tabPaddingX: 12,
        });

        expect(style.background).toContain("var(--accent)");
        expect(style.boxShadow).not.toContain("inset 2px 0 0 0");
        expect(style.border).toContain("var(--accent)");
        expect(style.color).toBe("var(--text-primary)");
    });

    it("keeps pinned tabs as compact capsules", () => {
        const style = getWorkspaceTabStyle({
            isActive: false,
            isDragging: false,
            isPinned: true,
            tabWidth: 144,
            tabGap: 6,
            tabPaddingX: 12,
        });

        expect(style.width).toBe(WORKSPACE_PINNED_TAB_SIZE);
        expect(style.maxWidth).toBe(WORKSPACE_PINNED_TAB_SIZE);
        expect(style.padding).toBe(0);
        expect(style.justifyContent).toBe("center");
    });
});
