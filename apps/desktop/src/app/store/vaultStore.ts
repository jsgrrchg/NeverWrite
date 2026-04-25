import { create } from "zustand";
import { invoke } from "@neverwrite/runtime";
import { perfCount, perfMeasure, perfNow } from "../utils/perfInstrumentation";
import { getPathBaseName } from "../utils/path";
import {
    safeStorageGetItem,
    safeStorageRemoveItem,
    safeStorageSetItem,
} from "../utils/safeStorage";
import { logError, logWarn } from "../utils/runtimeLog";
import {
    isFileTab,
    isNoteTab,
    isPdfTab,
    useEditorStore,
} from "./editorStore";
import { useBookmarkStore } from "./bookmarkStore";
import { inferFileViewer } from "./editorTabs";

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
    is_text_like?: boolean | null;
    is_image_like?: boolean | null;
    open_in_app?: boolean | null;
    viewer_kind?: string | null;
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

function hasMarkdownExtension(path: string) {
    return path.toLowerCase().endsWith(".md");
}

const LAST_VAULT_KEY = "neverwrite:lastVaultPath";
const RECENT_VAULTS_KEY = "neverwrite:recentVaults";
const MAX_RECENT_VAULTS = 100;
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

function movePathPrefix(
    path: string,
    sourcePrefix: string,
    targetPrefix: string,
) {
    if (path === sourcePrefix) return targetPrefix;
    if (!path.startsWith(`${sourcePrefix}/`)) return path;
    return `${targetPrefix}/${path.slice(sourcePrefix.length + 1)}`;
}

function moveNoteFolderPath(
    note: NoteDto,
    oldRelativePath: string,
    newRelativePath: string,
    vaultPath: string,
): NoteDto {
    const oldAbsolutePath = `${vaultPath}/${oldRelativePath}`;
    const newAbsolutePath = `${vaultPath}/${newRelativePath}`;

    return {
        ...note,
        id: movePathPrefix(note.id, oldRelativePath, newRelativePath),
        path: movePathPrefix(note.path, oldAbsolutePath, newAbsolutePath),
    };
}

function moveEntryFolderPath(
    entry: VaultEntryDto,
    oldRelativePath: string,
    newRelativePath: string,
    vaultPath: string,
): VaultEntryDto {
    const oldAbsolutePath = `${vaultPath}/${oldRelativePath}`;
    const newAbsolutePath = `${vaultPath}/${newRelativePath}`;
    const relativePath = movePathPrefix(
        entry.relative_path,
        oldRelativePath,
        newRelativePath,
    );
    const path = movePathPrefix(entry.path, oldAbsolutePath, newAbsolutePath);
    const movedFolderItself =
        entry.kind === "folder" && entry.relative_path === oldRelativePath;
    const fileName = movedFolderItself
        ? getPathBaseName(relativePath)
        : entry.file_name;

    return {
        ...entry,
        id: movePathPrefix(entry.id, oldRelativePath, newRelativePath),
        path,
        relative_path: relativePath,
        title: movedFolderItself ? fileName : entry.title,
        file_name: fileName,
    };
}

async function loadVaultEntriesSnapshot(vaultPath: string) {
    try {
        const entries = await invoke<VaultEntryDto[]>("list_vault_entries", {
            vaultPath,
        });
        return normalizeVaultEntries(entries);
    } catch (error) {
        logError("vault-store", "Failed to load vault entries snapshot", error);
        return null;
    }
}

function normalizeVaultRelativePath(path: string) {
    return path.replace(/\\/g, "/");
}

function normalizeNote(note: NoteDto): NoteDto {
    return {
        ...note,
        id: normalizeVaultRelativePath(note.id),
    };
}

function normalizeVaultEntry(entry: VaultEntryDto): VaultEntryDto {
    return {
        ...entry,
        id: normalizeVaultRelativePath(entry.id),
        relative_path: normalizeVaultRelativePath(entry.relative_path),
    };
}

function normalizeVaultNotes(notes: NoteDto[]) {
    return notes.map(normalizeNote);
}

function normalizeVaultEntries(entries: VaultEntryDto[]) {
    return entries.map(normalizeVaultEntry);
}

function normalizeVaultNoteChange(change: VaultNoteChange): VaultNoteChange {
    return {
        ...change,
        note: change.note ? normalizeNote(change.note) : change.note,
        note_id: change.note_id
            ? normalizeVaultRelativePath(change.note_id)
            : change.note_id,
        entry: change.entry ? normalizeVaultEntry(change.entry) : change.entry,
        relative_path: change.relative_path
            ? normalizeVaultRelativePath(change.relative_path)
            : change.relative_path,
    };
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
        return JSON.parse(safeStorageGetItem(RECENT_VAULTS_KEY) ?? "[]");
    } catch {
        return [];
    }
}

