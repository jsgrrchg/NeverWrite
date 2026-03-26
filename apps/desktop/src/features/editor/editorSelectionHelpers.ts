import type { EditorView } from "@codemirror/view";

type ClearEditorDomSelectionOptions = {
    includeCollapsed?: boolean;
};

export function clearEditorDomSelection(
    view: EditorView | null,
    options?: ClearEditorDomSelectionOptions,
) {
    if (!view) return;

    const selection = view.dom.ownerDocument.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    if (selection.isCollapsed && !options?.includeCollapsed) return;

    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    const touchesEditor =
        (!!anchorNode && view.dom.contains(anchorNode)) ||
        (!!focusNode && view.dom.contains(focusNode));

    if (touchesEditor) {
        selection.removeAllRanges();
    }
}

export function syncSelectionLayerVisibility(view: EditorView | null) {
    if (!view) return;

    const layer = view.dom.querySelector(".cm-selectionLayer");
    if (!(layer instanceof HTMLElement)) return;

    const hasSelection = view.hasFocus
        ? view.state.selection.ranges.some((range) => !range.empty)
        : false;

    layer.style.opacity = hasSelection ? "1" : "0";
}

export const EDITOR_INTERACTIVE_PREVIEW_SELECTOR = [
    ".cm-lp-link",
    ".cm-inline-image-link",
    ".cm-youtube-link",
    ".cm-note-embed",
    ".cm-lp-footnote-ref",
    ".cm-lp-table-link",
    ".cm-lp-table-url",
].join(", ");
