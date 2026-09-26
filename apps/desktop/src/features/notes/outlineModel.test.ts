import { describe, expect, it } from "vitest";
import { buildOutlineTree, extractHeadings } from "./outlineModel";

describe("outlineModel", () => {
    it("keeps document offsets through frontmatter and CRLF", () => {
        const content = "---\r\ntitle: Test\r\n# Not a heading\r\n---\r\n# First\r\n\r\nSecond\r\n------\r\n";
        const headings = extractHeadings(content);
        expect(headings.map(({ title, level }) => ({ title, level }))).toEqual([
            { title: "First", level: 1 },
            { title: "Second", level: 2 },
        ]);
        for (const heading of headings) {
            expect(heading.anchor).toBe(content.indexOf(heading.title === "First" ? "# First" : "Second"));
            expect(content.slice(heading.anchor, heading.head).trim()).toContain(heading.title);
        }
    });

    it("cleans formatted titles and gives duplicate titles distinct destinations", () => {
        const headings = extractHeadings("# **Hello** [[note|world]] `code` ###\n## Same\n## Same");
        expect(headings.map((heading) => heading.title)).toEqual(["Hello world code", "Same", "Same"]);
        expect(headings[1].id).not.toBe(headings[2].id);
        expect(headings[1].anchor).not.toBe(headings[2].anchor);
    });

    it("ignores code fences, including shorter fences inside longer ones", () => {
        const content = [
            "# Before", "````md", "```", "# Hidden", "````", "~~~js",
            "## Also hidden", "~~~ trailing text", "# Still hidden", "~~~~", "## After",
        ].join("\n");
        expect(extractHeadings(content).map((heading) => heading.title)).toEqual(["Before", "After"]);
    });

    it("builds a hierarchy when heading levels are skipped", () => {
        const tree = buildOutlineTree(extractHeadings("# Root\n### Child\n###### Leaf\n## Sibling\n# Next"));
        expect(tree.map((node) => node.title)).toEqual(["Root", "Next"]);
        expect(tree[0].children.map((node) => node.title)).toEqual(["Child", "Sibling"]);
        expect(tree[0].children[0].children[0].title).toBe("Leaf");
        expect(extractHeadings("ordinary text")).toEqual([]);
    });
});
