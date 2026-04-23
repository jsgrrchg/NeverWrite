import { describe, expect, it } from "vitest";
import { resolveRendererDevUrl } from "./window";

describe("resolveRendererDevUrl", () => {
    it("returns the dev URL for unpackaged builds", () => {
        expect(
            resolveRendererDevUrl(
                "http://127.0.0.1:5173/",
                false,
                "?panel=updates",
            ),
        ).toBe("http://127.0.0.1:5173/?panel=updates");
    });

    it("disables the dev URL for packaged builds", () => {
        expect(
            resolveRendererDevUrl(
                "http://127.0.0.1:5173/",
                true,
                "?panel=updates",
            ),
        ).toBeNull();
    });
});
