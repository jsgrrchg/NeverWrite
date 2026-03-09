import { describe, expect, it } from "vitest";
import { getTabStripScrollTarget } from "./tabStrip";

describe("getTabStripScrollTarget", () => {
    it("does not move when the active tab is already comfortably visible", () => {
        expect(
            getTabStripScrollTarget({
                stripLeft: 100,
                stripWidth: 320,
                scrollWidth: 900,
                nodeLeft: 140,
                nodeWidth: 120,
            }),
        ).toBeNull();
    });

    it("reveals the minimum needed area when the active tab is at the far right", () => {
        expect(
            getTabStripScrollTarget({
                stripLeft: 220,
                stripWidth: 320,
                scrollWidth: 900,
                nodeLeft: 500,
                nodeWidth: 120,
            }),
        ).toBe(312);
    });

    it("clamps the scroll target to the maximum available range", () => {
        expect(
            getTabStripScrollTarget({
                stripLeft: 460,
                stripWidth: 320,
                scrollWidth: 800,
                nodeLeft: 730,
                nodeWidth: 120,
            }),
        ).toBe(480);
    });
});
