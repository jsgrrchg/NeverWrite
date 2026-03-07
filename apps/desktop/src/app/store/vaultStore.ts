import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface NoteDto {
    id: string;
    path: string;
    title: string;
    modified_at: number;
    created_at: number;
}

export interface RecentVault {
    path: string;
    name: string;
}

const LAST_VAULT_KEY = "vaultai:lastVaultPath";
const RECENT_VAULTS_KEY = "vaultai:recentVaults";

export function getRecentVaults(): RecentVault[] {
    try {
        return JSON.parse(localStorage.getItem(RECENT_VAULTS_KEY) ?? "[]");
    } catch {
        return [];
    }
}

function addToRecentVaults(path: string) {
    const name = path.split("/").pop() ?? path;
    const prev = getRecentVaults().filter((v) => v.path !== path);
    localStorage.setItem(
        RECENT_VAULTS_KEY,
        JSON.stringify([{ path, name }, ...prev].slice(0, 10)),
    );
}

interface VaultStore {
    vaultPath: string | null;
    notes: NoteDto[];
    isLoading: boolean;
    error: string | null;
    openVault: (path: string) => Promise<void>;
    restoreVault: () => Promise<void>;
    createNote: (name: string) => Promise<NoteDto | null>;
    deleteNote: (noteId: string) => Promise<void>;
    renameNote: (noteId: string, newName: string) => Promise<NoteDto | null>;
    updateNoteMetadata: (
        noteId: string,
        patch: Partial<Pick<NoteDto, "title" | "path" | "modified_at" | "created_at">>,
    ) => void;
}

export const useVaultStore = create<VaultStore>((set, get) => ({
    vaultPath: null,
    notes: [],
    isLoading: false,
    error: null,

    openVault: async (path) => {
        set({ isLoading: true, error: null });
        try {
            const notes = await invoke<NoteDto[]>("open_vault", { path });
            localStorage.setItem(LAST_VAULT_KEY, path);
            addToRecentVaults(path);
            set({ vaultPath: path, notes, isLoading: false });
        } catch (e) {
            set({ error: String(e), isLoading: false });
        }
    },

    restoreVault: async () => {
        const path = localStorage.getItem(LAST_VAULT_KEY);
        if (path) await get().openVault(path);
    },

    createNote: async (name) => {
        const path = name.endsWith(".md") ? name : `${name}.md`;
        try {
            const detail = await invoke<{
                id: string;
                path: string;
                title: string;
            }>("create_note", { path, content: "" });
            const now = Math.floor(Date.now() / 1000);
            const note: NoteDto = {
                id: detail.id,
                path: detail.path,
                title: detail.title,
                modified_at: now,
                created_at: now,
            };
            set((s) => ({ notes: [...s.notes, note] }));
            return note;
        } catch (e) {
            console.error("Error al crear nota:", e);
            return null;
        }
    },

    deleteNote: async (noteId) => {
        try {
            await invoke("delete_note", { noteId });
            set((s) => ({ notes: s.notes.filter((n) => n.id !== noteId) }));
        } catch (e) {
            console.error("Error al eliminar nota:", e);
        }
    },

    renameNote: async (noteId, newName) => {
        const newPath = newName.endsWith(".md") ? newName : `${newName}.md`;
        try {
            const detail = await invoke<{
                id: string;
                path: string;
                title: string;
            }>("rename_note", { noteId, newPath });
            const existing = get().notes.find((n) => n.id === noteId);
            const updated: NoteDto = {
                id: detail.id,
                path: detail.path,
                title: detail.title,
                modified_at: Math.floor(Date.now() / 1000),
                created_at:
                    existing?.created_at ?? Math.floor(Date.now() / 1000),
            };
            set((s) => ({
                notes: s.notes.map((n) => (n.id === noteId ? updated : n)),
            }));
            return updated;
        } catch (e) {
            console.error("Error al renombrar nota:", e);
            return null;
        }
    },

    updateNoteMetadata: (noteId, patch) => {
        set((s) => ({
            notes: s.notes.map((n) =>
                n.id === noteId ? { ...n, ...patch } : n,
            ),
        }));
    },
}));
