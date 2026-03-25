import { readFileSync } from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { extractClipSource } from "./extractor";

function readFixture(name: string): string {
    return readFileSync(
        path.resolve(import.meta.dirname, "../test/fixtures", name),
        "utf8",
    );
}

function createWindowFromFixture(name: string, url: string): Window {
    const dom = new JSDOM(readFixture(name), { url });
    return dom.window as unknown as Window;
}

describe("extractClipSource", () => {
    it("extracts metadata and article content from a realistic fixture", () => {
        const fixtureWindow = createWindowFromFixture(
            "article-realistic.html",
            "https://example.com/articles/browser-workflows",
        );
        vi.spyOn(fixtureWindow, "getSelection").mockReturnValue(null);

        const result = extractClipSource(fixtureWindow.document, fixtureWindow);

        expect(result.metadata.title).toBe(
            "How to Build Better Browser Workflows",
        );
        expect(result.metadata.url).toBe(
            "https://example.com/articles/browser-workflows",
        );
        expect(result.metadata.domain).toBe("example.com");
        expect(result.metadata.author).toBe("Jordan Fields");
        expect(result.metadata.description).toBe(
            "A practical guide to capturing useful context from the web.",
        );
        expect(result.metadata.published).toBe("2026-03-20T09:30:00Z");
        expect(result.metadata.image).toBe(
            "https://example.com/article-cover.jpg",
        );
        expect(result.metadata.favicon).toBe("https://example.com/favicon.ico");
        expect(result.metadata.language).toBe("en");
        expect(result.contentHtml).toContain(
            "Strong clipping flows start with reliable extraction",
        );
        expect(result.selection).toBeNull();
        expect(result.wordCount).toBeGreaterThan(20);
    });

    it("extracts selected text when a user selection exists", () => {
        const fixtureWindow = createWindowFromFixture(
            "article-realistic.html",
            "https://example.com/articles/browser-workflows",
        );

        const selectionText =
            "Capture, clean, and route information with less friction.";
        const selectionHtml =
            "<p>Capture, clean, and route information with less friction.</p>";

        const fakeSelection = {
            isCollapsed: false,
            rangeCount: 1,
            toString: () => selectionText,
            getRangeAt: () => ({
                cloneContents: () => {
                    const fragment =
                        fixtureWindow.document.createDocumentFragment();
                    const wrapper = fixtureWindow.document.createElement("p");
                    wrapper.textContent = selectionText;
                    fragment.append(wrapper);
                    return fragment;
                },
            }),
        } as unknown as Selection;

        vi.spyOn(fixtureWindow, "getSelection").mockReturnValue(fakeSelection);

        const result = extractClipSource(fixtureWindow.document, fixtureWindow);

        expect(result.selection).toEqual({
            text: selectionText,
            html: selectionHtml,
        });
    });

    it("falls back safely on degraded pages with sparse metadata", () => {
        const fixtureWindow = createWindowFromFixture(
            "article-degraded.html",
            "https://example.com/degraded",
        );
        vi.spyOn(fixtureWindow, "getSelection").mockReturnValue(null);

        const result = extractClipSource(fixtureWindow.document, fixtureWindow);

        expect(result.metadata.title).toBe("Fallback Title");
        expect(result.metadata.description).toBe("");
        expect(result.metadata.author).toBe("");
        expect(result.metadata.language).toBe("");
        expect(result.contentHtml).toContain(
            "This page has almost no metadata and no article wrapper.",
        );
        expect(result.wordCount).toBeGreaterThan(10);
    });
});