function syncRecentVaultsToNative(vaults: RecentVault[]) {
    const top15 = vaults.slice(0, 15).map(({ path, name }) => ({
        path,
        name,
    }));

    void invoke("sync_recent_vaults", { vaults: top15 }).catch((error) => {
        logWarn("vault-store", "Failed to sync recent vaults", error, {
            onceKey: "sync-recent-vaults",
        });
    });
}

function writeRecentVaults(vaults: RecentVault[]) {
    safeStorageSetItem(RECENT_VAULTS_KEY, JSON.stringify(vaults));
    syncRecentVaultsToNative(vaults);
}

export function togglePinVault(path: string) {
    const vaults = getRecentVaults();
    const updated = vaults.map((v) =>
        v.path === path ? { ...v, pinned: !v.pinned } : v,
    );
    writeRecentVaults(updated);
}

export async function removeVaultFromList(path: string) {
    // Remove from recent vaults
    const updated = getRecentVaults().filter((v) => v.path !== path);
    writeRecentVaults(updated);

    // Clear last vault if it matches
    if (safeStorageGetItem(LAST_VAULT_KEY) === path) {
        safeStorageRemoveItem(LAST_VAULT_KEY);
    }

    // Clear all per-vault localStorage data
    safeStorageRemoveItem(`neverwrite.session.tabs:${path}`);
    safeStorageRemoveItem(`neverwrite:theme:${path}`);
    safeStorageRemoveItem(`neverwrite:settings:${path}`);
    safeStorageRemoveItem(`neverwrite.chat.tabs:${path}`);
    safeStorageRemoveItem(`neverwrite:bookmarks:${path}`);

    // Delete vault index snapshot from disk
    try {
        await invoke("delete_vault_snapshot", { vaultPath: path });
    } catch {
        // Snapshot may not exist — that's fine
    }

    // Delete AI session histories from disk
    if (useVaultStore.getState().vaultPath === path) {
        try {
            await invoke("ai_delete_all_session_histories", {
                vaultPath: path,
            });
        } catch {
            // No histories or vault not open — that's fine
        }
    }
}

export function clearRecentVaults() {
    safeStorageRemoveItem(RECENT_VAULTS_KEY);
    syncRecentVaultsToNative([]);
}

