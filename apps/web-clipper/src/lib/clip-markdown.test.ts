import { describe, expect, it } from "vitest";
import type { ClipData } from "./clipper-contract";
import { buildClipMarkdown } from "./clip-markdown";

const clipData: ClipData = {
    metadata: {
        title: "Example article",
        url: "https://example.com/articles/demo",
        domain: "example.com",
        description: "Demo description",
        author: "Jordan",
        published: "2026-03-24",
        image: "",
        favicon: "",
        language: "en",
    },
    content: {
        html: "<p>Demo</p>",
        markdown: "Demo body",
        wordCount: 2,
    },
    selection: null,
    extractedAt: "2026-03-24T00:00:00.000Z",
};

describe("clip markdown", () => {
    it("builds frontmatter-backed markdown without duplicating the title", () => {
        const markdown = buildClipMarkdown({
            clipData,
            title: "Custom title",
            tags: ["research", "web"],
            notes: "Keep for later.",
            contentMode: "full-page",
        });

        expect(markdown).toContain("---\ntitle: Custom title");
        expect(markdown).toContain("\ntags:\n  - research\n  - web\n");
        expect(markdown).toContain(
            "\nsource: https://example.com/articles/demo\n",
        );
        expect(markdown).toContain("\n# Custom title\n");
        expect(markdown.match(/^# Custom title$/gm)).toHaveLength(1);
        expect(markdown).toContain("> **Notes:** Keep for later.");
        expect(markdown).toContain("\nDemo body");
        expect(markdown).not.toContain("\nTags: research, web\n");
    });

    it("uses the selected markdown when clipping a selection", () => {
        const markdown = buildClipMarkdown({
            clipData: {
                ...clipData,
                selection: {
                    text: "Quoted",
                    html: "<p>Quoted</p>",
                    markdown: "Quoted markdown",
                },
            },
            title: "",
            tags: [],
            contentMode: "selection",
        });

        expect(markdown).toContain("# Example article");
        expect(markdown).toContain("Quoted markdown");
        expect(markdown).not.toContain("Demo body");
    });

    it("adds a standalone YouTube link after the title so live preview can render the widget", () => {
        const markdown = buildClipMarkdown({
            clipData: {
                ...clipData,
                metadata: {
                    ...clipData.metadata,
                    title: "Video clip",
                    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                    domain: "youtube.com",
                },
            },
            title: "",
            tags: [],
            contentMode: "full-page",
        });

        expect(markdown).toContain(
            "\n# Video clip\n\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ\n\nDemo body",
        );
    });
});
