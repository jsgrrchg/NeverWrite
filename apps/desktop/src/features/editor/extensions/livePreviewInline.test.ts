/**
 * @vitest-environment jsdom
 */
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, type Decoration } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../app/utils/perfInstrumentation", () => ({
    perfCount: vi.fn(),
    perfMeasure: vi.fn(),
    perfNow: vi.fn(() => 1),
}));

import { perfMeasure } from "../../../app/utils/perfInstrumentation";
import { linkReferenceField } from "./livePreviewHelpers";
import {
    createInlineLivePreviewPlugin,
    createLeadingContentCollapseField,
} from "./livePreviewInline";

type DecorationInfo = {
    from: number;
    to: number;
    className: string;
    style: string;
    attributes: Record<string, string>;
    hasWidget: boolean;
    isReplace: boolean;
};

function readAttributes(deco: Decoration): Record<string, string> {
    const spec = deco.spec as {
        class?: string;
        attributes?: Record<string, string>;
    };
    return {
        ...(spec.class ? { class: spec.class } : {}),
        ...(spec.attributes ?? {}),
    };
}

function readClassName(deco: Decoration): string {
    return readAttributes(deco).class ?? "";
}

function readStyle(deco: Decoration): string {
    return readAttributes(deco).style ?? "";
}

function collectDecorations(
    view: EditorView,
    plugin: ReturnType<typeof createInlineLivePreviewPlugin>,
) {
    const instance = view.plugin(plugin);
    expect(instance).not.toBeNull();

    const decorations: DecorationInfo[] = [];
    instance!.decorations.between(
        0,
        view.state.doc.length + 1,
        (from, to, deco) => {
            decorations.push({
                from,
                to,
                className: readClassName(deco),
                style: readStyle(deco),
                attributes: readAttributes(deco),
                hasWidget: "widget" in deco.spec && deco.spec.widget != null,
                isReplace:
                    deco.spec !== undefined &&
                    !("class" in deco.spec) &&
                    from !== to,
            });
        },
    );
    return decorations;
}

function hasHiddenRange(
    decorations: DecorationInfo[],
    from: number,
    to: number,
    className = "cm-lp-hidden",
) {
    return decorations.some(
        (deco) =>
            deco.className === className &&
            deco.from === from &&
            deco.to === to,
    );
}

function hasWidgetRange(
    decorations: DecorationInfo[],
    from: number,
    to: number,
) {
    return decorations.some(
        (deco) => deco.hasWidget && deco.from === from && deco.to === to,
    );
}

function findDecorationByClass(
    decorations: DecorationInfo[],
    className: string,
) {
    return decorations.find((deco) =>
        deco.className.split(" ").includes(className),
    );
}

function createView(
    doc: string,
    selection: EditorSelection | { anchor: number; head?: number },
) {
    const plugin = createInlineLivePreviewPlugin();
    const parent = document.createElement("div");
    document.body.appendChild(parent);

    const state = EditorState.create({
        doc,
        selection,
        extensions: [
            markdown({ base: markdownLanguage }),
            linkReferenceField,
            plugin,
        ],
    });

    const view = new EditorView({ state, parent });
    return { plugin, parent, view };
}

afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
});

