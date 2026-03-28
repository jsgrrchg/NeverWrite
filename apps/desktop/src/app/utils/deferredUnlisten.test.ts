import { describe, expect, it, vi } from "vitest";
import { resolveDeferredUnlisten } from "./deferredUnlisten";

describe("resolveDeferredUnlisten", () => {
    it("stores cleanup when registration resolves before dispose", async () => {
        const cleanup = vi.fn();
        const onResolved = vi.fn();

        resolveDeferredUnlisten(Promise.resolve(cleanup), {
            isDisposed: () => false,
            onResolved,
        });

        await Promise.resolve();

        expect(onResolved).toHaveBeenCalledWith(cleanup);
        expect(cleanup).not.toHaveBeenCalled();
    });

    it("runs cleanup retroactively when registration resolves after dispose", async () => {
        const cleanup = vi.fn();
        let resolveCleanup!: (value: () => void) => void;
        const registration = new Promise<() => void>((resolve) => {
            resolveCleanup = resolve;
        });
        const onResolved = vi.fn();
        let disposed = false;

        resolveDeferredUnlisten(registration, {
            isDisposed: () => disposed,
            onResolved,
        });

        disposed = true;
        resolveCleanup(cleanup);
        await Promise.resolve();

        expect(onResolved).not.toHaveBeenCalled();
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it("swallows registration errors via onError", async () => {
        const error = new Error("boom");
        const onResolved = vi.fn();
        const onError = vi.fn();

        resolveDeferredUnlisten(Promise.reject(error), {
            isDisposed: () => false,
            onResolved,
            onError,
        });

        await Promise.resolve();
        await Promise.resolve();

        expect(onResolved).not.toHaveBeenCalled();
        expect(onError).toHaveBeenCalledWith(error);
    });
});
