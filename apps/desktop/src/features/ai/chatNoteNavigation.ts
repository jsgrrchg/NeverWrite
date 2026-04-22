import { invoke } from "@neverwrite/runtime";
import {
    useEditorStore,
    isNoteTab,
    selectEditorWorkspaceTabs,
    type NoteTab,
} from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { toVaultRelativePath } from "../../app/utils/vaultPaths";
import { vaultInvoke } from "../../app/utils/vaultInvoke";

function findNoteByReference(reference: string) {
    const trimmed = reference.trim();
    if (!trimmed) return null;

    const normalized = trimmed.toLowerCase();
    const slug = normalized.replace(/ /g, "-");
    const { notes } = useVaultStore.getState();

    return (
        notes.find(
            (note) =>
                note.id === trimmed ||
                note.path === trimmed ||
                note.title === trimmed,
        ) ??
        notes.find(
            (note) =>
                note.id.toLowerCase() === normalized ||
                note.path.toLowerCase() === normalized ||
                note.title.toLowerCase() === normalized,
        ) ??
        notes.find((note) => {
            const noteId = note.id.toLowerCase();
            const notePath = note.path.toLowerCase();
            return (
                noteId.endsWith(normalized) ||
                noteId.endsWith(slug) ||
                notePath.endsWith(normalized) ||
                notePath.endsWith(`${slug}.md`)
            );
        }) ??
        null
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
    const note = findNoteByReference(reference);
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
