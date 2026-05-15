import type { NoteDto, VaultEntryDto } from "../../app/store/vaultStore";

export interface NoteMoveOperation {
    note: NoteDto;
    fromId: string;
    toPath: string;
}

export interface MoveTargets {
    notes: NoteDto[];
    entries: VaultEntryDto[];
    folderPaths: string[];
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

export function buildEntryMovePath(
    entry: Pick<VaultEntryDto, "relative_path" | "file_name">,
    targetFolder: string,
) {
    const currentParent = getParentPath(entry.relative_path);
    if (currentParent === targetFolder) return null;
    return targetFolder ? `${targetFolder}/${entry.file_name}` : entry.file_name;
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

export function getMoveTargetCount(targets: MoveTargets) {
    return (
        targets.notes.length +
        targets.entries.length +
        targets.folderPaths.length
    );
}

export function getMoveTargetsCommonParent(targets: MoveTargets) {
    const parents = [
        ...targets.notes.map((note) => getParentPath(note.id)),
        ...targets.entries.map((entry) => getParentPath(entry.relative_path)),
        ...targets.folderPaths.map(getParentPath),
    ];

    if (parents.length === 0) return null;
    const firstParent = parents[0] ?? "";
    return parents.every((parent) => parent === firstParent)
        ? firstParent
        : null;
}

export function normalizeMoveTargets(targets: MoveTargets): MoveTargets {
    const folderPaths = targets.folderPaths.filter(
        (path) =>
            !targets.folderPaths.some(
                (candidate) =>
                    candidate !== path && path.startsWith(`${candidate}/`),
            ),
    );
    const isInsideSelectedFolder = (path: string) =>
        folderPaths.some((folderPath) => path.startsWith(`${folderPath}/`));

    return {
        folderPaths,
        notes: targets.notes.filter((note) => !isInsideSelectedFolder(note.id)),
        entries: targets.entries.filter(
            (entry) => !isInsideSelectedFolder(entry.relative_path),
        ),
    };
}

export function canMoveTargetsToFolder(
    targets: MoveTargets,
    targetFolder: string,
) {
    const normalized = normalizeMoveTargets(targets);
    if (getMoveTargetCount(normalized) === 0) return false;

    const foldersMovable = normalized.folderPaths.every((path) =>
        canMoveFolderToTarget(path, targetFolder),
    );
    if (!foldersMovable) return false;

    const folderMoves = normalized.folderPaths.length;
    const noteMoves = buildNoteMoveOperations(
        normalized.notes,
        targetFolder,
    ).length;
    const entryMoves = normalized.entries.filter(
        (entry) => buildEntryMovePath(entry, targetFolder) !== null,
    ).length;

    return folderMoves + noteMoves + entryMoves > 0;
}
