import { act, screen } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { Editor } from "./Editor";
import { renderComponent, setEditorTabs } from "../../test/test-utils";

function getEditorView() {
    const editorElement = document.querySelector(".cm-editor");
    expect(editorElement).not.toBeNull();

    const view = EditorView.findFromDOM(editorElement as HTMLElement);
    expect(view).not.toBeNull();
    return view!;
}

describe("Editor", () => {
    it("hides the selection layer when the selection collapses", async () => {
        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Current",
                content: "First paragraph\n\nSecond paragraph",
                isDirty: false,
            },
        ]);

        renderComponent(<Editor />);
        expect(screen.queryByText("Open a note from the left panel")).not.toBeInTheDocument();

        const view = getEditorView();
        const coordsSpy = vi
            .spyOn(view, "coordsAtPos")
            .mockImplementation(() => ({
                left: 40,
                right: 180,
                top: 20,
                bottom: 40,
            }));

        await act(async () => {
            view.focus();
            view.dispatch({
                selection: {
                    anchor: 0,
                    head: 5,
                },
            });
        });

        const selectionLayer = view.dom.querySelector(".cm-selectionLayer");
        expect(selectionLayer).toBeInstanceOf(HTMLElement);
        expect((selectionLayer as HTMLElement).style.opacity).toBe("1");

        await act(async () => {
            view.dispatch({
                selection: {
                    anchor: 5,
                    head: 5,
                },
            });
        });

        expect((selectionLayer as HTMLElement).style.opacity).toBe("0");
        coordsSpy.mockRestore();
    });
});