describe("createInlineLivePreviewPlugin", () => {
    it("hides list markers when the selection is on another line", () => {
        const { plugin, parent, view } = createView(
            "- item\nnext",
            EditorSelection.cursor(8),
        );

        const decorations = collectDecorations(view, plugin);

        expect(hasHiddenRange(decorations, 0, 2)).toBe(true);
        expect(
            decorations.some((deco) =>
                deco.className.split(" ").includes("cm-lp-li-line"),
            ),
        ).toBe(true);

        view.destroy();
        parent.remove();
    });

    it("keeps list markers hidden even when the caret is on the same line", () => {
        const { plugin, parent, view } = createView(
            "- item",
            EditorSelection.cursor(1),
        );

        const decorations = collectDecorations(view, plugin);

        expect(hasHiddenRange(decorations, 0, 2)).toBe(true);

        view.destroy();
        parent.remove();
    });

    it("reveals raw list markdown during multiline selection across bullet items", () => {
        const doc = "- first\n- second";
        const { plugin, parent, view } = createView(
            doc,
            EditorSelection.range(3, 11),
        );

        const decorations = collectDecorations(view, plugin);

        expect(hasHiddenRange(decorations, 0, 2)).toBe(false);
        expect(hasHiddenRange(decorations, 8, 10)).toBe(false);
        expect(
            decorations.some(
                (deco) =>
                    deco.from === 0 &&
                    deco.className.split(" ").includes("cm-lp-li-line"),
            ),
        ).toBe(false);
        expect(
            decorations.some(
                (deco) =>
                    deco.from === 8 &&
                    deco.className.split(" ").includes("cm-lp-li-line"),
            ),
        ).toBe(false);

        view.destroy();
        parent.remove();
    });

    it("keeps deeply overindented markdown bullets in live preview via fallback", () => {
        const doc = "- root\n        - deep child";
        const { plugin, parent, view } = createView(
            doc,
            EditorSelection.cursor(doc.length),
        );

        const decorations = collectDecorations(view, plugin);

        expect(hasHiddenRange(decorations, 7, 17)).toBe(true);
        expect(
            decorations.some(
                (deco) =>
                    deco.from === 7 &&
                    deco.className.split(" ").includes("cm-lp-li-line"),
            ),
        ).toBe(true);

        view.destroy();
        parent.remove();
    });

    it("keeps an active empty list item in live preview without showing raw markers", () => {
        const { plugin, parent, view } = createView(
            "- ",
            EditorSelection.cursor(2),
        );

        const decorations = collectDecorations(view, plugin);

        expect(hasHiddenRange(decorations, 0, 1)).toBe(true);
        expect(
            decorations.some((deco) =>
                deco.className.split(" ").includes("cm-lp-li-line"),
            ),
        ).toBe(true);

        view.destroy();
        parent.remove();
    });

    it("keeps task markers hidden even when the caret is on the same line", () => {
        const doc = "- [ ] task";
        const { plugin, parent, view } = createView(
            doc,
            EditorSelection.cursor(3),
        );

        const decorations = collectDecorations(view, plugin);

        expect(hasHiddenRange(decorations, 0, 2)).toBe(true);
        expect(hasHiddenRange(decorations, 2, 6)).toBe(true);
        expect(
            decorations.some((deco) =>
                deco.className.split(" ").includes("cm-lp-task-line"),
            ),
        ).toBe(true);

        view.destroy();
        parent.remove();
    });

    it("rebuilds list preview when a multiline selection enters bullet items", () => {
        const perfMeasureMock = vi.mocked(perfMeasure);
        const doc = "- first\n- second";
        const { plugin, parent, view } = createView(
            doc,
            EditorSelection.cursor(doc.length),
        );

        perfMeasureMock.mockClear();

        view.dispatch({
            selection: EditorSelection.range(3, 11),
        });

        const decorations = collectDecorations(view, plugin);
        expect(hasHiddenRange(decorations, 0, 2)).toBe(false);
        expect(hasHiddenRange(decorations, 8, 10)).toBe(false);
        expect(perfMeasureMock).toHaveBeenCalledWith(
            "editor.livePreviewInline.build.selectionSet",
            expect.any(Number),
            expect.any(Object),
        );

        view.destroy();
        parent.remove();
    });

    it("rebuilds task preview when the checkbox state changes", () => {
        const doc = "- [ ] task";
        const { plugin, parent, view } = createView(
            doc,
            EditorSelection.cursor(doc.length),
        );

        let decorations = collectDecorations(view, plugin);
        expect(
            decorations.some((deco) =>
                deco.className.split(" ").includes("cm-lp-task-checked"),
            ),
        ).toBe(false);

        view.dispatch({
            changes: { from: 3, to: 4, insert: "x" },
            selection: EditorSelection.cursor(doc.length),
        });

        decorations = collectDecorations(view, plugin);
        expect(
            decorations.some((deco) =>
                deco.className.split(" ").includes("cm-lp-task-checked"),
            ),
        ).toBe(true);

        view.destroy();
        parent.remove();
    });

    it("keeps an active empty task item in live preview without showing raw markers", () => {
        const doc = "- [ ] ";
        const { plugin, parent, view } = createView(
            doc,
            EditorSelection.cursor(doc.length),
        );

        const decorations = collectDecorations(view, plugin);

        expect(hasHiddenRange(decorations, 0, 1)).toBe(true);
        expect(hasHiddenRange(decorations, 2, 5)).toBe(true);
        expect(
            decorations.some((deco) =>
                deco.className.split(" ").includes("cm-lp-task-line"),
            ),
        ).toBe(true);

        view.destroy();
        parent.remove();
    });

    it("keeps blockquote and horizontal rule markers hidden on the active line", () => {
        const doc = "> quote\n---";
        const { plugin, parent, view } = createView(
            doc,
            EditorSelection.cursor(1),
        );

        let decorations = collectDecorations(view, plugin);
        expect(hasHiddenRange(decorations, 0, 2)).toBe(true);
        expect(
            decorations.some((deco) =>
                deco.className.split(" ").includes("cm-lp-blockquote-line"),
            ),
        ).toBe(true);

        view.dispatch({
            selection: EditorSelection.cursor(doc.length - 1),
        });

        decorations = collectDecorations(view, plugin);
        expect(hasHiddenRange(decorations, 8, 11)).toBe(true);
        expect(
            decorations.some((deco) =>
                deco.className.split(" ").includes("cm-lp-hr-line"),
            ),
        ).toBe(false);

        view.destroy();
        parent.remove();
    });

    it("hides horizontal rule preview decorations while the line is selected", () => {
        const doc = "before\n\n---\nafter";
        const { plugin, parent, view } = createView(
            doc,
            EditorSelection.range(0, doc.length),
        );

        let decorations = collectDecorations(view, plugin);
        expect(
            decorations.some((deco) =>
                deco.className.split(" ").includes("cm-lp-hr-line"),
            ),
        ).toBe(false);

        view.dispatch({
            selection: EditorSelection.cursor(0),
        });

        decorations = collectDecorations(view, plugin);
        expect(
            decorations.some((deco) =>
                deco.className.split(" ").includes("cm-lp-hr-line"),
            ),
        ).toBe(true);

        view.destroy();
        parent.remove();
    });

    it("keeps footnote definition markers hidden on the active line", () => {
        const doc = "[^note]: footnote";
        const { plugin, parent, view } = createView(
            doc,
            EditorSelection.cursor(2),
        );

        const decorations = collectDecorations(view, plugin);

        expect(hasHiddenRange(decorations, 0, 8)).toBe(true);
        expect(hasHiddenRange(decorations, 8, 9)).toBe(true);
        expect(
            decorations.some((deco) =>
                deco.className.split(" ").includes("cm-lp-footnote-def"),
            ),
        ).toBe(true);

        view.destroy();
        parent.remove();
    });

    it("keeps callout prefixes hidden on the active line and on body lines", () => {
        const doc = "> [!note] Title\n> Body";
        const { plugin, parent, view } = createView(
            doc,
            EditorSelection.cursor(3),
        );

        const decorations = collectDecorations(view, plugin);

        expect(hasHiddenRange(decorations, 0, 10)).toBe(true);
        expect(hasHiddenRange(decorations, 16, 18)).toBe(true);
        expect(
            decorations.some((deco) =>
                deco.className.split(" ").includes("cm-lp-callout-head"),
            ),
        ).toBe(true);

        view.destroy();
        parent.remove();
    });

    it("shows raw heading syntax while the caret is editing that heading line", () => {
        const doc = "## Heading";
        const { plugin, parent, view } = createView(
            doc,
            EditorSelection.cursor(1),
        );

        const decorations = collectDecorations(view, plugin);

        expect(hasHiddenRange(decorations, 0, 3)).toBe(false);
        expect(
            decorations.some((deco) =>
                deco.className.split(" ").includes("cm-lp-h2"),
            ),
        ).toBe(false);

        view.destroy();
        parent.remove();
    });

    it("applies heading live preview again once the caret leaves that heading line", () => {
        const doc = "## Heading\nNext line";
        const { plugin, parent, view } = createView(
            doc,
            EditorSelection.cursor(doc.length),
        );

        const decorations = collectDecorations(view, plugin);

        expect(hasHiddenRange(decorations, 0, 3)).toBe(true);
        expect(
            decorations.some((deco) =>
                deco.className.split(" ").includes("cm-lp-h2"),
            ),
        ).toBe(true);

        view.destroy();
        parent.remove();
    });

    it("keeps fenced code markers hidden even when the caret is on the fence line", () => {
        const doc = "```ts\nconst value = 1;\n```";
        const { plugin, parent, view } = createView(
            doc,
            EditorSelection.cursor(1),
        );

        const decorations = collectDecorations(view, plugin);

        expect(hasHiddenRange(decorations, 0, 6)).toBe(true);
        expect(hasHiddenRange(decorations, 22, 26)).toBe(true);

        view.destroy();
        parent.remove();
    });

    it("keeps bold markers hidden when the caret is outside the token", () => {
        const doc = "before **bold** after";
        const { plugin, parent, view } = createView(
            doc,
            EditorSelection.cursor(0),
        );

        const decorations = collectDecorations(view, plugin);

        expect(hasHiddenRange(decorations, 7, 9, "cm-lp-hidden-inline")).toBe(
            true,
        );
        expect(hasHiddenRange(decorations, 13, 15, "cm-lp-hidden-inline")).toBe(
            true,
        );

        view.destroy();
        parent.remove();
    });

    it("reveals both bold delimiters when the caret is inside the token", () => {
        const doc = "before **bold** after";
        const { plugin, parent, view } = createView(
            doc,
            EditorSelection.cursor(10),
        );

        const decorations = collectDecorations(view, plugin);

        expect(hasHiddenRange(decorations, 7, 9, "cm-lp-hidden-inline")).toBe(
            false,
        );
        expect(hasHiddenRange(decorations, 13, 15, "cm-lp-hidden-inline")).toBe(
            false,
        );

        view.destroy();
        parent.remove();
    });

    it("reveals the full markdown link when the caret is inside the token", () => {
        const doc = "[text](url)";
        const { plugin, parent, view } = createView(
            doc,
            EditorSelection.cursor(2),
        );

        let decorations = collectDecorations(view, plugin);
        expect(hasHiddenRange(decorations, 0, 1)).toBe(false);
        expect(hasHiddenRange(decorations, 5, 11)).toBe(false);

        view.dispatch({
            selection: EditorSelection.cursor(doc.length),
        });
        decorations = collectDecorations(view, plugin);
        expect(hasHiddenRange(decorations, 0, 1)).toBe(true);
        expect(hasHiddenRange(decorations, 5, 11)).toBe(true);

        view.destroy();
        parent.remove();
    });

    it("reveals highlight delimiters only while the token is active", () => {
        const doc = "==mark==";
        const { plugin, parent, view } = createView(
            doc,
            EditorSelection.cursor(3),
        );

        let decorations = collectDecorations(view, plugin);
        expect(hasHiddenRange(decorations, 0, 2, "cm-lp-hidden-inline")).toBe(
            false,
        );
        expect(hasHiddenRange(decorations, 6, 8, "cm-lp-hidden-inline")).toBe(
            false,
        );

        view.dispatch({
            selection: EditorSelection.cursor(doc.length),
        });
        decorations = collectDecorations(view, plugin);
        expect(hasHiddenRange(decorations, 0, 2, "cm-lp-hidden-inline")).toBe(
            true,
        );
        expect(hasHiddenRange(decorations, 6, 8, "cm-lp-hidden-inline")).toBe(
            true,
        );

        view.destroy();
        parent.remove();
    });

    it("reveals wikilink delimiters only while the token is active", () => {
        const doc = "[[target|alias]]";
        const { plugin, parent, view } = createView(
            doc,
            EditorSelection.cursor(10),
        );

        let decorations = collectDecorations(view, plugin);
        expect(hasHiddenRange(decorations, 0, 9, "cm-lp-hidden-inline")).toBe(
            false,
        );
        expect(hasHiddenRange(decorations, 14, 16, "cm-lp-hidden-inline")).toBe(
            false,
        );

        view.dispatch({
            selection: EditorSelection.cursor(doc.length),
        });
        decorations = collectDecorations(view, plugin);
        expect(hasHiddenRange(decorations, 0, 9, "cm-lp-hidden-inline")).toBe(
            true,
        );
        expect(hasHiddenRange(decorations, 14, 16, "cm-lp-hidden-inline")).toBe(
            true,
        );

        view.destroy();
        parent.remove();
    });

    it("reveals inline HTML tags only while the token is active", () => {
        const doc = "<sub>x</sub>";
        const { plugin, parent, view } = createView(
            doc,
            EditorSelection.cursor(5),
        );

        let decorations = collectDecorations(view, plugin);
        expect(hasHiddenRange(decorations, 0, 5)).toBe(false);
        expect(hasHiddenRange(decorations, 6, 12)).toBe(false);

        view.dispatch({
            selection: EditorSelection.cursor(doc.length),
        });
        decorations = collectDecorations(view, plugin);
        expect(hasHiddenRange(decorations, 0, 5)).toBe(true);
        expect(hasHiddenRange(decorations, 6, 12)).toBe(true);

        view.destroy();
        parent.remove();
    });

    it("reveals footnote ref delimiters only while the token is active", () => {
        const doc = "[^ref]";
        const { plugin, parent, view } = createView(
            doc,
            EditorSelection.cursor(3),
        );

        let decorations = collectDecorations(view, plugin);
        expect(hasHiddenRange(decorations, 0, 2, "cm-lp-hidden-inline")).toBe(
            false,
        );
        expect(hasHiddenRange(decorations, 5, 6, "cm-lp-hidden-inline")).toBe(
            false,
        );

        view.dispatch({
            selection: EditorSelection.cursor(doc.length),
        });
        decorations = collectDecorations(view, plugin);
        expect(hasHiddenRange(decorations, 0, 2, "cm-lp-hidden-inline")).toBe(
            true,
        );
        expect(hasHiddenRange(decorations, 5, 6, "cm-lp-hidden-inline")).toBe(
            true,
        );

        view.destroy();
        parent.remove();
    });

    it("switches the active inline token when moving within the same line", () => {
        const doc = "==bold== and ==mark==";
        const { plugin, parent, view } = createView(
            doc,
            EditorSelection.cursor(3),
        );

        let decorations = collectDecorations(view, plugin);
        expect(hasHiddenRange(decorations, 0, 2, "cm-lp-hidden-inline")).toBe(
            false,
        );
        expect(hasHiddenRange(decorations, 13, 15, "cm-lp-hidden-inline")).toBe(
            true,
        );

        view.dispatch({
            selection: EditorSelection.cursor(16),
        });

        decorations = collectDecorations(view, plugin);
        expect(hasHiddenRange(decorations, 0, 2, "cm-lp-hidden-inline")).toBe(
            true,
        );
        expect(hasHiddenRange(decorations, 13, 15, "cm-lp-hidden-inline")).toBe(
            false,
        );

        view.destroy();
        parent.remove();
    });

    it("reveals single-line block math raw when the token is active", () => {
        const doc = "$$x$$";
        const { plugin, parent, view } = createView(
            doc,
            EditorSelection.cursor(2),
        );

        let decorations = collectDecorations(view, plugin);
        expect(hasWidgetRange(decorations, 0, 5)).toBe(false);

        view.dispatch({
            selection: EditorSelection.cursor(doc.length),
        });
        decorations = collectDecorations(view, plugin);
        expect(hasWidgetRange(decorations, 0, 5)).toBe(true);

        view.destroy();
        parent.remove();
    });

    it("does not treat dollar prices as inline math widgets", () => {
        const doc = "**WTI +4.90% a $94.75** y **Brent +5.60% a $97.10**";
        const { plugin, parent, view } = createView(
            doc,
            EditorSelection.cursor(0),
        );

        const decorations = collectDecorations(view, plugin);
        expect(decorations.some((deco) => deco.hasWidget)).toBe(false);

        view.destroy();
        parent.remove();
    });

    it("rebuilds inline decorations when selection moves within the same line", () => {
        const perfMeasureMock = vi.mocked(perfMeasure);
        const { parent, view } = createView(
            "before ==mark== after",
            EditorSelection.cursor(0),
        );

        perfMeasureMock.mockClear();

        view.dispatch({
            selection: EditorSelection.cursor(10),
        });

        expect(perfMeasureMock).toHaveBeenCalledWith(
            "editor.livePreviewInline.build.selectionSet",
            expect.any(Number),
            expect.any(Object),
        );

        view.destroy();
        parent.remove();
    });

    it("skips inline rebuild when the active token does not change", () => {
        const perfMeasureMock = vi.mocked(perfMeasure);
        const { parent, view } = createView(
            "before ==mark== after",
            EditorSelection.cursor(10),
        );

        perfMeasureMock.mockClear();

        view.dispatch({
            selection: EditorSelection.cursor(11),
        });

        expect(perfMeasureMock).not.toHaveBeenCalled();

        view.destroy();
        parent.remove();
    });

    it("rebuilds list line decorations when indenting with leading whitespace changes", () => {
        const perfMeasureMock = vi.mocked(perfMeasure);
        const { plugin, parent, view } = createView(
            "- item",
            EditorSelection.cursor(0),
        );

        perfMeasureMock.mockClear();

        view.dispatch({
            changes: { from: 0, insert: "  " },
        });

        const decorations = collectDecorations(view, plugin);
        const lineDecoration = findDecorationByClass(
            decorations,
            "cm-lp-li-line",
        );

        expect(lineDecoration?.style).toContain("--cm-lp-indent: 2ch");
        expect(perfMeasureMock).toHaveBeenCalledWith(
            "editor.livePreviewInline.build.docChanged",
            expect.any(Number),
            expect.any(Object),
        );

        view.destroy();
        parent.remove();
    });

    it("rebuilds list preview when typing the first character into an empty list item", () => {
        const perfMeasureMock = vi.mocked(perfMeasure);
        const { plugin, parent, view } = createView(
            "- ",
            EditorSelection.cursor(2),
        );

        perfMeasureMock.mockClear();

        view.dispatch({
            changes: { from: 2, insert: "a" },
            selection: EditorSelection.cursor(3),
        });

        const decorations = collectDecorations(view, plugin);

        expect(hasHiddenRange(decorations, 0, 2)).toBe(true);
        expect(
            decorations.some((deco) =>
                deco.className.split(" ").includes("cm-lp-li-line"),
            ),
        ).toBe(true);
        expect(perfMeasureMock).toHaveBeenCalledWith(
            "editor.livePreviewInline.build.docChanged",
            expect.any(Number),
            expect.any(Object),
        );

        view.destroy();
        parent.remove();
    });

    it("collapses frontmatter block when cursor is outside it", () => {
        const collapseField = createLeadingContentCollapseField();
        const parent = document.createElement("div");
        document.body.appendChild(parent);
        const doc = "---\ntitle: Hello\n---\n\nBody text";
        const view = new EditorView({
            state: EditorState.create({
                doc,
                selection: EditorSelection.cursor(doc.indexOf("Body")),
                extensions: [
                    markdown({ base: markdownLanguage }),
                    collapseField,
                ],
            }),
            parent,
        });

        const decos: Array<{ from: number; to: number }> = [];
        view.state
            .field(collapseField)
            .between(0, view.state.doc.length, (from, to) => {
                decos.push({ from, to });
            });

        expect(decos.some((d) => d.from === 0 && d.to >= 20)).toBe(true);

        view.destroy();
        parent.remove();
    });

    it("reveals frontmatter when cursor is inside it", () => {
        const collapseField = createLeadingContentCollapseField();
        const parent = document.createElement("div");
        document.body.appendChild(parent);
        const doc = "---\ntitle: Hello\n---\n\nBody text";
        const view = new EditorView({
            state: EditorState.create({
                doc,
                selection: EditorSelection.cursor(doc.indexOf("title")),
                extensions: [
                    markdown({ base: markdownLanguage }),
                    collapseField,
                ],
            }),
            parent,
        });

        const decos: Array<{ from: number; to: number }> = [];
        view.state
            .field(collapseField)
            .between(0, view.state.doc.length, (from, to) => {
                decos.push({ from, to });
            });

        expect(decos.some((d) => d.from === 0 && d.to >= 20)).toBe(false);

        view.destroy();
        parent.remove();
    });

    it("keeps frontmatter collapsed on initial open with the default cursor at doc start", () => {
        const collapseField = createLeadingContentCollapseField();
        const parent = document.createElement("div");
        document.body.appendChild(parent);
        const doc = "---\ntitle: Hello\n---\n\nBody text";
        const view = new EditorView({
            state: EditorState.create({
                doc,
                selection: EditorSelection.cursor(0),
                extensions: [
                    markdown({ base: markdownLanguage }),
                    collapseField,
                ],
            }),
            parent,
        });

        const decos: Array<{ from: number; to: number }> = [];
        view.state
            .field(collapseField)
            .between(0, view.state.doc.length, (from, to) => {
                decos.push({ from, to });
            });

        expect(decos.some((d) => d.from === 0 && d.to >= 20)).toBe(true);

        view.destroy();
        parent.remove();
    });

    it("treats a cursor at the collapsed boundary as outside the hidden block", () => {
        const collapseField = createLeadingContentCollapseField();
        const parent = document.createElement("div");
        document.body.appendChild(parent);
        const doc = "---\ntitle: Hello\n---\n\nBody text";
        const frontmatterEnd = doc.indexOf("Body") - 1;
        const view = new EditorView({
            state: EditorState.create({
                doc,
                selection: EditorSelection.cursor(frontmatterEnd),
                extensions: [
                    markdown({ base: markdownLanguage }),
                    collapseField,
                ],
            }),
            parent,
        });

        const decos: Array<{ from: number; to: number }> = [];
        view.state
            .field(collapseField)
            .between(0, view.state.doc.length, (from, to) => {
                decos.push({ from, to });
            });

        expect(decos.some((d) => d.from === 0 && d.to >= 20)).toBe(true);

        view.destroy();
        parent.remove();
    });

    it("collapses leading H1 after frontmatter in live preview", () => {
        const collapseField = createLeadingContentCollapseField();
        const parent = document.createElement("div");
        document.body.appendChild(parent);
        const doc = "---\ntitle: Hello\n---\n\n# Hello\n\nBody text";
        const view = new EditorView({
            state: EditorState.create({
                doc,
                selection: EditorSelection.cursor(doc.indexOf("Body")),
                extensions: [
                    markdown({ base: markdownLanguage }),
                    collapseField,
                ],
            }),
            parent,
        });

        const decos: Array<{ from: number; to: number }> = [];
        view.state
            .field(collapseField)
            .between(0, view.state.doc.length, (from, to) => {
                decos.push({ from, to });
            });

        const h1From = doc.indexOf("# Hello");
        expect(decos.some((d) => d.from === h1From)).toBe(true);

        view.destroy();
        parent.remove();
    });

    it("collapses leading H1 without frontmatter", () => {
        const collapseField = createLeadingContentCollapseField();
        const parent = document.createElement("div");
        document.body.appendChild(parent);
        const doc = "# Hello\n\nBody text";
        const view = new EditorView({
            state: EditorState.create({
                doc,
                selection: EditorSelection.cursor(doc.indexOf("Body")),
                extensions: [
                    markdown({ base: markdownLanguage }),
                    collapseField,
                ],
            }),
            parent,
        });

        const decos: Array<{ from: number; to: number }> = [];
        view.state
            .field(collapseField)
            .between(0, view.state.doc.length, (from, to) => {
                decos.push({ from, to });
            });

        expect(decos.some((d) => d.from === 0 && d.to >= 7)).toBe(true);

        view.destroy();
        parent.remove();
    });
});
