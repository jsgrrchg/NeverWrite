import {
    isFileTab,
    isMapTab,
    isNoteTab,
    isPdfTab,
    type Tab,
} from "../../app/store/editorStore";
import { getPathBaseName } from "../../app/utils/path";
import type {
    FileTreeDraggedFile,
    FileTreeNoteDragDetail,
    FileTreeNoteDragPhase,
} from "../ai/dragEvents";

interface TabDragCoordinates {
    clientX: number;
    clientY: number;
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
        return [
            {
                filePath: tab.filePath,
                fileName: getPathBaseName(tab.filePath) || tab.title,
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
): FileTreeNoteDragDetail | null {
    if (isNoteTab(tab)) {
        return {
            phase,
            x: coords.clientX,
            y: coords.clientY,
            notes: [
                {
                    id: tab.noteId,
                    title: tab.title,
                    path: tab.noteId,
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
