import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { perfCount, perfMeasure, perfNow } from "../utils/perfInstrumentation";
import { getPathBaseName } from "../utils/path";
import { useEditorStore } from "./editorStore";
import { useBookmarkStore } from "./bookmarkStore";

export interface NoteDto {
    id: string;
    path: string;
    title: string;
    modified_at: number;
    created_at: number;
}

export interface VaultEntryDto {
    id: string;
    path: string;
    relative_path: string;
    title: string;
    file_name: string;
    extension: string;
    kind: "note" | "pdf" | "file" | "folder";
    modified_at: number;
    created_at: number;
    size: number;
    mime_type: string | null;
}

export interface RecentVault {
    path: string;
    name: string;
    pinned?: boolean;
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

export type VaultChangeOrigin =
    | "user"
    | "agent"
    | "external"
    | "system"
    | "unknown";

export interface VaultNoteChange {
    vault_path: string;
    kind: "upsert" | "delete";
    note: NoteDto | null;
    note_id: string | null;
    entry: VaultEntryDto | null;
    relative_path: string | null;
    origin: VaultChangeOrigin;
    op_id: string | null;
    revision: number;
    content_hash: string | null;
    graph_revision: number;
}

function didResolverStructureChange(
    previousNotes: NoteDto[],
    change: VaultNoteChange,
) {
    if (change.kind === "delete") return true;
    if (!change.note) return false;

    const previous = previousNotes.find((note) => note.id === change.note!.id);
    if (!previous) return true;

    return (
        previous.id !== change.note.id ||
        previous.path !== change.note.path ||
        previous.title !== change.note.title
    );
}

function didStructureMetadataChange(
    previousNotes: NoteDto[],
    noteId: string,
    patch: Partial<Pick<NoteDto, "title" | "path">>,
) {
    const previous = previousNotes.find((note) => note.id === noteId);
    if (!previous) return false;

    return (
        (patch.title !== undefined && patch.title !== previous.title) ||
        (patch.path !== undefined && patch.path !== previous.path)
    );
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

export function togglePinVault(path: string) {
    const vaults = getRecentVaults();
    const updated = vaults.map((v) =>
        v.path === path ? { ...v, pinned: !v.pinned } : v,
    );
    localStorage.setItem(RECENT_VAULTS_KEY, JSON.stringify(updated));
}

export async function removeVaultFromList(path: string) {
    // Remove from recent vaults
    const updated = getRecentVaults().filter((v) => v.path !== path);
    localStorage.setItem(RECENT_VAULTS_KEY, JSON.stringify(updated));

    // Clear last vault if it matches
    if (localStorage.getItem(LAST_VAULT_KEY) === path) {
        localStorage.removeItem(LAST_VAULT_KEY);
    }

    // Clear all per-vault localStorage data
    localStorage.removeItem(`vaultai.session.tabs:${path}`);
    localStorage.removeItem(`vaultai:theme:${path}`);
    localStorage.removeItem(`vaultai:settings:${path}`);
    localStorage.removeItem(`vaultai.chat.tabs:${path}`);
    localStorage.removeItem(`vaultai:bookmarks:${path}`);

    // Delete vault index snapshot from disk
    try {
        await invoke("delete_vault_snapshot", { vaultPath: path });
    } catch {
        // Snapshot may not exist — that's fine
    }

    // Delete AI session histories from disk
    try {
        await invoke("ai_delete_all_session_histories", { vaultPath: path });
    } catch {
        // No histories — that's fine
    }
}

function addToRecentVaults(path: string) {
    const name = getPathBaseName(path);
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

    const existingIndex = notes.findIndex(
        (note) => note.id === change.note!.id,
    );
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
    entries: VaultEntryDto[];
    vaultRevision: number;
    contentRevision: number;
    structureRevision: number;
    resolverRevision: number;
    graphRevision: number;
    tagsRevision: number;
    isLoading: boolean;
    vaultOpenState: VaultOpenState;
    error: string | null;
    openVault: (path: string) => Promise<void>;
    restoreVault: () => Promise<void>;
    cancelOpenVault: () => Promise<void>;
    refreshEntries: () => Promise<void>;
    refreshStructure: () => Promise<void>;
    applyVaultNoteChange: (change: VaultNoteChange) => void;
    createNote: (name: string) => Promise<NoteDto | null>;
    createFolder: (path: string) => Promise<VaultEntryDto | null>;
    deleteFolder: (relativePath: string) => Promise<void>;
    deleteNote: (noteId: string) => Promise<void>;
    renameNote: (noteId: string, newName: string) => Promise<NoteDto | null>;
    touchContent: () => void;
    updateNoteMetadata: (
        noteId: string,
        patch: Partial<
            Pick<NoteDto, "title" | "path" | "modified_at" | "created_at">
        >,
    ) => void;
}

export const useVaultStore = create<VaultStore>((set, get) => ({
    vaultPath: null,
    notes: [],
    entries: [],
    vaultRevision: 0,
    contentRevision: 0,
    structureRevision: 0,
    resolverRevision: 0,
    graphRevision: 0,
    tagsRevision: 0,
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
                    await invoke<VaultOpenState>("get_vault_open_state", {
                        vaultPath: path,
                    }),
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
                    const [notes, entries, graphRevision] = await Promise.all([
                        invoke<NoteDto[]>("list_notes", { vaultPath: path }),
                        invoke<VaultEntryDto[]>("list_vault_entries", {
                            vaultPath: path,
                        }),
                        invoke<number>("get_graph_revision", {
                            vaultPath: path,
                        }),
                    ]);
                    if (sequence !== openVaultSequence) return;

                    localStorage.setItem(LAST_VAULT_KEY, path);
                    addToRecentVaults(path);

                    set((state) => ({
                        vaultPath: path,
                        notes,
                        entries,
                        isLoading: false,
                        error: null,
                        vaultOpenState: openState,
                        vaultRevision: state.vaultRevision + 1,
                        contentRevision: state.contentRevision + 1,
                        structureRevision: state.structureRevision + 1,
                        resolverRevision: state.resolverRevision + 1,
                        graphRevision,
                        tagsRevision: state.tagsRevision + 1,
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
            const vaultPath =
                get().vaultOpenState.path ?? get().vaultPath ?? "";
            await invoke("cancel_open_vault", { vaultPath });
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

    refreshEntries: async () => {
        const vaultPath = get().vaultPath;
        if (!vaultPath) return;

        try {
            const nextEntries = await invoke<VaultEntryDto[]>(
                "list_vault_entries",
                {
                    vaultPath,
                },
            );
            set((state) => ({
                entries: Array.isArray(nextEntries)
                    ? nextEntries
                    : state.entries,
                vaultRevision: state.vaultRevision + 1,
                structureRevision: state.structureRevision + 1,
            }));
        } catch (error) {
            console.error("Error refreshing vault entries:", error);
        }
    },

    refreshStructure: async () => {
        const vaultPath = get().vaultPath;
        if (!vaultPath) return;

        try {
            const [nextNotes, nextEntries, graphRevision] = await Promise.all([
                invoke<NoteDto[]>("list_notes", { vaultPath }),
                invoke<VaultEntryDto[]>("list_vault_entries", { vaultPath }),
                invoke<number>("get_graph_revision", { vaultPath }),
            ]);
            set((state) => ({
                notes: Array.isArray(nextNotes) ? nextNotes : state.notes,
                entries: Array.isArray(nextEntries)
                    ? nextEntries
                    : state.entries,
                vaultRevision: state.vaultRevision + 1,
                contentRevision: state.contentRevision + 1,
                structureRevision: state.structureRevision + 1,
                resolverRevision: state.resolverRevision + 1,
                graphRevision,
                tagsRevision: state.tagsRevision + 1,
            }));
        } catch (error) {
            console.error("Error refreshing vault structure:", error);
        }
    },

    applyVaultNoteChange: (change) => {
        set((state) => {
            const startMs = perfNow();
            const nextNotes = updateNotesWithChange(state.notes, change);
            const structureChanged = didResolverStructureChange(
                state.notes,
                change,
            );
            perfCount(`vault.applyNoteChange.${change.kind}`);
            perfMeasure(
                `vault.applyNoteChange.${change.kind}.duration`,
                startMs,
                {
                    beforeCount: state.notes.length,
                    afterCount: nextNotes.length,
                    changedNotePresent: change.note ? 1 : 0,
                    structureChanged: structureChanged ? 1 : 0,
                },
            );

            return {
                notes: nextNotes,
                vaultRevision: state.vaultRevision + 1,
                contentRevision:
                    change.kind === "upsert"
                        ? state.contentRevision + 1
                        : state.contentRevision,
                structureRevision: structureChanged
                    ? state.structureRevision + 1
                    : state.structureRevision,
                resolverRevision: structureChanged
                    ? state.resolverRevision + 1
                    : state.resolverRevision,
                graphRevision:
                    change.graph_revision > 0
                        ? change.graph_revision
                        : state.graphRevision +
                          (change.kind === "upsert" || change.kind === "delete"
                              ? 1
                              : 0),
                tagsRevision:
                    change.kind === "upsert" || change.kind === "delete"
                        ? state.tagsRevision + 1
                        : state.tagsRevision,
            };
        });
    },

    createNote: async (name) => {
        const path = name.endsWith(".md") ? name : `${name}.md`;
        try {
            const vaultPath = get().vaultPath ?? "";
            const detail = await invoke<{
                id: string;
                path: string;
                title: string;
            }>("create_note", { vaultPath, path, content: "" });
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
                structureRevision: s.structureRevision + 1,
                resolverRevision: s.resolverRevision + 1,
                graphRevision: s.graphRevision + 1,
                tagsRevision: s.tagsRevision + 1,
            }));
            return note;
        } catch (e) {
            console.error("Error al crear nota:", e);
            return null;
        }
    },

    createFolder: async (path) => {
        try {
            const vaultPath = get().vaultPath ?? "";
            const entry = await invoke<VaultEntryDto>("create_folder", {
                vaultPath,
                path,
            });
            set((state) => ({
                entries: [...state.entries, entry],
                vaultRevision: state.vaultRevision + 1,
                structureRevision: state.structureRevision + 1,
            }));
            return entry;
        } catch (e) {
            console.error("Error al crear carpeta:", e);
            return null;
        }
    },

    deleteFolder: async (relativePath) => {
        try {
            const vaultPath = get().vaultPath ?? "";
            const folderPrefix = relativePath + "/";
            const deletedNoteIds = get()
                .notes.filter(
                    (n) =>
                        n.id === relativePath || n.id.startsWith(folderPrefix),
                )
                .map((n) => n.id);
            await invoke("delete_folder", { vaultPath, relativePath });
            set((s) => ({
                notes: s.notes.filter(
                    (n) =>
                        n.id !== relativePath && !n.id.startsWith(folderPrefix),
                ),
                entries: s.entries.filter(
                    (e) =>
                        e.relative_path !== relativePath &&
                        !e.relative_path.startsWith(folderPrefix),
                ),
                vaultRevision: s.vaultRevision + 1,
                structureRevision: s.structureRevision + 1,
                resolverRevision: s.resolverRevision + 1,
                graphRevision: s.graphRevision + 1,
                tagsRevision: s.tagsRevision + 1,
            }));
            const editor = useEditorStore.getState();
            const bookmarks = useBookmarkStore.getState();
            for (const noteId of deletedNoteIds) {
                editor.handleNoteDeleted(noteId);
                bookmarks.handleNoteDeleted(noteId);
            }
        } catch (e) {
            console.error("Error al eliminar carpeta:", e);
            throw e;
        }
    },

    deleteNote: async (noteId) => {
        try {
            const vaultPath = get().vaultPath ?? "";
            await invoke("delete_note", { vaultPath, noteId });
            set((s) => ({
                notes: s.notes.filter((n) => n.id !== noteId),
                vaultRevision: s.vaultRevision + 1,
                structureRevision: s.structureRevision + 1,
                resolverRevision: s.resolverRevision + 1,
                graphRevision: s.graphRevision + 1,
                tagsRevision: s.tagsRevision + 1,
            }));
            useEditorStore.getState().handleNoteDeleted(noteId);
            useBookmarkStore.getState().handleNoteDeleted(noteId);
        } catch (e) {
            console.error("Error al eliminar nota:", e);
        }
    },

    renameNote: async (noteId, newName) => {
        const newPath = newName.endsWith(".md") ? newName : `${newName}.md`;
        try {
            const vaultPath = get().vaultPath ?? "";
            const detail = await invoke<{
                id: string;
                path: string;
                title: string;
            }>("rename_note", { vaultPath, noteId, newPath });
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
                structureRevision: s.structureRevision + 1,
                resolverRevision: s.resolverRevision + 1,
                graphRevision: s.graphRevision + 1,
            }));
            useEditorStore
                .getState()
                .handleNoteRenamed(noteId, updated.id, updated.title);
            useBookmarkStore.getState().handleNoteRenamed(noteId, updated.id);
            return updated;
        } catch (e) {
            console.error("Error al renombrar nota:", e);
            return null;
        }
    },

    touchContent: () =>
        set((state) => ({
            contentRevision: state.contentRevision + 1,
        })),

    updateNoteMetadata: (noteId, patch) => {
        set((s) => {
            const structureChanged = didStructureMetadataChange(
                s.notes,
                noteId,
                patch,
            );

            return {
                notes: s.notes.map((n) =>
                    n.id === noteId ? { ...n, ...patch } : n,
                ),
                structureRevision: structureChanged
                    ? s.structureRevision + 1
                    : s.structureRevision,
                resolverRevision: structureChanged
                    ? s.resolverRevision + 1
                    : s.resolverRevision,
                graphRevision: structureChanged
                    ? s.graphRevision + 1
                    : s.graphRevision,
            };
        });
    },
}));
