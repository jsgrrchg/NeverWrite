export const REVEAL_NOTE_IN_TREE_EVENT = "neverwrite:reveal-note-in-tree";

export function revealNoteInTree(noteId: string) {
    window.dispatchEvent(
        new CustomEvent(REVEAL_NOTE_IN_TREE_EVENT, {
            detail: { noteId },
        }),
    );
}
