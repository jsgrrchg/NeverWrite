import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { crossesMathRange, mathRangesBetween, mathRangesField, parseMathRanges } from "./mathRanges";

function state(doc: string) {
    return EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), mathRangesField] });
}
const parse = (doc: string) => parseMathRanges(state(doc));

describe("Markdown math delimiters", () => {
    it("distinguishes inline, embedded display and standalone display math", () => {
        expect(parse("Text $x^2$ and $$y$$.\n\n$$z$$\n\n$$\n\\frac{a}{b}\n$$").map(
            ({ tex, display, block }) => ({ tex, display, block }),
        )).toEqual([
            { tex: "x^2", display: false, block: false },
            { tex: "y", display: true, block: false },
            { tex: "z", display: true, block: true },
            { tex: "\\frac{a}{b}", display: true, block: true },
        ]);
    });

    it.each([
        "**WTI +4.90% a $94.75** y **Brent +5.60% a $97.10**",
        "Costs $20 and $30 today", "$ x$", "$x $", "$x\ny$",
        "$$", "$$unfinished", "$$\nunclosed", "$$$x$$$",
        String.raw`\$x\$`, "`$x$`", "```tex\n$$\nx\n$$\n```",
        "    $x$", "[link](https://example.com/$x$)", '[link](url "$x$")',
        "[id]: https://example.com/$x$", "![image $x$](image.png)",
        "---\nformula: $x$\n---", "<div>\n$x$\n</div>",
        "| Formula |\n| --- |\n| $x$ |",
    ])("leaves non-math or excluded content literal: %s", (doc) => {
        expect(parse(doc)).toEqual([]);
    });

    it("gives display delimiters precedence over an unmatched inline opener", () => {
        expect(parse("Text $unfinished $$y$$ trailing$").map(({ tex, display }) => ({ tex, display })))
            .toEqual([{ tex: "y", display: true }]);
    });

    it("keeps prices literal next to a real formula", () => {
        expect(parse("Costs $20 and $30; formula $x$.").map((range) => range.tex)).toEqual(["x"]);
    });

    it("preserves numeric formulas, escaped dollars and exact source offsets", () => {
        const doc = String.raw`Price \$20, $2+2$ and $\text{\$5}$, then $x$.`;
        const ranges = parse(doc);
        expect(ranges.map((range) => range.tex)).toEqual(["2+2", String.raw`\text{\$5}`, "x"]);
        for (const range of ranges) {
            expect(doc.slice(range.from, range.to)).toBe(`$${range.tex}$`);
        }
    });

    it("does not match across code, links or incomplete block delimiters", () => {
        expect(parse("$start `code` end$\n\n$$\n```\nx\n```\n$$")).toEqual([]);
        expect(parse("$$unclosed\n\n$x$").map((range) => range.tex)).toEqual(["x"]);
    });

    it("finds the formulas overlapping a range", () => {
        const ranges = parse("$a$ b $c$ d $e$");
        expect(mathRangesBetween(ranges, 4, 10).map((range) => range.tex)).toEqual(["c"]);
        expect(mathRangesBetween(ranges, 1, 7).map((range) => range.tex)).toEqual(["a", "c"]);
        expect(mathRangesBetween(ranges, 3, 6)).toEqual([]);
    });

    it("distinguishes ranges that contain formulas from ranges that cut them", () => {
        const ranges = parse("Text $ab$ and $cd$ end");
        const [first, second] = ranges;
        expect(crossesMathRange(ranges, 0, 22)).toBe(false);
        expect(crossesMathRange(ranges, first.from, first.to)).toBe(false);
        expect(crossesMathRange(ranges, first.to, second.from)).toBe(false);
        expect(crossesMathRange(ranges, 0, first.from + 2)).toBe(true);
        expect(crossesMathRange(ranges, first.from + 1, 22)).toBe(true);
        expect(crossesMathRange(ranges, first.from + 1, first.from + 2)).toBe(true);
        expect(crossesMathRange(ranges, first.from, first.from + 1)).toBe(true);
    });

    it("reuses ranges on selection changes and reparses content changes", () => {
        const initial = state("Text $x$.");
        const selected = initial.update({ selection: { anchor: 6 } }).state;
        expect(selected.field(mathRangesField)).toBe(initial.field(mathRangesField));
        const edited = selected.update({ changes: { from: 6, to: 7, insert: "y" } }).state;
        expect(edited.field(mathRangesField)[0].tex).toBe("y");
    });
});
