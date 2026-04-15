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

interface TabDragCoordinates {
    clientX: number;
    clientY: number;
}

interface BuildTabFileDragDetailOptions {
    resolveNotePath?: (noteId: string) => string | null;
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
        return [
            {
                filePath: tab.path,
                fileName: getPathBaseName(tab.path) || tab.title,
                mimeType: tab.mimeType ?? "application/octet-stream",
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
