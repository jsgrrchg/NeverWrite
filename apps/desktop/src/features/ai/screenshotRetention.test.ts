import { describe, expect, it } from "vitest";
import {
    DEFAULT_SCREENSHOT_RETENTION_SECONDS,
    normalizeScreenshotPartTimestamps,
    normalizeScreenshotRetentionSeconds,
    pruneExpiredScreenshotParts,
} from "./screenshotRetention";
import type { AIComposerPart } from "./types";

describe("screenshot retention", () => {
    it("migrates removed retention values upward to supported options", () => {
        expect(normalizeScreenshotRetentionSeconds(30)).toBe(60);
        expect(normalizeScreenshotRetentionSeconds(900)).toBe(1800);
        expect(normalizeScreenshotRetentionSeconds(0)).toBe(0);
        expect(normalizeScreenshotRetentionSeconds(undefined)).toBe(
            DEFAULT_SCREENSHOT_RETENTION_SECONDS,
        );
    });

    it("removes expired screenshots without dropping surrounding text", () => {
        const parts: AIComposerPart[] = [
            { id: "text-1", type: "text", text: "Before " },
            {
                id: "shot-1",
                type: "screenshot",
                filePath: "/vault/assets/chat/old.png",
                mimeType: "image/png",
                label: "Screenshot 10:42 hrs",
                createdAt: 1_000,
            },
            { id: "text-2", type: "text", text: " after" },
        ];

        expect(pruneExpiredScreenshotParts(parts, 60, 62_000)).toEqual([
            { id: "text-1", type: "text", text: "Before  after" },
        ]);
    });

    it("timestamps legacy screenshot parts so cleanup has a stable age", () => {
        const parts: AIComposerPart[] = [
            {
                id: "shot-1",
                type: "screenshot",
                filePath: "/vault/assets/chat/old.png",
                mimeType: "image/png",
                label: "Screenshot 10:42 hrs",
            },
        ];

        expect(normalizeScreenshotPartTimestamps(parts, 5_000)).toEqual([
            {
                ...parts[0],
                createdAt: 5_000,
            },
        ]);
    });
});
