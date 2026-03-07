import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface NoteDto {
    id: string;
    path: string;
    title: string;
}

const LAST_VAULT_KEY = "vaultai:lastVaultPath";

interface VaultStore {
    vaultPath: string | null;
    notes: NoteDto[];
    isLoading: boolean;
    error: string | null;
    openVault: (path: string) => Promise<void>;
    restoreVault: () => Promise<void>;
    createNote: (name: string) => Promise<NoteDto | null>;
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
            const note: NoteDto = {
                id: detail.id,
                path: detail.path,
                title: detail.title,
            };
            set((s) => ({ notes: [...s.notes, note] }));
            return note;
        } catch (e) {
            console.error("Error al crear nota:", e);
            return null;
        }
    },
}));
