import { describe, expect, it } from "vitest";
import {
    buildLineStartOffsets,
    deriveOffsetLineRange,
    insertionLineIndexAtOffset,
    lineIndexAtOffset,
    lineIndexToOffset,
} from "./lineMap";

describe("lineMap", () => {
    it("builds stable line start offsets and resolves line indices from offsets", () => {
        const text = "alpha\nbeta\ngamma";
        const lineStarts = buildLineStartOffsets(text);

        expect(lineStarts).toEqual([0, 6, 11]);
        expect(lineIndexAtOffset(lineStarts, 0)).toBe(0);
        expect(lineIndexAtOffset(lineStarts, 6)).toBe(1);
        expect(lineIndexAtOffset(lineStarts, 15)).toBe(2);
        expect(insertionLineIndexAtOffset(lineStarts, 6)).toBe(1);
        expect(lineIndexToOffset(lineStarts, text, 2)).toBe(11);
        expect(lineIndexToOffset(lineStarts, text, 99)).toBe(text.length);
    });

    it("derives line ranges for both point ranges and non-empty ranges", () => {
        const text = "alpha\nbeta\ngamma";
        const lineStarts = buildLineStartOffsets(text);

        expect(deriveOffsetLineRange(lineStarts, 6, 10)).toEqual({
            start: 1,
            end: 2,
        });
        expect(deriveOffsetLineRange(lineStarts, 6, 6)).toEqual({
            start: 1,
            end: 1,
        });
    });
});
