import { describe, expect, it } from "vitest";
import { getComposerAnchoredPickerWidth } from "./menuPosition";

describe("getComposerAnchoredPickerWidth", () => {
    it("matches the chat width while retaining a viewport gutter", () => {
        expect(getComposerAnchoredPickerWidth(640, 1440)).toBe(640);
        expect(getComposerAnchoredPickerWidth(640, 500)).toBe(484);
    });

    it("uses a practical fallback before the chat has been measured", () => {
        expect(getComposerAnchoredPickerWidth(0, 1440)).toBe(320);
    });
});
