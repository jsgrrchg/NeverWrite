/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { extractSection, renderEmbedPreview } from "./notePreviewSource";

describe("renderEmbedPreview", () => {
    it("renders headings, list items and inline formatting to safe DOM", () => {
        const fragment = renderEmbedPreview(
            "# Title\n- item with **bold**\nplain `code` text",
            10,
        );
        const host = document.createElement("div");
        host.appendChild(fragment);

        expect(host.querySelector(".cm-note-embed-h1")?.textContent).toBe(
            "Title",
        );
        const li = host.querySelector(".cm-note-embed-li");
        expect(li?.querySelector("strong")?.textContent).toBe("bold");
        expect(host.querySelector("code")?.textContent).toBe("code");
        // No raw HTML injection: everything is built with DOM nodes.
        expect(host.querySelector("script")).toBeNull();
    });

    it("limits the preview to maxLines non-empty lines", () => {
        const fragment = renderEmbedPreview("a\n\nb\nc\nd", 2);
        const host = document.createElement("div");
        host.appendChild(fragment);
        expect(host.childElementCount).toBe(2);
        expect(host.textContent).toBe("ab");
    });
});

describe("extractSection", () => {
    const doc = [
        "# Intro",
        "intro body",
        "## Details",
        "detail body",
        "### Sub",
        "sub body",
        "## Other",
        "other body",
    ].join("\n");

    it("extracts a section up to the next heading of same or higher level", () => {
        expect(extractSection(doc, "Details")).toBe(
            ["## Details", "detail body", "### Sub", "sub body"].join("\n"),
        );
    });

    it("returns an empty string when the heading is missing", () => {
        expect(extractSection(doc, "Nope")).toBe("");
    });
});
