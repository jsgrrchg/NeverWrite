import type { AIChatNoteSummary } from "./types";

export const FILE_TREE_NOTE_DRAG_EVENT = "neverwrite:file-tree-note-drag";
export const FILE_TREE_ATTACH_TO_NEW_CHAT_EVENT =
    "neverwrite:file-tree-attach-to-new-chat";

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

export interface FileTreeDraggedFolder {
    path: string;
    name: string;
}

export interface FileTreeNoteDragDetail {
    phase: FileTreeNoteDragPhase;
    x: number;
    y: number;
    targetSessionId?: string;
    notes: AIChatNoteSummary[];
    files?: FileTreeDraggedFile[];
    folder?: FileTreeDraggedFolder;
    folders?: FileTreeDraggedFolder[];
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

export function emitFileTreeAttachToNewChat(detail: FileTreeNoteDragDetail) {
    window.dispatchEvent(
        new CustomEvent<FileTreeNoteDragDetail>(
            FILE_TREE_ATTACH_TO_NEW_CHAT_EVENT,
            {
                detail,
            },
        ),
    );
}

export const EXTERNAL_FILE_TREE_DRAG_EVENT =
    "neverwrite:external-file-tree-drag";

export interface ExternalFileTreeDragDetail {
    phase: "over" | "cancel";
    folderPath: string | null;
}

export function emitExternalFileTreeDrag(detail: ExternalFileTreeDragDetail) {
    window.dispatchEvent(
        new CustomEvent<ExternalFileTreeDragDetail>(
            EXTERNAL_FILE_TREE_DRAG_EVENT,
            { detail },
        ),
    );
}
