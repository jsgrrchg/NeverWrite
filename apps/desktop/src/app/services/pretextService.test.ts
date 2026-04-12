import { beforeEach, describe, expect, it, vi } from "vitest";

const pretextMocks = vi.hoisted(() => ({
    clearCache: vi.fn(),
    layout: vi.fn(() => ({
        height: 24,
        lineCount: 2,
    })),
    prepare: vi.fn((text: string) => ({
        widths: [text.length],
        lineEndFitAdvances: [text.length],
        lineEndPaintAdvances: [text.length],
        kinds: ["text"],
        simpleLineWalkFastPath: true,
        segLevels: null,
        breakableWidths: [null],
        breakablePrefixWidths: [null],
        discretionaryHyphenWidth: 0,
        tabStopAdvance: 0,
        chunks: [],
    })),
}));

vi.mock("@chenglou/pretext", () => pretextMocks);

import {
    clearPretextServiceCache,
    clearPretextServiceCacheMatching,
    measurePretextText,
} from "./pretextService";
import type { PretextFontSignature } from "../utils/pretextFontSignatures";

const TEST_FONT: PretextFontSignature = {
    key: "test-font",
    cssFont: "14px Test Sans",
    family: "Test Sans",
    sizePx: 14,
    lineHeightPx: 21,
    weight: 400,
    style: "normal",
};

describe("pretextService", () => {
    beforeEach(() => {
        Object.defineProperty(window.navigator, "userAgent", {
            configurable: true,
            value: "NeverWrite test browser",
        });
        clearPretextServiceCache();
        pretextMocks.clearCache.mockClear();
        pretextMocks.layout.mockClear();
        pretextMocks.prepare.mockClear();
    });

    it("reuses cached prepared text for stable non-composer scopes", () => {
        const first = measurePretextText({
            text: "Persistent chat message",
            maxWidth: 320,
            font: TEST_FONT,
            cacheScope: "user-text",
        });
        const second = measurePretextText({
            text: "Persistent chat message",
            maxWidth: 320,
            font: TEST_FONT,
            cacheScope: "user-text",
        });

        expect(first).toMatchObject({ height: 24, lineCount: 2 });
        expect(second).toMatchObject({ height: 24, lineCount: 2 });
        expect(pretextMocks.prepare).toHaveBeenCalledTimes(1);
        expect(pretextMocks.layout).toHaveBeenCalledTimes(2);
    });

    it("does not persist prepared composer drafts across measurements", () => {
        measurePretextText({
            text: "Draft message",
            maxWidth: 320,
            font: TEST_FONT,
            cacheScope: "composer-text",
        });
        measurePretextText({
            text: "Draft message",
            maxWidth: 320,
            font: TEST_FONT,
            cacheScope: "composer-text",
        });

        expect(pretextMocks.prepare).toHaveBeenCalledTimes(2);
    });

    it("evicts least recently used entries when a scope exceeds its budget", () => {
        for (let index = 0; index < 500; index += 1) {
            measurePretextText({
                text: `Message ${index}`,
                maxWidth: 320,
                font: TEST_FONT,
                cacheScope: "user-text",
            });
        }

        measurePretextText({
            text: "Message 0",
            maxWidth: 320,
            font: TEST_FONT,
            cacheScope: "user-text",
        });

        const messageZeroPrepareCalls = pretextMocks.prepare.mock.calls.filter(
            ([text]) => text === "Message 0",
        );

        expect(messageZeroPrepareCalls).toHaveLength(2);
    });

    it("supports selective invalidation without flushing unrelated scopes", () => {
        measurePretextText({
            text: "User text",
            maxWidth: 320,
            font: TEST_FONT,
            cacheScope: "user-text",
        });
        measurePretextText({
            text: "Markdown paragraph",
            maxWidth: 320,
            font: TEST_FONT,
            cacheScope: "markdown-paragraph",
        });

        clearPretextServiceCacheMatching((cacheKey) =>
            cacheKey.startsWith("user-text\u0001"),
        );

        pretextMocks.clearCache.mockClear();
        pretextMocks.prepare.mockClear();

        measurePretextText({
            text: "User text",
            maxWidth: 320,
            font: TEST_FONT,
            cacheScope: "user-text",
        });
        measurePretextText({
            text: "Markdown paragraph",
            maxWidth: 320,
            font: TEST_FONT,
            cacheScope: "markdown-paragraph",
        });

        expect(pretextMocks.prepare.mock.calls.map(([text]) => text)).toEqual([
            "User text",
        ]);
    });
});
