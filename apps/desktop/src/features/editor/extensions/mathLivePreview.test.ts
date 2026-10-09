import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { history, undo, redo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { livePreviewExtension } from "./livePreview";

const views: EditorView[] = [];
function mount(doc: string, anchor = 0) {
    const parent = document.body.appendChild(document.createElement("div"));
    const view = new EditorView({ parent, state: EditorState.create({
        doc, selection: { anchor },
        extensions: [history(), EditorState.allowMultipleSelections.of(true), markdown({ base: markdownLanguage }), livePreviewExtension(null, {
            resolveWikilink: () => false, navigateWikilink: () => {},
            getNoteLinkTarget: () => null, openLinkContextMenu: () => {},
        })],
    }) });
    views.push(view);
    return view;
}
afterEach(() => {
    views.forEach((view) => view.destroy());
    views.length = 0;
    document.body.innerHTML = "";
});

describe("math live preview integration", () => {
    it("renders inline formulas next to prices and Markdown formatting", () => {
        const view = mount("Text **bold** $x_1$ and $2+2$; $20 and $30. ` $literal$ `");
        expect([...view.dom.querySelectorAll(".cm-katex-inline annotation")].map((node) => node.textContent))
            .toEqual(["x_1", "2+2"]);
        expect(view.dom.querySelector(".cm-lp-bold")?.textContent).toContain("bold");
        expect(view.contentDOM.textContent).toContain("$20 and $30");
    });

    it.each([
        ["inline formula", "$x$ and plain\n\n# Heading\n\nMore **text**."],
        ["display block", "$$\nx\n$$\n\n# Heading\n\nMore **text**."],
    ])("keeps Markdown styling when the note starts with a %s", (_, doc) => {
        const view = mount(doc, doc.length);
        expect(view.dom.querySelectorAll(".katex")).toHaveLength(1);
        expect(view.dom.querySelector(".cm-lp-h1")).not.toBeNull();
        expect(view.dom.querySelector(".cm-lp-bold")?.textContent).toContain("text");
    });

    it.each([
        "Intro\n\n$x$ starts **bold** text\n\nEnd",
        "Intro\n\n- $x$ starts **bold** text\n\nEnd",
        "Intro\n\n> $x$ starts **bold** text\n\nEnd",
    ])("styles blocks that start with a formula: %j", (doc) => {
        const view = mount(doc, doc.length);
        expect(view.dom.querySelector(".katex annotation")?.textContent).toBe("x");
        expect(view.dom.querySelector(".cm-lp-bold")?.textContent).toContain("bold");
    });

    it("does not apply emphasis that crosses a formula boundary", () => {
        const doc = "Text *a $b* c$ end";
        const view = mount(doc, 0);
        expect(view.dom.querySelector(".katex annotation")?.textContent).toBe("b* c");
        expect(view.dom.querySelector(".cm-lp-italic")).toBeNull();
    });

    it("renders inline tokens that contain a whole formula", () => {
        const doc = "Intro ==see $x$ here== and <kbd>Key $y$ up</kbd> end\n\nEnd";
        const view = mount(doc, doc.length);
        expect(view.dom.querySelector(".cm-lp-highlight .katex annotation")?.textContent).toBe("x");
        expect(view.dom.querySelector(".cm-lp-kbd .katex annotation")?.textContent).toBe("y");
    });

    it.each(["Intro $a ==b== c$ end", "Intro ==a $b== c$ end"])(
        "does not apply inline tokens inside or across a formula: %s",
        (line) => {
            const view = mount(`${line}\n\nEnd`, line.length + 2);
            expect(view.dom.querySelectorAll(".katex")).toHaveLength(1);
            expect(view.dom.querySelector(".cm-lp-highlight")).toBeNull();
        },
    );

    it("reveals only the selected inline formula and keeps its full source", () => {
        const doc = "Text $x_1$ and $y^2$ end";
        const view = mount(doc);
        view.dispatch({ selection: { anchor: doc.indexOf("x_1") } });
        expect(view.contentDOM.textContent).toContain("$x_1$");
        expect(view.dom.querySelectorAll(".cm-katex-inline")).toHaveLength(1);
        expect(view.dom.querySelector(".cm-katex-inline annotation")?.textContent).toBe("y^2");
        view.dispatch({ selection: { anchor: doc.length } });
        expect(view.dom.querySelectorAll(".cm-katex-inline")).toHaveLength(2);
    });

    it("does not interpret Markdown operators inside a selected formula", () => {
        const doc = "Text $a*b*c + x_1_2$ end";
        const view = mount(doc, doc.indexOf("a*b"));
        expect(view.contentDOM.textContent).toContain("$a*b*c + x_1_2$");
        expect(view.dom.querySelector(".cm-lp-italic")).toBeNull();
    });

    it.each(["$x$", "$$x$$", "$$\nx\n$$"])("updates formula content and supports undo/redo: %s", (formula) => {
        const doc = `Start\n\n${formula}\n\nEnd`;
        const view = mount(doc);
        const from = doc.indexOf("x");
        view.dispatch({ changes: { from, to: from + 1, insert: "y" } });
        expect(view.dom.querySelector(".katex annotation")?.textContent).toBe("y");
        undo(view);
        expect(view.state.doc.toString()).toBe(doc);
        view.dispatch({ selection: { anchor: 0 } });
        expect(view.dom.querySelector(".katex annotation")?.textContent).toBe("x");
        redo(view);
        view.dispatch({ selection: { anchor: 0 } });
        expect(view.dom.querySelector(".katex annotation")?.textContent).toBe("y");
    });

    it.each(["$x$", "$$x$$", "$$\nx\n$$"])("clicks moved widgets using current source positions: %s", (formula) => {
        const view = mount(`Start\n\n${formula}\n\nEnd`);
        view.dispatch({ changes: { from: 0, insert: "prefix" } });
        const math = view.dom.querySelector(".cm-katex-inline, .cm-katex-block")!;
        math.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
        expect(view.dom.querySelector(".katex")).toBeNull();
        expect(view.state.doc.sliceString(view.state.selection.main.head, view.state.selection.main.head + 1)).toMatch(/[x\n]/);
    });

    it.each(["Start $x$ end", "Start\n\n$$x$$\n\nEnd"])(
        "scrolls a wide formula from its scrollbar without revealing the source: %j",
        (doc) => {
            const view = mount(doc);
            const math = view.dom.querySelector<HTMLElement>(".cm-katex-inline, .cm-katex-block")!;
            // A horizontal scrollbar occupies the 10px below the 20px client area.
            Object.defineProperties(math, {
                scrollWidth: { value: 300 }, clientWidth: { value: 100 },
                clientHeight: { value: 20 }, clientTop: { value: 0 },
            });
            math.getBoundingClientRect = () => new DOMRect(0, 0, 100, 30);
            const press = (clientY: number) => math.dispatchEvent(
                new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientY }),
            );
            press(25);
            expect(view.dom.querySelector(".katex")).not.toBeNull();
            expect(view.state.selection.main.head).toBe(0);
            press(10);
            expect(view.dom.querySelector(".katex")).toBeNull();
        },
    );

    it("maps reveal ranges when preceding text changes", () => {
        const view = mount("Start $x$ end");
        view.dispatch({ changes: { from: 0, insert: "prefix" } });
        view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf("$x$") + 1 } });
        expect(view.dom.querySelector(".katex")).toBeNull();
        view.dispatch({ selection: { anchor: 0 } });
        expect(view.dom.querySelector(".katex annotation")?.textContent).toBe("x");
    });

    it("reveals formulas touched by secondary selections on the same line", () => {
        const doc = "Start $$x$$\n\nText $y$ and $z$.";
        const view = mount(doc);
        view.dispatch({ selection: EditorSelection.create([
            EditorSelection.cursor(0), EditorSelection.cursor(doc.indexOf("x")),
            EditorSelection.range(doc.indexOf("$y$"), doc.indexOf("$y$") + 3),
        ]) });
        expect([...view.dom.querySelectorAll(".katex annotation")].map((node) => node.textContent)).toEqual(["z"]);
        view.dispatch({ selection: { anchor: 0 } });
        expect(view.dom.querySelectorAll(".katex")).toHaveLength(3);
    });

    it("reveals a single-line display block when the cursor crosses its boundary", () => {
        const view = mount("  $$x$$  ", 0);
        expect(view.dom.querySelector(".cm-katex-block")).not.toBeNull();
        view.dispatch({ selection: { anchor: 2 } });
        expect(view.dom.querySelector(".cm-katex-block")).toBeNull();
        view.dispatch({ selection: { anchor: 7 } });
        expect(view.dom.querySelector(".cm-katex-block")).not.toBeNull();
    });

    it("renders MathML alongside visual HTML", () => {
        const view = mount("Start $x$\n\n$$y$$");
        expect(view.dom.querySelectorAll(".katex-mathml math")).toHaveLength(2);
        expect(view.dom.querySelectorAll('.katex-html[aria-hidden="true"]')).toHaveLength(2);
    });

    it("keeps invalid formulas readable and recovers after correction", () => {
        const doc = String.raw`Start $\unknowncommand{x}$ end`;
        const view = mount(doc);
        const error = view.dom.querySelector<HTMLElement>(".cm-katex-error")!;
        expect(error.textContent).toBe(String.raw`\unknowncommand{x}`);
        expect(error.title).toContain("Undefined control sequence");
        error.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        expect(view.dom.querySelector(".cm-katex-error")).toBeNull();
        const from = doc.indexOf("unknowncommand");
        view.dispatch({ changes: { from, to: from + "unknowncommand".length, insert: "sqrt" } });
        view.dispatch({ selection: { anchor: 0 } });
        expect(view.dom.querySelector(".cm-katex-error")).toBeNull();
        expect(view.dom.querySelector(".katex annotation")?.textContent).toBe(String.raw`\sqrt{x}`);
    });

    it("renders both single and multiline display math with display layout", () => {
        const view = mount("Text\n\n$$x^2$$\n\n$$\n\\frac{a}{b}\n$$\n\nEnd");
        expect(view.dom.querySelectorAll(".cm-katex-block .katex-display")).toHaveLength(2);
        expect(view.dom.querySelectorAll(".cm-katex-inline")).toHaveLength(0);
        expect(view.state.doc.toString()).toContain("$$x^2$$");
    });

    it("reveals a whole display block while editing and restores it on exit", () => {
        const doc = "Text\n\n$$\nx^2\n$$\n\nEnd";
        const view = mount(doc);
        view.dispatch({ selection: { anchor: doc.indexOf("x^2") } });
        expect(view.dom.querySelector(".cm-katex-block")).toBeNull();
        expect(view.contentDOM.textContent).toContain("x^2");
        view.dispatch({ selection: { anchor: doc.length } });
        expect(view.dom.querySelector(".cm-katex-block .katex")).not.toBeNull();
    });

    it("keeps display math in code literal alongside a rendered block", () => {
        const view = mount("Text\n\n```tex\n$$\nx\n$$\n```\n\n$$y$$\n\nEnd");
        expect(view.dom.querySelectorAll(".cm-katex-block")).toHaveLength(1);
        expect(view.dom.querySelector(".cm-katex-block annotation")?.textContent).toBe("y");
    });
});

