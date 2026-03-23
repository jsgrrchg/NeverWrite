import { getBaseName } from "./fileTreeMoves";

const FILE_TREE_CLIPBOARD_KEY = "vaultai.fileTree.clipboard";

export type FileTreeClipboardPayload =
    | {
          kind: "notes";
          vaultPath: string;
          noteIds: string[];
      }
    | {
          kind: "folder";
          vaultPath: string;
          folderPath: string;
      };

function makeCopyName(baseName: string, attempt: number) {
    return attempt === 1 ? `${baseName} copy` : `${baseName} copy ${attempt}`;
}

function joinPath(parentPath: string, name: string) {
    return parentPath ? `${parentPath}/${name}` : name;
}

function folderPathExists(folderPath: string, takenPaths: Set<string>) {
    if (!folderPath) return false;
    if (takenPaths.has(folderPath)) return true;
    for (const path of takenPaths) {
        if (path.startsWith(`${folderPath}/`)) {
            return true;
        }
    }
    return false;
}

export function writeFileTreeClipboard(payload: FileTreeClipboardPayload) {
    try {
        localStorage.setItem(FILE_TREE_CLIPBOARD_KEY, JSON.stringify(payload));
    } catch {
        console.warn("Failed to write file tree clipboard to localStorage");
    }
}

export function readFileTreeClipboard(
    vaultPath: string | null,
): FileTreeClipboardPayload | null {
    if (!vaultPath) return null;

    try {
        const raw = localStorage.getItem(FILE_TREE_CLIPBOARD_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<FileTreeClipboardPayload>;

        if (parsed?.vaultPath !== vaultPath) {
            return null;
        }

        if (
            parsed.kind === "notes" &&
            Array.isArray(parsed.noteIds) &&
            parsed.noteIds.every(
                (noteId) => typeof noteId === "string" && noteId.length > 0,
            )
        ) {
            return {
                kind: "notes",
                vaultPath,
                noteIds: parsed.noteIds,
            };
        }

        if (
            parsed.kind === "folder" &&
            typeof parsed.folderPath === "string" &&
            parsed.folderPath.length > 0
        ) {
            return {
                kind: "folder",
                vaultPath,
                folderPath: parsed.folderPath,
            };
        }
    } catch {
        return null;
    }

    return null;
}

export function canPasteFolderClipboard(
    clipboard: FileTreeClipboardPayload | null,
    targetFolder: string,
) {
    if (clipboard?.kind !== "folder") return false;
    if (clipboard.folderPath === targetFolder) return false;
    if (targetFolder.startsWith(`${clipboard.folderPath}/`)) return false;
    return true;
}

export function buildCopiedNotePath(
    sourceNoteId: string,
    targetFolder: string,
    takenNoteIds: Set<string>,
) {
    const baseName = getBaseName(sourceNoteId);
    const directPath = joinPath(targetFolder, baseName);
    if (!takenNoteIds.has(directPath)) return directPath;

    const MAX_ATTEMPTS = 1000;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const candidate = joinPath(
            targetFolder,
            makeCopyName(baseName, attempt),
        );
        if (!takenNoteIds.has(candidate)) {
            return candidate;
        }
    }
    return joinPath(targetFolder, `${baseName}-${Date.now()}`);
}

export function buildCopiedFolderPath(
    sourceFolderPath: string,
    targetFolder: string,
    takenPaths: Set<string>,
) {
    const baseName = getBaseName(sourceFolderPath);
    const directPath = joinPath(targetFolder, baseName);
    if (!folderPathExists(directPath, takenPaths)) return directPath;

    const MAX_ATTEMPTS = 1000;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const candidate = joinPath(
            targetFolder,
            makeCopyName(baseName, attempt),
        );
        if (!folderPathExists(candidate, takenPaths)) {
            return candidate;
        }
    }
    return joinPath(targetFolder, `${baseName}-${Date.now()}`);
}
