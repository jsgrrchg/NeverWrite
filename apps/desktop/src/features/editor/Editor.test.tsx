import { act, screen } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../app/store/editorStore";
import { Editor } from "./Editor";
import {
    flushPromises,
    mockInvoke,
    renderComponent,
    setEditorTabs,
    setVaultNotes,
} from "../../test/test-utils";

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
            },
        ]);

        renderComponent(<Editor />);
        expect(
            screen.queryByText("Open a note from the left panel"),
        ).not.toBeInTheDocument();

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

    it("saves the previous tab immediately when switching tabs with pending autosave", async () => {
        mockInvoke().mockImplementation(async (command) => {
            if (command === "save_note") {
                return {
                    id: "notes/current",
                    path: "/vault/notes/current.md",
                    title: "Current",
                    content: "Updated body",
                };
            }
            return undefined;
        });

        setEditorTabs(
            [
                {
                    id: "tab-1",
                    noteId: "notes/current",
                    title: "Current",
                    content: "Original body",
                },
                {
                    id: "tab-2",
                    noteId: "notes/other",
                    title: "Other",
                    content: "Other body",
                },
            ],
            "tab-1",
        );
        setVaultNotes([
            {
                id: "notes/current",
                title: "Current",
                path: "/vault/notes/current.md",
                modified_at: 0,
                created_at: 0,
            },
            {
                id: "notes/other",
                title: "Other",
                path: "/vault/notes/other.md",
                modified_at: 0,
                created_at: 0,
            },
        ]);

        renderComponent(<Editor />);
        const view = getEditorView();

        await act(async () => {
            view.dispatch({
                changes: {
                    from: 0,
                    to: view.state.doc.length,
                    insert: "Updated body",
                },
            });
        });

        await act(async () => {
            useEditorStore.getState().switchTab("tab-2");
        });
        await flushPromises();

        expect(mockInvoke()).toHaveBeenCalledWith("save_note", {
            noteId: "notes/current",
            content: "Updated body",
            vaultPath: "/vault",
        });
    });

    it("updates the visible title when clean content reloads from disk", async () => {
        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Current",
                content: "# Current\n\nBody",
            },
        ]);
        setVaultNotes([
            {
                id: "notes/current",
                title: "Current",
                path: "/vault/notes/current.md",
                modified_at: 0,
                created_at: 0,
            },
        ]);

        renderComponent(<Editor />);
        expect(screen.getByDisplayValue("Current")).toBeInTheDocument();

        await act(async () => {
            useEditorStore.getState().reloadNoteContent("notes/current", {
                title: "Renamed externally",
                content: "---\ntitle: Renamed externally\n---\nBody",
            });
        });

        expect(screen.getAllByDisplayValue("Renamed externally")).toHaveLength(
            2,
        );
    });

    it("does not save a clean tab when switching notes", async () => {
        setEditorTabs(
            [
                {
                    id: "tab-1",
                    noteId: "notes/current",
                    title: "Current",
                    content: "Original body",
                },
                {
                    id: "tab-2",
                    noteId: "notes/other",
                    title: "Other",
                    content: "Other body",
                },
            ],
            "tab-1",
        );

        renderComponent(<Editor />);

        await act(async () => {
            useEditorStore.getState().switchTab("tab-2");
        });
        await flushPromises();

        expect(mockInvoke()).not.toHaveBeenCalledWith(
            "save_note",
            expect.anything(),
        );
    });

    it("closes the active tab on Cmd+W", async () => {
        setEditorTabs(
            [
                {
                    id: "tab-1",
                    noteId: "notes/current",
                    title: "Current",
                    content: "Current body",
                },
                {
                    id: "tab-2",
                    noteId: "notes/other",
                    title: "Other",
                    content: "Other body",
                },
            ],
            "tab-2",
        );

        renderComponent(<Editor />);

        await act(async () => {
            window.dispatchEvent(
                new KeyboardEvent("keydown", {
                    key: "w",
                    metaKey: true,
                    bubbles: true,
                }),
            );
        });

        expect(useEditorStore.getState().tabs.map((tab) => tab.id)).toEqual([
            "tab-1",
        ]);
        expect(useEditorStore.getState().activeTabId).toBe("tab-1");
    });
});
