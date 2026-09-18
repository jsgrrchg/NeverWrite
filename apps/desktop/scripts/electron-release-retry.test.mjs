import { describe, expect, it, vi } from "vitest";

import {
    createCommandExitError,
    electronBuilderRetryAttempts,
    runWithRetry,
} from "./electron-release-retry.mjs";

describe("Electron release retries", () => {
    it("retries ordinary command failures", async () => {
        const failure = createCommandExitError("npx", ["electron-builder"], 1);
        const operation = vi
            .fn()
            .mockRejectedValueOnce(failure)
            .mockResolvedValueOnce(undefined);
        const waitForRetry = vi.fn().mockResolvedValue(undefined);
        const onRetry = vi.fn();

        await runWithRetry(operation, {
            attempts: 3,
            retryDelayMs: 25,
            waitForRetry,
            onRetry,
        });

        expect(operation).toHaveBeenCalledTimes(2);
        expect(waitForRetry).toHaveBeenCalledWith(25);
        expect(onRetry).toHaveBeenCalledWith(
            expect.objectContaining({ attempt: 1, attempts: 3 }),
        );
    });

    it("does not retry a signal-terminated command", async () => {
        const failure = createCommandExitError(
            "npx",
            ["electron-builder"],
            null,
            "SIGTERM",
        );
        const operation = vi.fn().mockRejectedValue(failure);
        const waitForRetry = vi.fn();

        await expect(
            runWithRetry(operation, { attempts: 3, waitForRetry }),
        ).rejects.toBe(failure);

        expect(operation).toHaveBeenCalledTimes(1);
        expect(waitForRetry).not.toHaveBeenCalled();
    });

    it("retries builds but not publishing commands", () => {
        expect(electronBuilderRetryAttempts("never")).toBe(3);
        expect(electronBuilderRetryAttempts("always")).toBe(1);
        expect(electronBuilderRetryAttempts("onTagOrDraft")).toBe(1);
    });
});
