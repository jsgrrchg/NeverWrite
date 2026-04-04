/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    isDebugLogEnabled,
    logDebug,
    logWarn,
    resetRuntimeLogStateForTests,
} from "./runtimeLog";

describe("runtimeLog", () => {
    afterEach(() => {
        resetRuntimeLogStateForTests();
        vi.restoreAllMocks();
    });

    it("keeps debug logs disabled until the scope is explicitly enabled", () => {
        const debugSpy = vi
            .spyOn(console, "debug")
            .mockImplementation(() => {});

        logDebug("review", "should stay silent");
        expect(debugSpy).not.toHaveBeenCalled();

        expect(window.__vaultAiLogs?.enable("review")).toEqual(["review"]);
        expect(isDebugLogEnabled("review")).toBe(true);

        logDebug("review", "enabled debug log", { ok: true });
        expect(debugSpy).toHaveBeenCalledWith("[review] enabled debug log", {
            ok: true,
        });
    });

    it("deduplicates warn logs when onceKey is reused", () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

        logWarn("storage", "persist failed", { key: "a" }, { onceKey: "a" });
        logWarn("storage", "persist failed", { key: "a" }, { onceKey: "a" });

        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith("[storage] persist failed", {
            key: "a",
        });
    });

    it("does not deduplicate warn logs unless onceKey is provided", () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

        logWarn("storage", "persist failed", { key: "a" });
        logWarn("storage", "persist failed", { key: "b" });

        expect(warnSpy).toHaveBeenCalledTimes(2);
        expect(warnSpy).toHaveBeenNthCalledWith(1, "[storage] persist failed", {
            key: "a",
        });
        expect(warnSpy).toHaveBeenNthCalledWith(2, "[storage] persist failed", {
            key: "b",
        });
    });
});
