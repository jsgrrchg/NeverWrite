export type TabScrollPosition = {
    top: number;
    left: number;
    anchorPos: number | null;
    anchorOffsetTop: number;
};

const editorViewportPositions = new Map<string, TabScrollPosition>();

export function getEditorViewportPosition(noteId: string) {
    return editorViewportPositions.get(noteId);
}

export function setEditorViewportPosition(
    noteId: string,
    position: TabScrollPosition,
) {
    editorViewportPositions.set(noteId, position);
}

export function deleteEditorViewportPositions(noteIds: Iterable<string>) {
    for (const noteId of noteIds) {
        editorViewportPositions.delete(noteId);
    }
}

export function clearEditorViewportCache() {
    editorViewportPositions.clear();
}

export function getEditorViewportCacheMap() {
    return editorViewportPositions;
}
