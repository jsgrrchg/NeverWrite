/**
 * @vitest-environment jsdom
 */
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../app/utils/perfInstrumentation", () => ({
    perfCount: vi.fn(),
    perfMeasure: vi.fn(),
    perfNow: vi.fn(() => 1),
}));

import { perfMeasure } from "../../../app/utils/perfInstrumentation";
import { wikilinkExtension } from "./wikilinks";

function createView(
    doc: string,
    selection: EditorSelection | { anchor: number; head?: number },
) {
    const parent = document.createElement("div");
    document.body.appendChild(parent);

    const state = EditorState.create({
        doc,
        selection,
        extensions: [
            wikilinkExtension(
                (_noteId, targets) =>
                    new Map(
                        targets.map((target) => [target, "valid" as const]),
                    ),
                () => "note/current",
                vi.fn(),
            ),
        ],
    });

    const view = new EditorView({ state, parent });
    return { parent, view };
}

afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
});

describe("wikilinkExtension", () => {
    it("decorates visible wikilink text when the selection is on another line", () => {
        const { parent, view } = createView(
            "[[Target]]\nplain",
            EditorSelection.cursor(11),
        );

        const link = view.dom.querySelector(".cm-wikilink");

        expect(link).not.toBeNull();
        expect(link?.textContent).toBe("Target");

        view.destroy();
        parent.remove();
    });

    it("removes visible wikilink styling while the token is active", () => {
        const { parent, view } = createView(
            "[[target|alias]]",
            EditorSelection.cursor(10),
        );

        expect(view.dom.querySelector(".cm-wikilink")).toBeNull();

        view.dispatch({
            selection: EditorSelection.cursor(16),
        });

        const link = view.dom.querySelector(".cm-wikilink");
        expect(link).not.toBeNull();
        expect(link?.textContent).toBe("alias");

        view.destroy();
        parent.remove();
    });

    it("rebuilds wikilink decorations when selection moves within the same line", () => {
        const perfMeasureMock = vi.mocked(perfMeasure);
        const { parent, view } = createView(
            "before [[Target]] after",
            EditorSelection.cursor(0),
        );

        perfMeasureMock.mockClear();

        view.dispatch({
            selection: EditorSelection.cursor(10),
        });

        expect(perfMeasureMock).toHaveBeenCalledWith(
            "editor.wikilinks.build.selectionSet",
            expect.any(Number),
            expect.any(Object),
        );

        view.destroy();
        parent.remove();
    });

    it("skips wikilink rebuild when the active token does not change", () => {
        const perfMeasureMock = vi.mocked(perfMeasure);
        const { parent, view } = createView(
            "before [[Target]] after",
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
});
