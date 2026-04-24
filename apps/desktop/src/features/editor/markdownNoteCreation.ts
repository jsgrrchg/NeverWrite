import {
    selectFocusedPaneId,
    useEditorStore,
} from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";

const UNTITLED_NOTE_BASENAME = "Untitled";
const MAX_UNTITLED_NOTE_ATTEMPTS = 100;

function normalizeVaultPath(path: string) {
    return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function stripMarkdownExtension(path: string) {
    return path.toLowerCase().endsWith(".md") ? path.slice(0, -3) : path;
}

function getUntitledNoteCandidate(index: number) {
    return index === 0
        ? UNTITLED_NOTE_BASENAME
        : `${UNTITLED_NOTE_BASENAME} ${index}`;
}

function collectOccupiedNoteIds() {
    const { entries, notes } = useVaultStore.getState();
    const occupied = new Set<string>();

    for (const note of notes) {
        occupied.add(stripMarkdownExtension(normalizeVaultPath(note.id)));
    }

    for (const entry of entries) {
        const relativePath = entry.relative_path || entry.id;
        if (!relativePath) continue;
        occupied.add(stripMarkdownExtension(normalizeVaultPath(relativePath)));
    }

    return occupied;
}

export async function createUntitledMarkdownNote() {
    const vault = useVaultStore.getState();
    if (!vault.vaultPath) return null;

    const occupied = collectOccupiedNoteIds();

    for (let index = 0; index < MAX_UNTITLED_NOTE_ATTEMPTS; index += 1) {
        const name = getUntitledNoteCandidate(index);
        if (occupied.has(name)) continue;

        const note = await useVaultStore.getState().createNote(`${name}.md`);
        if (note) return note;

        occupied.add(name);
    }

    console.error("Failed to create an available untitled markdown note.");
    return null;
}

export async function openUntitledMarkdownNote(paneId?: string) {
    const note = await createUntitledMarkdownNote();
    if (!note) return null;

    const editor = useEditorStore.getState();
    const targetPaneId = paneId ?? selectFocusedPaneId(editor);
    if (targetPaneId) {
        editor.insertExternalTabInPane(
            {
                id: crypto.randomUUID(),
                kind: "note",
                noteId: note.id,
                title: note.title,
                content: "",
            },
            targetPaneId,
        );
        return note;
    }

    editor.openNote(note.id, note.title, "");
    return note;
}
