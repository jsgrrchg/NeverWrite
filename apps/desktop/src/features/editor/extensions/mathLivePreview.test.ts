import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { livePreviewExtension } from "./livePreview";

const views: EditorView[] = [];
function mount(doc: string, anchor = 0) {
    const parent = document.body.appendChild(document.createElement("div"));
    const view = new EditorView({ parent, state: EditorState.create({
        doc, selection: { anchor },
        extensions: [markdown({ base: markdownLanguage }), livePreviewExtension(null, {
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
