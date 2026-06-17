import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { drawSelection, EditorView } from "@codemirror/view";

import {
    linkReferenceField,
    footnoteNumberField,
} from "../../src/features/editor/extensions/livePreviewHelpers";
import { createInlineLivePreviewPlugin } from "../../src/features/editor/extensions/livePreviewInline";
import { livePreviewTheme } from "../../src/features/editor/extensions/livePreviewTheme";

type MountOptions = {
    doc: string;
    selection: number | { anchor: number; head?: number };
};

declare global {
    interface Window {
        mountEditor: (options: MountOptions) => void;
        editorView: EditorView | null;
    }
}

let view: EditorView | null = null;

function toSelection(selection: MountOptions["selection"]) {
    if (typeof selection === "number") return EditorSelection.cursor(selection);
    if (selection.head === undefined || selection.head === selection.anchor) {
        return EditorSelection.cursor(selection.anchor);
    }
    return EditorSelection.range(selection.anchor, selection.head);
}

window.mountEditor = ({ doc, selection }: MountOptions) => {
    view?.destroy();
    const parent = document.getElementById("editor");
    if (!parent) throw new Error("missing #editor mount node");
    parent.innerHTML = "";

    view = new EditorView({
        state: EditorState.create({
            doc,
            selection: toSelection(selection),
            extensions: [
                markdown({ base: markdownLanguage }),
                linkReferenceField,
                footnoteNumberField,
                createInlineLivePreviewPlugin(),
                livePreviewTheme,
                // The real editor (src/features/editor/Editor.tsx,
                // FileTextTabView.tsx) uses drawSelection() so the caret is a
                // CM-rendered element, not the native browser caret. Mirror
                // that here so e2e measurements reflect what users see.
                drawSelection(),
            ],
        }),
        parent,
    });

    view.focus();
    // Ensure the contenteditable inside the editor gets focus too, so the
    // caret element actually renders in headless browsers.
    const contentEl = parent.querySelector(".cm-content") as HTMLElement | null;
    contentEl?.focus();
    window.editorView = view;
};

window.editorView = null;
