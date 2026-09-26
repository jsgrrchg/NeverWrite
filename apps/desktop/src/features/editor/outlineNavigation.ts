import { EditorView } from "@codemirror/view";
import type { OutlineSelection } from "../notes/outlineModel";
import { flashLine } from "./extensions/livePreviewHelpers";

/** Shared by the sidebar and the rail; positions refer to the full CM document. */
export function revealOutlineSelection(view: EditorView, selection: OutlineSelection) {
    const docLength = view.state.doc.length;
    const anchor = Math.max(0, Math.min(selection.anchor, docLength));
    const head = Math.max(0, Math.min(selection.head, docLength));
    view.dispatch({
        selection: { anchor, head },
        effects: EditorView.scrollIntoView(anchor, { y: "center" }),
    });
    flashLine(view, anchor);
    view.focus();
}