function addToRecentVaults(path: string) {
    const name = getPathBaseName(path);
    const prev = getRecentVaults().filter((v) => v.path !== path);
    writeRecentVaults([{ path, name }, ...prev].slice(0, MAX_RECENT_VAULTS));
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
    renameFolder: (
        relativePath: string,
        newRelativePath: string,
    ) => Promise<boolean>;
    deleteNote: (noteId: string) => Promise<void>;
    renameNote: (noteId: string, newName: string) => Promise<NoteDto | null>;
    renameNoteAsFile: (
        noteId: string,
        newRelativePath: string,
    ) => Promise<VaultEntryDto | null>;
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

                    safeStorageSetItem(LAST_VAULT_KEY, path);
                    addToRecentVaults(path);

                    set((state) => ({
                        vaultPath: path,
                        notes: normalizeVaultNotes(notes),
                        entries: normalizeVaultEntries(entries),
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
        const path = safeStorageGetItem(LAST_VAULT_KEY);
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
                    ? normalizeVaultEntries(nextEntries)
                    : state.entries,
                vaultRevision: state.vaultRevision + 1,
                structureRevision: state.structureRevision + 1,
            }));
        } catch (error) {
            logError("vault-store", "Failed to refresh vault entries", error);
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
                notes: Array.isArray(nextNotes)
                    ? normalizeVaultNotes(nextNotes)
                    : state.notes,
                entries: Array.isArray(nextEntries)
                    ? normalizeVaultEntries(nextEntries)
                    : state.entries,
                vaultRevision: state.vaultRevision + 1,
                contentRevision: state.contentRevision + 1,
                structureRevision: state.structureRevision + 1,
                resolverRevision: state.resolverRevision + 1,
                graphRevision,
                tagsRevision: state.tagsRevision + 1,
            }));
        } catch (error) {
            logError("vault-store", "Failed to refresh vault structure", error);
        }
    },

    applyVaultNoteChange: (change) => {
        set((state) => {
            const normalizedChange = normalizeVaultNoteChange(change);
            const startMs = perfNow();
            const nextNotes = updateNotesWithChange(
                state.notes,
                normalizedChange,
            );
            const structureChanged = didResolverStructureChange(
                state.notes,
                normalizedChange,
            );
            perfCount(`vault.applyNoteChange.${normalizedChange.kind}`);
            perfMeasure(
                `vault.applyNoteChange.${normalizedChange.kind}.duration`,
                startMs,
                {
                    beforeCount: state.notes.length,
                    afterCount: nextNotes.length,
                    changedNotePresent: normalizedChange.note ? 1 : 0,
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
        const path = hasMarkdownExtension(name) ? name : `${name}.md`;
        try {
            const vaultPath = get().vaultPath ?? "";
            const detail = await invoke<{
                id: string;
                path: string;
                title: string;
            }>("create_note", { vaultPath, path, content: "" });
            const now = Math.floor(Date.now() / 1000);
            const note = normalizeNote({
                id: detail.id,
                path: detail.path,
                title: detail.title,
                modified_at: now,
                created_at: now,
            });
            const nextEntries = await loadVaultEntriesSnapshot(vaultPath);
            set((s) => ({
                notes: [...s.notes, note],
                entries: Array.isArray(nextEntries) ? nextEntries : s.entries,
                vaultRevision: s.vaultRevision + 1,
                structureRevision: s.structureRevision + 1,
                resolverRevision: s.resolverRevision + 1,
                graphRevision: s.graphRevision + 1,
                tagsRevision: s.tagsRevision + 1,
            }));
            return note;
        } catch (e) {
            logError("vault-store", "Failed to create note", e);
            return null;
        }
    },

    createFolder: async (path) => {
        try {
            const vaultPath = get().vaultPath ?? "";
            const entry = normalizeVaultEntry(
                await invoke<VaultEntryDto>("create_folder", {
                    vaultPath,
                    path,
                }),
            );
            const nextEntries = await loadVaultEntriesSnapshot(vaultPath);
            set((state) => ({
                entries: Array.isArray(nextEntries)
                    ? nextEntries
                    : [...state.entries, entry],
                vaultRevision: state.vaultRevision + 1,
                structureRevision: state.structureRevision + 1,
            }));
            return entry;
        } catch (e) {
            logError("vault-store", "Failed to create folder", e);
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
            const nextEntries = await loadVaultEntriesSnapshot(vaultPath);
            set((s) => ({
                notes: s.notes.filter(
                    (n) =>
                        n.id !== relativePath && !n.id.startsWith(folderPrefix),
                ),
                entries: Array.isArray(nextEntries)
                    ? nextEntries
                    : s.entries.filter(
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
            logError("vault-store", "Failed to delete folder", e);
            throw e;
        }
    },

    renameFolder: async (relativePath, newRelativePath) => {
        if (relativePath === newRelativePath) return true;

        try {
            const vaultPath = get().vaultPath ?? "";
            await invoke("move_folder", {
                vaultPath,
                relativePath,
                newRelativePath,
            });

            const movedNoteIds = new Map<string, string>();
            set((state) => {
                const notes = state.notes.map((note) => {
                    const next = moveNoteFolderPath(
                        note,
                        relativePath,
                        newRelativePath,
                        vaultPath,
                    );
                    if (next.id !== note.id) {
                        movedNoteIds.set(note.id, next.id);
                    }
                    return next;
                });

                const entries = state.entries.map((entry) =>
                    moveEntryFolderPath(
                        entry,
                        relativePath,
                        newRelativePath,
                        vaultPath,
                    ),
                );

                return {
                    notes,
                    entries,
                    vaultRevision: state.vaultRevision + 1,
                    structureRevision: state.structureRevision + 1,
                    resolverRevision:
                        movedNoteIds.size > 0
                            ? state.resolverRevision + 1
                            : state.resolverRevision,
                    graphRevision:
                        movedNoteIds.size > 0
                            ? state.graphRevision + 1
                            : state.graphRevision,
                    tagsRevision:
                        movedNoteIds.size > 0
                            ? state.tagsRevision + 1
                            : state.tagsRevision,
                };
            });

            const oldAbsolutePath = `${vaultPath}/${relativePath}`;
            const newAbsolutePath = `${vaultPath}/${newRelativePath}`;
            useEditorStore.setState((state) => ({
                tabs: state.tabs.map((tab) => {
                    if (
                        isNoteTab(tab) &&
                        (tab.noteId === relativePath ||
                            tab.noteId.startsWith(`${relativePath}/`))
                    ) {
                        return {
                            ...tab,
                            noteId: movePathPrefix(
                                tab.noteId,
                                relativePath,
                                newRelativePath,
                            ),
                        };
                    }

                    if (
                        isPdfTab(tab) &&
                        (tab.path === oldAbsolutePath ||
                            tab.path.startsWith(`${oldAbsolutePath}/`))
                    ) {
                        return {
                            ...tab,
                            entryId: movePathPrefix(
                                tab.entryId,
                                relativePath,
                                newRelativePath,
                            ),
                            path: movePathPrefix(
                                tab.path,
                                oldAbsolutePath,
                                newAbsolutePath,
                            ),
                        };
                    }

                    if (
                        isFileTab(tab) &&
                        (tab.relativePath === relativePath ||
                            tab.relativePath.startsWith(`${relativePath}/`))
                    ) {
                        const nextRelativePath = movePathPrefix(
                            tab.relativePath,
                            relativePath,
                            newRelativePath,
                        );
                        return {
                            ...tab,
                            relativePath: nextRelativePath,
                            path: movePathPrefix(
                                tab.path,
                                oldAbsolutePath,
                                newAbsolutePath,
                            ),
                            title:
                                nextRelativePath.split("/").pop() ??
                                tab.title,
                        };
                    }

                    return tab;
                }),
            }));

            const bookmarks = useBookmarkStore.getState();
            bookmarks.handleFolderRenamed(relativePath, newRelativePath);
            return true;
        } catch (e) {
            logError("vault-store", "Failed to rename folder", e);
            return false;
        }
    },

    deleteNote: async (noteId) => {
        try {
            const vaultPath = get().vaultPath ?? "";
            await invoke("delete_note", { vaultPath, noteId });
            const nextEntries = await loadVaultEntriesSnapshot(vaultPath);
            set((s) => ({
                notes: s.notes.filter((n) => n.id !== noteId),
                entries: Array.isArray(nextEntries) ? nextEntries : s.entries,
                vaultRevision: s.vaultRevision + 1,
                structureRevision: s.structureRevision + 1,
                resolverRevision: s.resolverRevision + 1,
                graphRevision: s.graphRevision + 1,
                tagsRevision: s.tagsRevision + 1,
            }));
            useEditorStore.getState().handleNoteDeleted(noteId);
            useBookmarkStore.getState().handleNoteDeleted(noteId);
        } catch (e) {
            logError("vault-store", "Failed to delete note", e);
        }
    },

    renameNote: async (noteId, newName) => {
        const newPath = hasMarkdownExtension(newName)
            ? newName
            : `${newName}.md`;
        try {
            const vaultPath = get().vaultPath ?? "";
            const detail = await invoke<{
                id: string;
                path: string;
                title: string;
            }>("rename_note", { vaultPath, noteId, newPath });
            const existing = get().notes.find((n) => n.id === noteId);
            const updated = normalizeNote({
                id: detail.id,
                path: detail.path,
                title: detail.title,
                modified_at: Math.floor(Date.now() / 1000),
                created_at:
                    existing?.created_at ?? Math.floor(Date.now() / 1000),
            });
            const nextEntries = await loadVaultEntriesSnapshot(vaultPath);
            set((s) => ({
                notes: s.notes.map((n) => (n.id === noteId ? updated : n)),
                entries: Array.isArray(nextEntries) ? nextEntries : s.entries,
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
            logError("vault-store", "Failed to rename note", e);
            return null;
        }
    },

    renameNoteAsFile: async (noteId, newRelativePath) => {
        try {
            const vaultPath = get().vaultPath ?? "";
            const updated = normalizeVaultEntry(
                await invoke<VaultEntryDto>("convert_note_to_file", {
                    vaultPath,
                    noteId,
                    newRelativePath,
                }),
            );
            const oldRelativePath = `${noteId}.md`;
            const nextEntries = await loadVaultEntriesSnapshot(vaultPath);
            set((state) => ({
                notes: state.notes.filter((note) => note.id !== noteId),
                entries: Array.isArray(nextEntries)
                    ? nextEntries
                    : [
                          ...state.entries.filter(
                              (entry) =>
                                  entry.relative_path !== oldRelativePath &&
                                  entry.relative_path !==
                                      updated.relative_path,
                          ),
                          updated,
                      ],
                vaultRevision: state.vaultRevision + 1,
                structureRevision: state.structureRevision + 1,
                resolverRevision: state.resolverRevision + 1,
                graphRevision: state.graphRevision + 1,
                tagsRevision: state.tagsRevision + 1,
            }));
            useEditorStore
                .getState()
                .handleNoteConvertedToFile(
                    noteId,
                    updated.relative_path,
                    updated.file_name,
                    updated.path,
                    updated.mime_type,
                    inferFileViewer(updated.path, updated.mime_type),
                );
            useBookmarkStore
                .getState()
                .handleNoteConvertedToFile(noteId, updated.relative_path);
            return updated;
        } catch (error) {
            logError("vault-store", "Failed to convert note to file", error);
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
