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
