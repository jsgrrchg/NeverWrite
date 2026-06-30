import {
    isFileTab,
    isMapTab,
    isNoteTab,
    isPdfTab,
    type Tab,
} from "../../app/store/editorStore";
import type { WorkspaceDropTarget } from "../../app/store/workspaceContracts";
import { getPathBaseName } from "../../app/utils/path";
import { resolveVaultAbsolutePath } from "../../app/utils/vaultPaths";
import { useVaultStore } from "../../app/store/vaultStore";
import type {
    FileTreeDraggedFile,
    FileTreeNoteDragDetail,
    FileTreeNoteDragPhase,
} from "../ai/dragEvents";

export interface TabDragCoordinates {
    clientX: number;
    clientY: number;
}

export interface TabDragCommitCoordinates extends TabDragCoordinates {
    screenX: number;
    screenY: number;
}

interface BuildTabFileDragDetailOptions {
    resolveNotePath?: (noteId: string) => string | null;
}

export type WorkspaceTabExternalDropTarget = Extract<
    WorkspaceDropTarget,
    { type: "composer" | "detach-window" | "none" }
>;

export interface WorkspaceTabExternalDragOptions {
    getTabById: (tabId: string) => Tab | null;
    resolveDetachDropTarget?: (
        tabId: string,
        coords: TabDragCoordinates,
    ) => Extract<WorkspaceDropTarget, { type: "detach-window" | "none" }>;
    commitDetachDrop?: (
        tabId: string,
        coords: TabDragCommitCoordinates,
    ) => Promise<void> | void;
}

export interface WorkspaceTabExternalDragHandlers {
    resolveExternalDropTarget: (
        tabId: string,
        coords: TabDragCoordinates,
    ) => WorkspaceTabExternalDropTarget;
    buildAttachmentDetail: (
        tabId: string,
        phase: FileTreeNoteDragPhase,
        coords: TabDragCoordinates,
    ) => FileTreeNoteDragDetail | null;
    onCommitExternalDrop: (
        tabId: string,
        target: WorkspaceTabExternalDropTarget,
        coords: TabDragCommitCoordinates,
    ) => Promise<void> | void;
}

function buildDraggedFiles(tab: Tab): FileTreeDraggedFile[] | null {
    if (isPdfTab(tab)) {
        return [
            {
                filePath: tab.path,
                fileName: getPathBaseName(tab.path) || tab.title,
                mimeType: "application/pdf",
            },
        ];
    }

    if (isFileTab(tab)) {
        const mimeType = tab.mimeType ?? "application/octet-stream";
        return [
            {
                filePath: tab.path,
                fileName: getPathBaseName(tab.path) || tab.title,
                mimeType,
                ...(mimeType.startsWith("image/") &&
                typeof tab.sizeBytes === "number"
                    ? { sizeBytes: tab.sizeBytes }
                    : {}),
            },
        ];
    }

    if (isMapTab(tab)) {
        const filePath = resolveVaultAbsolutePath(
            tab.relativePath,
            useVaultStore.getState().vaultPath,
        );
        return [
            {
                filePath,
                fileName: getPathBaseName(tab.relativePath) || tab.title,
                mimeType: "application/json",
            },
        ];
    }

    return null;
}

export function buildTabFileDragDetail(
    tab: Tab,
    phase: FileTreeNoteDragPhase,
    coords: TabDragCoordinates,
    options: BuildTabFileDragDetailOptions = {},
): FileTreeNoteDragDetail | null {
    if (isNoteTab(tab)) {
        const resolvedPath =
            options.resolveNotePath?.(tab.noteId) ?? tab.noteId;
        return {
            phase,
            x: coords.clientX,
            y: coords.clientY,
            notes: [
                {
                    id: tab.noteId,
                    title: tab.title,
                    path: resolvedPath,
                },
            ],
        };
    }

    const files = buildDraggedFiles(tab);
    if (!files) {
        return null;
    }

    return {
        phase,
        x: coords.clientX,
        y: coords.clientY,
        notes: [],
        files,
    };
}

export function isPointOverAiComposerDropZone(
    clientX: number,
    clientY: number,
) {
    const dropZones = document.querySelectorAll<HTMLElement>(
        '[data-ai-composer-drop-zone="true"]',
    );

    for (const zone of dropZones) {
        const rect = zone.getBoundingClientRect();
        if (
            clientX >= rect.left &&
            clientX <= rect.right &&
            clientY >= rect.top &&
            clientY <= rect.bottom
        ) {
            return true;
        }
    }

    return false;
}

export function resolveComposerDropTarget(
    clientX: number,
    clientY: number,
): Extract<WorkspaceDropTarget, { type: "composer" | "none" }> {
    if (isPointOverAiComposerDropZone(clientX, clientY)) {
        return { type: "composer" };
    }

    return { type: "none" };
}

function resolveVaultNotePath(noteId: string) {
    return (
        useVaultStore
            .getState()
            .notes.find((note) => note.id === noteId)?.path ?? null
    );
}

export function createWorkspaceTabExternalDragHandlers({
    getTabById,
    resolveDetachDropTarget,
    commitDetachDrop,
}: WorkspaceTabExternalDragOptions): WorkspaceTabExternalDragHandlers {
    return {
        resolveExternalDropTarget: (tabId, coords) => {
            const composerTarget = resolveComposerDropTarget(
                coords.clientX,
                coords.clientY,
            );
            if (composerTarget.type !== "none") {
                return composerTarget;
            }

            return (
                resolveDetachDropTarget?.(tabId, coords) ?? { type: "none" }
            );
        },
        buildAttachmentDetail: (tabId, phase, coords) => {
            const tab = getTabById(tabId);
            if (!tab) {
                return null;
            }

            return buildTabFileDragDetail(tab, phase, coords, {
                resolveNotePath: resolveVaultNotePath,
            });
        },
        onCommitExternalDrop: (tabId, target, coords) => {
            if (target.type !== "detach-window") {
                return;
            }

            return commitDetachDrop?.(tabId, coords);
        },
    };
}
