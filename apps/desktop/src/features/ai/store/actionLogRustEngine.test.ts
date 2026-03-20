import { beforeEach, describe, expect, it, vi } from "vitest";

describe("actionLogRustEngine", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.restoreAllMocks();
    });

    it("falls back to the JS emergency engine when WASM bootstrap fails", async () => {
        vi.doMock("node:fs/promises", () => ({
            readFile: vi.fn(async () => {
                throw new Error("missing wasm");
            }),
        }));

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const engine = await import("./actionLogRustEngine");

        expect(
            engine.buildPatchFromTextsRust(
                "aaa\nbbb\nccc",
                "aaa\nBBB\nccc",
            ),
        ).toEqual({
            edits: [{ oldStart: 1, oldEnd: 2, newStart: 1, newEnd: 2 }],
        });

        const edit = engine.buildPatchFromTextsRust(
            "alpha beta gamma",
            "alpha BETA delta gamma",
        ).edits[0]!;
        expect(
            engine.computeWordDiffsForHunkRust(
                "alpha beta gamma",
                "alpha BETA delta gamma",
                edit,
            )?.bufferRanges,
        ).toEqual([
            {
                from: 6,
                to: 16,
                baseFrom: 6,
                baseTo: 10,
            },
        ]);

        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining("Failed to initialize the Rust/WASM action log engine"),
            expect.any(Error),
        );
    });
});
