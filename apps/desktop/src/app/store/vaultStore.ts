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

export interface VaultOpenMetrics {
    scan_ms: number;
    snapshot_load_ms: number;
    parse_ms: number;
    index_ms: number;
    snapshot_save_ms: number;
}

export type VaultOpenStage =
    | "idle"
    | "scanning"
    | "parsing"
    | "indexing"
    | "saving_snapshot"
    | "ready"
    | "error"
    | "cancelled";

export interface VaultOpenState {
    path: string | null;
    stage: VaultOpenStage;
    message: string;
    processed: number;
    total: number;
    note_count: number;
    snapshot_used: boolean;
    cancelled: boolean;
    started_at_ms: number | null;
    finished_at_ms: number | null;
    metrics: VaultOpenMetrics;
    error: string | null;
}

export interface VaultNoteChange {
    kind: "upsert" | "delete";
    note: NoteDto | null;
    note_id: string | null;
}

const LAST_VAULT_KEY = "vaultai:lastVaultPath";
const RECENT_VAULTS_KEY = "vaultai:recentVaults";
const OPEN_STATE_POLL_MS = 120;

const IDLE_OPEN_STATE: VaultOpenState = {
    path: null,
    stage: "idle",
    message: "",
    processed: 0,
    total: 0,
    note_count: 0,
    snapshot_used: false,
    cancelled: false,
    started_at_ms: null,
    finished_at_ms: null,
    metrics: {
        scan_ms: 0,
        snapshot_load_ms: 0,
        parse_ms: 0,
        index_ms: 0,
        snapshot_save_ms: 0,
    },
    error: null,
};

let openVaultSequence = 0;

function wait(ms: number) {
    return new Promise<void>((resolve) => {
        window.setTimeout(resolve, ms);
    });
}

function normalizeOpenState(
    state: Partial<VaultOpenState> | null | undefined,
): VaultOpenState {
    return {
        path: state?.path ?? null,
        stage: (state?.stage as VaultOpenStage | undefined) ?? "idle",
        message: state?.message ?? "",
        processed: state?.processed ?? 0,
        total: state?.total ?? 0,
        note_count: state?.note_count ?? 0,
        snapshot_used: state?.snapshot_used ?? false,
        cancelled: state?.cancelled ?? false,
        started_at_ms: state?.started_at_ms ?? null,
        finished_at_ms: state?.finished_at_ms ?? null,
        metrics: {
            scan_ms: state?.metrics?.scan_ms ?? 0,
            snapshot_load_ms: state?.metrics?.snapshot_load_ms ?? 0,
            parse_ms: state?.metrics?.parse_ms ?? 0,
            index_ms: state?.metrics?.index_ms ?? 0,
            snapshot_save_ms: state?.metrics?.snapshot_save_ms ?? 0,
        },
        error: state?.error ?? null,
    };
}

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

function updateNotesWithChange(notes: NoteDto[], change: VaultNoteChange) {
    if (change.kind === "delete") {
        return notes.filter((note) => note.id !== change.note_id);
    }

    if (!change.note) return notes;

    const existingIndex = notes.findIndex((note) => note.id === change.note!.id);
    if (existingIndex === -1) {
        return [...notes, change.note];
    }

    return notes.map((note, index) =>
        index === existingIndex ? change.note! : note,
    );
}

interface VaultStore {
    vaultPath: string | null;
    notes: NoteDto[];
    vaultRevision: number;
    isLoading: boolean;
    vaultOpenState: VaultOpenState;
    error: string | null;
    openVault: (path: string) => Promise<void>;
    restoreVault: () => Promise<void>;
    cancelOpenVault: () => Promise<void>;
    applyVaultNoteChange: (change: VaultNoteChange) => void;
    createNote: (name: string) => Promise<NoteDto | null>;
    deleteNote: (noteId: string) => Promise<void>;
    renameNote: (noteId: string, newName: string) => Promise<NoteDto | null>;
    touchVault: () => void;
    updateNoteMetadata: (
        noteId: string,
        patch: Partial<Pick<NoteDto, "title" | "path" | "modified_at" | "created_at">>,
    ) => void;
}

