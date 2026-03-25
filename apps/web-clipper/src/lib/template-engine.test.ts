import { describe, expect, it } from "vitest";
import type { ClipData } from "./clipper-contract";
import { renderClipTemplate, resolveClipTemplate } from "./template-engine";

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

describe("template engine", () => {
    it("prefers the most specific template match", () => {
        const resolved = resolveClipTemplate({
            templates: [
                {
                    id: "generic",
                    name: "Generic",
                    body: "generic",
                    vaultId: "",
                    domain: "",
                },
                {
                    id: "domain",
                    name: "Domain",
                    body: "domain",
                    vaultId: "",
                    domain: "example.com",
                },
                {
                    id: "vault-domain",
                    name: "Vault Domain",
                    body: "vault domain",
                    vaultId: "vault-a",
                    domain: "example.com",
                },
            ],
            defaultTemplate: "default",
            vaultId: "vault-a",
            domain: "example.com",
        });

        expect(resolved.id).toBe("vault-domain");
        expect(resolved.body).toBe("vault domain");
    });

    it("renders supported variables", () => {
        const markdown = renderClipTemplate(
            "# {{title}}\n\n{{content}}\n\n{{url}}\n\n{{tags}}\n\n{{folder}}",
            {
                clipData,
                title: "Custom title",
                tags: ["research", "web"],
                folder: "Clips/Web",
                content: "Rendered body",
            },
        );

        expect(markdown).toContain("# Custom title");
        expect(markdown).toContain("Rendered body");
        expect(markdown).toContain("https://example.com/articles/demo");
        expect(markdown).toContain("research, web");
        expect(markdown).toContain("Clips/Web");
    });
});