describe("math in table live preview", () => {
    const table = (...rows: string[]) => ["Intro", "", "| A | B |", "| --- | --- |", ...rows, "", "End"].join("\n");
    const formulas = (root: ParentNode) =>
        [...root.querySelectorAll(".cm-katex-inline annotation")].map((node) => node.textContent);
    const cell = (view: EditorView, index: number) =>
        view.dom.querySelectorAll<HTMLElement>(".cm-lp-table-cell")[index];

    it("renders formulas in header and body cells with the document delimiter rules", () => {
        const view = mount(String.raw`Intro

| $x^2$ | Price |
| --- | --- |
| $a+b$ and $$y$$ | $20 and $30, \$z\$, $ w$ |`);
        expect(formulas(view.dom)).toEqual(["x^2", "a+b", "y"]);
        expect(cell(view, 2).querySelector(".cm-katex-inline .katex-display")).not.toBeNull();
        expect(cell(view, 3).textContent).toBe(String.raw`$20 and $30, \$z\$, $ w$`);
    });

    it("keeps code spans, wikilinks and URLs literal", () => {
        const view = mount(table("| `$x$` and ``a `$y$` b`` | [[Cost $5 and $z$]] https://example.com/$w$ |"));
        expect(view.dom.querySelector(".katex")).toBeNull();
        expect(cell(view, 2).textContent).toBe("`$x$` and ``a `$y$` b``");
        expect(view.dom.querySelector(".cm-lp-table-wikilink")?.textContent).toBe("Cost $5 and $z$");
        expect(view.dom.querySelector(".cm-lp-table-url")?.textContent).toBe("https://example.com/$w$");
    });

    it("renders formulas next to links and inside bold or highlighted text", () => {
        const view = mount(table("| [[Note]] $a$ https://example.com $b$ | **$c$ bold** and ==$d$== |"));
        expect(formulas(cell(view, 2))).toEqual(["a", "b"]);
        expect(formulas(view.dom.querySelector(".cm-lp-table-bold")!)).toEqual(["c"]);
        expect(view.dom.querySelector(".cm-lp-table-bold")?.textContent).toContain("bold");
        expect(formulas(view.dom.querySelector(".cm-lp-table-highlight")!)).toEqual(["d"]);
    });

    it("does not apply formatting that cuts through or sits inside a formula", () => {
        const view = mount(table("| **a $b** c$ | $x **y** z$ ==$p== q$ |"));
        expect(formulas(view.dom)).toEqual(["b** c", "x **y** z", "p== q"]);
        expect(view.dom.querySelector(".cm-lp-table-bold, .cm-lp-table-highlight")).toBeNull();
    });

    it("reads escaped pipes as literal pipes inside formulas", () => {
        const view = mount(table(String.raw`| $\lvert x \rvert = a \| b$ | 2 |`));
        expect(view.dom.querySelectorAll(".cm-lp-table-cell")).toHaveLength(4);
        expect(formulas(view.dom)).toEqual([String.raw`\lvert x \rvert = a | b`]);
    });

    it("keeps invalid formulas readable", () => {
        const view = mount(table(String.raw`| $\unknowncommand{x}$ | $y$ |`));
        const error = view.dom.querySelector<HTMLElement>(".cm-lp-table-cell .cm-katex-error")!;
        expect(error.textContent).toBe(String.raw`\unknowncommand{x}`);
        expect(error.title).toContain("Undefined control sequence");
        expect(cell(view, 3).querySelector<HTMLElement>(".cm-katex-inline")?.title).toBe("");
    });

    it("shows the raw table source while the cursor is inside it", () => {
        const doc = table("| $x$ | 2 |");
        const view = mount(doc);
        expect(formulas(view.dom)).toEqual(["x"]);
        view.dispatch({ selection: { anchor: doc.indexOf("$x$") + 1 } });
        expect(view.dom.querySelector(".cm-lp-table-widget")).toBeNull();
        expect(view.dom.querySelector(".katex")).toBeNull();
        expect(view.contentDOM.textContent).toContain("| $x$ | 2 |");
    });
});
