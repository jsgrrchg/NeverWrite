import type { NoteDto } from "../../app/store/vaultStore";

export interface NoteMoveOperation {
    note: NoteDto;
    fromId: string;
    toPath: string;
}

export function getParentPath(path: string) {
    return path.includes("/") ? path.split("/").slice(0, -1).join("/") : "";
}

export function getBaseName(path: string) {
    return path.split("/").pop() ?? path;
}

export function buildNoteMoveOperations(
    notes: NoteDto[],
    targetFolder: string,
): NoteMoveOperation[] {
    return notes.flatMap((note) => {
        const currentParent = getParentPath(note.id);
        if (currentParent === targetFolder) return [];

        const filename = getBaseName(note.id);
        return [
            {
                note,
                fromId: note.id,
                toPath: targetFolder ? `${targetFolder}/${filename}` : filename,
            },
        ];
    });
}

export function canMoveFolderToTarget(
    sourceFolder: string,
    targetFolder: string,
) {
    if (sourceFolder === targetFolder) return false;
    if (targetFolder.startsWith(`${sourceFolder}/`)) return false;

    const folderName = getBaseName(sourceFolder);
    const nextFolderPath = targetFolder ? `${targetFolder}/${folderName}` : folderName;
    return nextFolderPath !== sourceFolder;
}

export function buildFolderMoveOperations(
    notes: NoteDto[],
    sourceFolder: string,
    targetFolder: string,
): NoteMoveOperation[] {
    if (!canMoveFolderToTarget(sourceFolder, targetFolder)) return [];

    const folderName = getBaseName(sourceFolder);
    const nextFolderPath = targetFolder ? `${targetFolder}/${folderName}` : folderName;
    const prefix = `${sourceFolder}/`;

    return notes.flatMap((note) => {
        if (!note.id.startsWith(prefix)) return [];
        const suffix = note.id.slice(prefix.length);
        return [
            {
                note,
                fromId: note.id,
                toPath: `${nextFolderPath}/${suffix}`,
            },
        ];
    });
}
