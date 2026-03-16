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

function isAbsoluteFilePath(value: string) {
    return (
        value.startsWith("/") ||
        value.startsWith("\\\\") ||
        /^[A-Za-z]:[\\/]/.test(value)
    );
}

function joinVaultFilePath(vaultPath: string, relativePath: string) {
    if (isAbsoluteFilePath(relativePath)) {
        return relativePath;
    }

    const separator = vaultPath.includes("\\") ? "\\" : "/";
    const normalizedBase = vaultPath.replace(/[\\/]+$/, "");
    const normalizedRelative = relativePath
        .replace(/\\/g, "/")
        .replace(/^\/+/, "");
    const joined = `${normalizedBase}/${normalizedRelative}`;
    return separator === "\\" ? joined.replace(/\//g, "\\") : joined;
}

function buildDraggedFiles(
    tab: Tab,
    vaultPath: string | null,
): FileTreeDraggedFile[] | null {
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

    if (isNoteTab(tab) && vaultPath) {
        const filePath = joinVaultFilePath(vaultPath, tab.noteId);
        return [
            {
                filePath,
                fileName: getPathBaseName(tab.noteId) || tab.title,
                mimeType: "text/markdown",
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
    vaultPath: string | null,
): FileTreeNoteDragDetail | null {
    const files = buildDraggedFiles(tab, vaultPath);
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
