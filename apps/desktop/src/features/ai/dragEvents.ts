import type { AIChatNoteSummary } from "./types";

export const FILE_TREE_NOTE_DRAG_EVENT = "neverwrite:file-tree-note-drag";

// "attach" skips the position check — used by context menu "Add to Chat"
export type FileTreeNoteDragPhase =
    | "start"
    | "move"
    | "end"
    | "cancel"
    | "attach";

export interface FileTreeDraggedFile {
    filePath: string;
    fileName: string;
    mimeType: string;
}

export interface FileTreeNoteDragDetail {
    phase: FileTreeNoteDragPhase;
    x: number;
    y: number;
    notes: AIChatNoteSummary[];
    files?: FileTreeDraggedFile[];
    folder?: { path: string; name: string };
    origin?: {
        kind: "workspace-tab";
        tabId: string;
    };
}

export function emitFileTreeNoteDrag(detail: FileTreeNoteDragDetail) {
    window.dispatchEvent(
        new CustomEvent<FileTreeNoteDragDetail>(FILE_TREE_NOTE_DRAG_EVENT, {
            detail,
        }),
    );
}
