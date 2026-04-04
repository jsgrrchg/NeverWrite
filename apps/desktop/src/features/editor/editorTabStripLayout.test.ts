import { describe, expect, it } from "vitest";
import {
    EDITOR_TAB_MAX_WIDTH,
    EDITOR_TAB_MIN_WIDTH,
    resolveEditorTabLayout,
} from "./editorTabStripLayout";

describe("resolveEditorTabLayout", () => {
    it("caps tab width at the comfortable maximum when there is enough room", () => {
        expect(
            resolveEditorTabLayout({
                stripWidth: 520,
                tabCount: 3,
            }),
        ).toMatchObject({
            density: "comfortable",
            tabWidth: EDITOR_TAB_MAX_WIDTH,
            overflow: false,
        });
    });

    it("shrinks tabs continuously before reaching overflow", () => {
        const layout = resolveEditorTabLayout({
            stripWidth: 420,
            tabCount: 3,
        });

        expect(layout.density).toBe("compact");
        expect(layout.overflow).toBe(false);
        expect(layout.tabWidth).toBeGreaterThan(128);
        expect(layout.tabWidth).toBeLessThan(EDITOR_TAB_MAX_WIDTH);
    });

    it("enters overflow only after tabs hit the minimum width", () => {
        expect(
            resolveEditorTabLayout({
                stripWidth: 360,
                tabCount: 5,
            }),
        ).toMatchObject({
            density: "overflow",
            tabWidth: EDITOR_TAB_MIN_WIDTH,
            overflow: true,
        });
    });

    it("expands tabs again when more width becomes available", () => {
        const cramped = resolveEditorTabLayout({
            stripWidth: 420,
            tabCount: 3,
        });
        const roomy = resolveEditorTabLayout({
            stripWidth: 560,
            tabCount: 3,
            previousDensity: cramped.density,
        });

        expect(roomy.overflow).toBe(false);
        expect(roomy.tabWidth).toBeGreaterThan(cramped.tabWidth);
        expect(roomy.tabWidth).toBe(EDITOR_TAB_MAX_WIDTH);
        expect(roomy.density).toBe("comfortable");
    });
});