export const useVaultStore = create<VaultStore>((set, get) => ({
    vaultPath: null,
    notes: [],
    vaultRevision: 0,
    isLoading: false,
    vaultOpenState: IDLE_OPEN_STATE,
    error: null,

    openVault: async (path) => {
        const sequence = ++openVaultSequence;

        set({
            isLoading: true,
            error: null,
            vaultOpenState: {
                ...IDLE_OPEN_STATE,
                path,
                stage: "scanning",
                message: "Preparing vault...",
            },
        });

        try {
            await invoke("start_open_vault", { path });

            while (sequence === openVaultSequence) {
                const openState = normalizeOpenState(
                    await invoke<VaultOpenState>("get_vault_open_state"),
                );

                set({
                    isLoading:
                        openState.stage !== "ready" &&
                        openState.stage !== "error" &&
                        openState.stage !== "cancelled",
                    vaultOpenState: openState,
                    error: openState.stage === "error" ? openState.error : null,
                });

                if (openState.stage === "ready") {
                    const notes = await invoke<NoteDto[]>("list_notes");
                    if (sequence !== openVaultSequence) return;

                    localStorage.setItem(LAST_VAULT_KEY, path);
                    addToRecentVaults(path);

                    set((state) => ({
                        vaultPath: path,
                        notes,
                        isLoading: false,
                        error: null,
                        vaultOpenState: openState,
                        vaultRevision: state.vaultRevision + 1,
                    }));
                    return;
                }

                if (openState.stage === "error") {
                    set({
                        isLoading: false,
                        error: openState.error ?? "Failed to open vault",
                        vaultOpenState: openState,
                    });
                    return;
                }

                if (openState.stage === "cancelled") {
                    set({
                        isLoading: false,
                        error: null,
                        vaultOpenState: openState,
                    });
                    return;
                }

                await wait(OPEN_STATE_POLL_MS);
            }
        } catch (error) {
            if (sequence !== openVaultSequence) return;
            set({
                isLoading: false,
                error: String(error),
                vaultOpenState: {
                    ...IDLE_OPEN_STATE,
                    path,
                    stage: "error",
                    message: "Failed to open vault",
                    error: String(error),
                },
            });
        }
    },

    restoreVault: async () => {
        const path = localStorage.getItem(LAST_VAULT_KEY);
        if (path) await get().openVault(path);
    },

    cancelOpenVault: async () => {
        try {
            await invoke("cancel_open_vault");
        } finally {
            set((state) => ({
                isLoading: false,
                vaultOpenState: {
                    ...state.vaultOpenState,
                    stage: "cancelled",
                    cancelled: true,
                    message: "Opening cancelled",
                    finished_at_ms: Date.now(),
                },
            }));
        }
    },

    applyVaultNoteChange: (change) => {
        set((state) => ({
            notes: updateNotesWithChange(state.notes, change),
            vaultRevision: state.vaultRevision + 1,
        }));
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
            set((s) => ({
                notes: [...s.notes, note],
                vaultRevision: s.vaultRevision + 1,
            }));
            return note;
        } catch (e) {
            console.error("Error al crear nota:", e);
            return null;
        }
    },

    deleteNote: async (noteId) => {
        try {
            await invoke("delete_note", { noteId });
            set((s) => ({
                notes: s.notes.filter((n) => n.id !== noteId),
                vaultRevision: s.vaultRevision + 1,
            }));
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
                vaultRevision: s.vaultRevision + 1,
            }));
            return updated;
        } catch (e) {
            console.error("Error al renombrar nota:", e);
            return null;
        }
    },

    touchVault: () =>
        set((state) => ({ vaultRevision: state.vaultRevision + 1 })),

    updateNoteMetadata: (noteId, patch) => {
        set((s) => ({
            notes: s.notes.map((n) =>
                n.id === noteId ? { ...n, ...patch } : n,
            ),
        }));
    },
}));
