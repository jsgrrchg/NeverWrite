import { Text } from "@codemirror/state";
import { Chunk } from "@codemirror/merge";
import { describe, expect, it } from "vitest";
import { getChunkLineRangeInDocB, getChunkKind } from "./mergeChunkRange";

function buildChunk(diffBase: string, currentText: string) {
    return Chunk.build(
        Text.of(diffBase.split("\n")),
        Text.of(currentText.split("\n")),
    )[0]!;
}

describe("mergeChunkRange", () => {
    it("maps insertions at EOF to the inserted line range", () => {
        const doc = Text.of("alpha\nbeta\ngamma".split("\n"));
        const chunk = buildChunk("alpha\nbeta", "alpha\nbeta\ngamma");

        expect(getChunkKind(chunk)).toBe("add");
        expect(getChunkLineRangeInDocB(chunk, doc)).toEqual({
            startLine: 2,
            endLine: 3,
            anchorLine: 2,
        });
    });

    it("maps deletions at EOF to an empty range on the removed anchor line", () => {
        const doc = Text.of("alpha\nbeta".split("\n"));
        const chunk = buildChunk("alpha\nbeta\ngamma", "alpha\nbeta");

        expect(getChunkKind(chunk)).toBe("delete");
        expect(getChunkLineRangeInDocB(chunk, doc)).toEqual({
            startLine: 2,
            endLine: 2,
            anchorLine: 2,
        });
    });

    it("maps multiline modifications to an exclusive end line", () => {
        const doc = Text.of("alpha\nBETA\nGAMMA".split("\n"));
        const chunk = buildChunk("alpha\nbeta\ngamma", "alpha\nBETA\nGAMMA");

        expect(getChunkKind(chunk)).toBe("modify");
        expect(getChunkLineRangeInDocB(chunk, doc)).toEqual({
            startLine: 1,
            endLine: 3,
            anchorLine: 1,
        });
    });

    it("keeps insertions stable in the empty document", () => {
        const doc = Text.of(["hello"]);
        const chunk = buildChunk("", "hello");

        expect(getChunkLineRangeInDocB(chunk, doc)).toEqual({
            startLine: 0,
            endLine: 1,
            anchorLine: 0,
        });
    });
});
