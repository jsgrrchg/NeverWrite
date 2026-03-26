import {
    isFileTab,
    isNoteTab,
    type FileTab,
    type NoteTab,
    useEditorStore,
} from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";

export interface NoteEditorTarget {
    kind: "note";
    absolutePath: string;
    noteId: string;
    openTab: NoteTab | null;
}

export interface FileEditorTarget {
    kind: "file";
    absolutePath: string;
    relativePath: string;
    openTab: FileTab | null;
}

export type EditorTarget = NoteEditorTarget | FileEditorTarget;

export function normalizeVaultPathMatch(path: string) {
    return path.replace(/\\/g, "/");
}

function stripMarkdownExtension(path: string) {
    return path.toLowerCase().endsWith(".md") ? path.slice(0, -3) : path;
}

function normalizeVaultRoot(vaultPath: string | null) {
    if (!vaultPath) {
        return null;
    }

    return normalizeVaultPathMatch(vaultPath).replace(/\/+$/, "");
}

function resolveAbsolutePath(path: string, vaultPath: string | null) {
    const normalizedPath = normalizeVaultPathMatch(path);
    if (normalizedPath.startsWith("/")) {
        return normalizedPath;
    }

    const normalizedVaultPath = normalizeVaultRoot(vaultPath);
    if (!normalizedVaultPath) {
        return normalizedPath;
    }

    return `${normalizedVaultPath}/${normalizedPath.replace(/^\/+/, "")}`;
}

export function toVaultRelativePath(
    path: string,
    vaultPath: string | null,
): string | null {
    const normalizedPath = normalizeVaultPathMatch(path);
    if (!normalizedPath.startsWith("/")) {
        return normalizedPath;
    }

    const normalizedVaultPath = normalizeVaultRoot(vaultPath);
    if (!normalizedVaultPath) {
        return null;
    }

    const prefix = `${normalizedVaultPath}/`;
    if (!normalizedPath.startsWith(prefix)) {
        return null;
    }

    return normalizedPath.slice(prefix.length);
}

export function resolveMarkdownNoteIdForPath(path: string): string | null {
    const normalizedPath = normalizeVaultPathMatch(path);
    if (!normalizedPath.toLowerCase().endsWith(".md")) {
        return null;
    }

    const { tabs } = useEditorStore.getState();
    const openTab = tabs.find(
        (tab) =>
            isNoteTab(tab) &&
            normalizeVaultPathMatch(tab.noteId) === normalizedPath,
    );
    if (openTab && isNoteTab(openTab)) {
        return openTab.noteId;
    }

    const { notes, vaultPath } = useVaultStore.getState();
    const exactNote = notes.find(
        (note) => normalizeVaultPathMatch(note.path) === normalizedPath,
    );
    if (exactNote) {
        return exactNote.id;
    }

    const relativePath = toVaultRelativePath(normalizedPath, vaultPath);
    if (relativePath) {
        return stripMarkdownExtension(relativePath);
    }

    return stripMarkdownExtension(normalizedPath);
}

function resolveNoteIdCandidate(path: string) {
    return (
        resolveMarkdownNoteIdForPath(path) ??
        stripMarkdownExtension(normalizeVaultPathMatch(path))
    );
}

function resolveAbsoluteNotePathForNoteId(noteId: string): string {
    const normalizedNoteId = normalizeVaultPathMatch(noteId);
    const { notes, vaultPath } = useVaultStore.getState();
    const note = notes.find(
        (candidate) =>
            candidate.id === noteId ||
            normalizeVaultPathMatch(candidate.path) === normalizedNoteId,
    );
    if (note) {
        return normalizeVaultPathMatch(note.path);
    }

    const notePath = normalizedNoteId.toLowerCase().endsWith(".md")
        ? normalizedNoteId
        : `${normalizedNoteId}.md`;

    return resolveAbsolutePath(notePath, vaultPath);
}

export function findOpenNoteTarget(path: string): NoteEditorTarget | null {
    const noteId = resolveNoteIdCandidate(path);
    const { tabs } = useEditorStore.getState();
    const openTab = tabs.find(
        (tab) =>
            isNoteTab(tab) &&
            normalizeVaultPathMatch(tab.noteId) ===
                normalizeVaultPathMatch(noteId),
    );
    if (!openTab || !isNoteTab(openTab)) {
        return null;
    }

    return {
        kind: "note",
        absolutePath: resolveAbsolutePath(
            path,
            useVaultStore.getState().vaultPath,
        ),
        noteId,
        openTab,
    };
}

export function findOpenFileTarget(path: string): FileEditorTarget | null {
    const { vaultPath } = useVaultStore.getState();
    const normalizedPath = normalizeVaultPathMatch(path);
    const relativePath = toVaultRelativePath(path, vaultPath);
    const normalizedRelativePath = relativePath
        ? normalizeVaultPathMatch(relativePath)
        : null;
    const { tabs } = useEditorStore.getState();
    const openTab = tabs.find(
        (tab) =>
            isFileTab(tab) &&
            (normalizeVaultPathMatch(tab.path) === normalizedPath ||
                (normalizedRelativePath !== null &&
                    normalizeVaultPathMatch(tab.relativePath) ===
                        normalizedRelativePath)),
    );
    if (!openTab || !isFileTab(openTab)) {
        return null;
    }

    return {
        kind: "file",
        absolutePath: normalizedPath.startsWith("/")
            ? normalizedPath
            : normalizeVaultPathMatch(openTab.path),
        relativePath:
            normalizedRelativePath ??
            normalizeVaultPathMatch(openTab.relativePath),
        openTab,
    };
}

export function resolveNoteTargetForPath(
    path: string,
): NoteEditorTarget | null {
    const normalizedPath = normalizeVaultPathMatch(path);
    const openTarget = findOpenNoteTarget(path);
    if (openTarget) {
        return openTarget;
    }

    if (!normalizedPath.toLowerCase().endsWith(".md")) {
        return null;
    }

    return {
        kind: "note",
        absolutePath: resolveAbsolutePath(
            path,
            useVaultStore.getState().vaultPath,
        ),
        noteId: resolveNoteIdCandidate(path),
        openTab: null,
    };
}

export function resolveFileTargetForPath(
    path: string,
): FileEditorTarget | null {
    const openTarget = findOpenFileTarget(path);
    if (openTarget) {
        return openTarget;
    }

    const { vaultPath } = useVaultStore.getState();
    const relativePath = toVaultRelativePath(path, vaultPath);
    if (!relativePath) {
        return null;
    }

    return {
        kind: "file",
        absolutePath: resolveAbsolutePath(path, vaultPath),
        relativePath,
        openTab: null,
    };
}

export function resolveEditorTargetForTrackedPath(
    path: string,
): EditorTarget | null {
    return (
        findOpenNoteTarget(path) ??
        findOpenFileTarget(path) ??
        resolveNoteTargetForPath(path) ??
        resolveFileTargetForPath(path)
    );
}

export function resolveEditorTargetForOpenTab(
    tab: NoteTab | FileTab | null,
): EditorTarget | null {
    if (!tab) {
        return null;
    }

    if (isNoteTab(tab)) {
        return {
            kind: "note",
            absolutePath: resolveAbsoluteNotePathForNoteId(tab.noteId),
            noteId: tab.noteId,
            openTab: tab,
        };
    }

    if (isFileTab(tab)) {
        return {
            kind: "file",
            absolutePath: normalizeVaultPathMatch(tab.path),
            relativePath: normalizeVaultPathMatch(tab.relativePath),
            openTab: tab,
        };
    }

    return null;
}
