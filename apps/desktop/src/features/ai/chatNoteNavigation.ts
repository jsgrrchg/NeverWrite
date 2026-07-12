import { invoke } from "@neverwrite/runtime";
import {
    useEditorStore,
    isNoteTab,
    selectEditorWorkspaceTabs,
    type NoteTab,
} from "../../app/store/editorStore";
import { useVaultStore, type NoteDto } from "../../app/store/vaultStore";
import { toVaultRelativePath } from "../../app/utils/vaultPaths";
import { vaultInvoke } from "../../app/utils/vaultInvoke";

function normalizeReferencePath(value: string) {
    return value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function withoutMarkdownExtension(value: string) {
    return value.replace(/\.md$/i, "");
}

function getReferenceBasename(value: string) {
    return withoutMarkdownExtension(normalizeReferencePath(value))
        .split("/")
        .at(-1) ?? "";
}

function getCanonicalReference(value: string) {
    return withoutMarkdownExtension(normalizeReferencePath(value))
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLocaleLowerCase()
        .replace(/[\s_-]+/g, "-");
}

function getNoteReferenceValues(note: NoteDto) {
    return [note.id, note.path, note.title];
}

function getUniqueMatch(
    notes: NoteDto[],
    predicate: (note: NoteDto) => boolean,
) {
    const matches = notes.filter(predicate);
    return matches.length === 1 ? matches[0] : null;
}

// Chat output often contains a note title rather than its full relative path.
// Resolve that form deliberately, but never choose an arbitrary note when a
// basename is shared by multiple folders.
export function findChatNoteByReference(reference: string) {
    const rawReference = normalizeReferencePath(reference);
    if (!rawReference) return null;
    const canonicalReference = getCanonicalReference(rawReference);
    const canonicalBasename = getCanonicalReference(
        getReferenceBasename(rawReference),
    );
    const { notes } = useVaultStore.getState();

    return (
        getUniqueMatch(notes, (note) =>
            getNoteReferenceValues(note).some(
                (value) => normalizeReferencePath(value) === rawReference,
            ),
        ) ??
        getUniqueMatch(notes, (note) =>
            getNoteReferenceValues(note).some(
                (value) => getCanonicalReference(value) === canonicalReference,
            ),
        ) ??
        getUniqueMatch(notes, (note) =>
            getNoteReferenceValues(note).some(
                (value) =>
                    getCanonicalReference(getReferenceBasename(value)) ===
                    canonicalBasename,
            ),
        ) ??
        getUniqueMatch(notes, (note) =>
            [note.id, note.path].some((value) => {
                const canonicalPath = getCanonicalReference(value);
                return canonicalPath.endsWith(`/${canonicalReference}`);
            }),
        )
    );
}

async function readNoteContent(noteId: string) {
    const existing = selectEditorWorkspaceTabs(useEditorStore.getState()).find(
        (tab): tab is NoteTab => isNoteTab(tab) && tab.noteId === noteId,
    );
    if (existing) {
        return existing.content;
    }

    const detail = await vaultInvoke<{ content: string }>("read_note", {
        noteId,
    });
    return detail.content;
}

async function openResolvedNote(
    noteId: string,
    title: string,
    newTab: boolean,
) {
    const content = await readNoteContent(noteId);
    const editor = useEditorStore.getState();

    if (newTab) {
        editor.insertExternalTab({
            id: crypto.randomUUID(),
            noteId,
            title,
            content,
        });
        return true;
    }

    editor.openNote(noteId, title, content);
    return true;
}

export async function openChatResolvedNote(
    noteId: string,
    title: string,
    options?: { newTab?: boolean },
) {
    try {
        return await openResolvedNote(noteId, title, !!options?.newTab);
    } catch (error) {
        console.error("Error opening chat note:", error);
        return false;
    }
}

export async function openChatNoteById(
    noteId: string,
    options?: { newTab?: boolean },
) {
    const note = useVaultStore
        .getState()
        .notes.find((entry) => entry.id === noteId);
    if (!note) return false;

    return openChatResolvedNote(note.id, note.title, options);
}

export async function openChatNoteByReference(
    reference: string,
    options?: { newTab?: boolean },
) {
    const note = findChatNoteByReference(reference);
    if (!note) return false;

    return openChatResolvedNote(note.id, note.title, options);
}

export async function openChatNoteByAbsolutePath(
    absPath: string,
    options?: { newTab?: boolean },
) {
    const note = useVaultStore
        .getState()
        .notes.find((entry) => entry.path === absPath);
    if (!note) return false;

    return openChatResolvedNote(note.id, note.title, options);
}

interface MapEntry {
    id: string;
    title: string;
    relative_path: string;
}

export async function openChatMapByReference(reference: string) {
    const vaultPath = useVaultStore.getState().vaultPath;
    if (!vaultPath) return false;

    try {
        const maps = await invoke<MapEntry[]>("list_maps", { vaultPath });
        const legacyRelativePath = toVaultRelativePath(reference, vaultPath);
        const normalized = reference
            .toLowerCase()
            .replace(/\.excalidraw$/i, "");
        const map =
            maps.find((m) => m.relative_path === reference) ??
            (legacyRelativePath
                ? maps.find((m) => m.relative_path === legacyRelativePath)
                : undefined) ??
            maps.find(
                (m) =>
                    m.title.toLowerCase() === normalized ||
                    m.id.toLowerCase() === normalized,
            ) ??
            maps.find(
                (m) =>
                    m.relative_path
                        .toLowerCase()
                        .endsWith(reference.toLowerCase()) ||
                    m.title.toLowerCase().includes(normalized),
            );
        if (!map) return false;

        useEditorStore.getState().openMap(map.relative_path, map.title);
        return true;
    } catch (error) {
        console.error("Error opening chat map:", error);
        return false;
    }
}
