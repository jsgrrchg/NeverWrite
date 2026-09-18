export const REVEAL_NOTE_IN_TREE_EVENT = "neverwrite:reveal-note-in-tree";
export const CLEAR_FILE_TREE_SELECTION_EVENT =
    "neverwrite:clear-file-tree-selection";

export function revealNoteInTree(noteId: string) {
    useLayoutStore.getState().showSidebarView("files");
    window.requestAnimationFrame(() => {
        window.dispatchEvent(
            new CustomEvent(REVEAL_NOTE_IN_TREE_EVENT, {
                detail: { noteId },
            }),
        );
    });
}

export function clearFileTreeSelection() {
    window.dispatchEvent(new CustomEvent(CLEAR_FILE_TREE_SELECTION_EVENT));
}
import { useLayoutStore } from "../store/layoutStore";
