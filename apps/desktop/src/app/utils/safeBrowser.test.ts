import { afterEach, describe, expect, it, vi } from "vitest";

async function loadModule() {
    vi.resetModules();
    return await import("./safeBrowser");
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("safeBrowser dynamic runtime detection", () => {
    it("reports Excalidraw runtime support when dynamic functions are allowed", async () => {
        const browser = await loadModule();

        expect(browser.canUseDynamicFunction()).toBe(true);
        expect(browser.canUseExcalidrawRuntime()).toBe(true);
    });

    it("falls back to false when the runtime blocks dynamic functions", async () => {
        const blockedFunction = vi.fn(() => {
            throw new EvalError("blocked by CSP");
        });
        vi.stubGlobal("window", {
            location: { protocol: "neverwrite:" },
        });
        vi.stubGlobal("Function", blockedFunction);

        const browser = await loadModule();

        expect(browser.canUseDynamicFunction()).toBe(false);
        expect(browser.canUseExcalidrawRuntime()).toBe(false);
    });
});
