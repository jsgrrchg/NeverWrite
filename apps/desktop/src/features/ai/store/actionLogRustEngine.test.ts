import { beforeEach, describe, expect, it, vi } from "vitest";

describe("actionLogRustEngine", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.restoreAllMocks();
    });

    it("loads the WASM bridge and executes a direct patch operation", async () => {
        const engine = await import("./actionLogRustEngine");

        expect(
            engine.buildPatchFromTextsRust("aaa\nbbb\nccc", "aaa\nBBB\nccc"),
        ).toEqual({
            edits: [{ oldStart: 1, oldEnd: 2, newStart: 1, newEnd: 2 }],
        });
    });

    it("fails module initialization when WASM bootstrap fails", async () => {
        vi.doMock("node:fs/promises", () => ({
            readFile: vi.fn(async () => {
                throw new Error("missing wasm");
            }),
        }));

        await expect(import("./actionLogRustEngine")).rejects.toThrow(
            "missing wasm",
        );
    });
});
