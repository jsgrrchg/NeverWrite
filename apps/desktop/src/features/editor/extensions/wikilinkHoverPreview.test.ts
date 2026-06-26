/**
 * @vitest-environment jsdom
 */
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { buildWikilinkHoverTooltip } from "./wikilinkHoverPreview";

function createView(doc: string) {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const state = EditorState.create({
        doc,
        selection: EditorSelection.cursor(0),
    });
    const view = new EditorView({ state, parent });
    return { parent, view };
}

afterEach(() => {
    document.body.innerHTML = "";
});

describe("buildWikilinkHoverTooltip", () => {
    it("returns an anchored tooltip when hovering inside a wikilink", () => {
        const { parent, view } = createView("before [[Target]] after");

        // Position inside the [[Target]] token.
        const tooltip = buildWikilinkHoverTooltip(view, 11);
        expect(tooltip).not.toBeNull();
        expect(tooltip?.pos).toBe(7);
        expect(tooltip?.end).toBe(17);

        const mounted = tooltip?.create?.(view);
        expect(
            mounted?.dom.querySelector(".cm-wikilink-hover-title")?.textContent,
        ).toBe("Target");

        view.destroy();
        parent.remove();
    });

    it("uses the target side of a piped wikilink", () => {
        const { parent, view } = createView("[[Target|alias]]");
        const tooltip = buildWikilinkHoverTooltip(view, 4);
        const mounted = tooltip?.create?.(view);
        expect(
            mounted?.dom.querySelector(".cm-wikilink-hover-title")?.textContent,
        ).toBe("Target");

        view.destroy();
        parent.remove();
    });

    it("returns null outside any wikilink", () => {
        const { parent, view } = createView("before [[Target]] after");
        expect(buildWikilinkHoverTooltip(view, 2)).toBeNull();

        view.destroy();
        parent.remove();
    });
});
