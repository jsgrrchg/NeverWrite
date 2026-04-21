import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The fallback telemetry exercises the same paths as the primary engine
// tests, but with the wasm module swapped out so every Rust call throws.
// Keeping them in a separate file avoids interaction with the
// `node:fs/promises` mock used by the init test in actionLogRustEngine.test.ts.

describe("actionLogRustEngine fallback telemetry", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.doUnmock("./wasm/neverwrite_diff");
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.doUnmock("./wasm/neverwrite_diff");
        vi.restoreAllMocks();
    });

    it("records a counter entry and still produces a valid result when the Rust op throws", async () => {
        vi.doMock("./wasm/neverwrite_diff", async () => {
            const actual =
                await vi.importActual<
                    typeof import("./wasm/neverwrite_diff")
                >("./wasm/neverwrite_diff");
            return {
                ...actual,
                build_patch_from_texts_json: vi.fn(() => {
                    throw new Error("simulated wasm crash");
                }),
            };
        });

        const engine = await import("./actionLogRustEngine");
        engine.resetRustFallbackStatsForTests();

        const result = engine.buildPatchFromTextsRust(
            "aaa\nbbb\nccc",
            "aaa\nBBB\nccc",
        );
        expect(result.edits.length).toBeGreaterThan(0);

        const stats = engine.getRustFallbackStats();
        const entry = stats.ops.find(
            (op) => op.opName === "buildPatchFromTexts",
        );
        expect(entry).toBeDefined();
        expect(entry?.count).toBeGreaterThanOrEqual(1);
        expect(stats.totalCalls).toBeGreaterThanOrEqual(1);
    });

    it("increments the same counter on each subsequent failure", async () => {
        vi.doMock("./wasm/neverwrite_diff", async () => {
            const actual =
                await vi.importActual<
                    typeof import("./wasm/neverwrite_diff")
                >("./wasm/neverwrite_diff");
            return {
                ...actual,
                build_patch_from_texts_json: vi.fn(() => {
                    throw new Error("simulated wasm crash");
                }),
            };
        });

        const engine = await import("./actionLogRustEngine");
        engine.resetRustFallbackStatsForTests();

        engine.buildPatchFromTextsRust("a", "A");
        engine.buildPatchFromTextsRust("b", "B");
        engine.buildPatchFromTextsRust("c", "C");

        const stats = engine.getRustFallbackStats();
        const entry = stats.ops.find(
            (op) => op.opName === "buildPatchFromTexts",
        );
        expect(entry?.count).toBeGreaterThanOrEqual(3);
    });

    it("leaves the counter empty when the Rust op succeeds", async () => {
        const engine = await import("./actionLogRustEngine");
        engine.resetRustFallbackStatsForTests();

        engine.buildPatchFromTextsRust("aaa", "AAA");

        expect(engine.getRustFallbackStats().totalCalls).toBe(0);
    });
});
