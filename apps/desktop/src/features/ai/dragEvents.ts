import type { AIChatNoteSummary } from "./types";

export const FILE_TREE_NOTE_DRAG_EVENT = "vaultai:file-tree-note-drag";

export type FileTreeNoteDragPhase = "start" | "move" | "end" | "cancel";

export interface FileTreeNoteDragDetail {
    phase: FileTreeNoteDragPhase;
    x: number;
    y: number;
    notes: AIChatNoteSummary[];
    folder?: { path: string; name: string };
}

export function emitFileTreeNoteDrag(detail: FileTreeNoteDragDetail) {
    window.dispatchEvent(
        new CustomEvent<FileTreeNoteDragDetail>(FILE_TREE_NOTE_DRAG_EVENT, {
            detail,
        }),
    );
}
