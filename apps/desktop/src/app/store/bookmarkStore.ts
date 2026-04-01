import { create } from "zustand";
import { safeStorageGetItem, safeStorageSetItem } from "../utils/safeStorage";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BookmarkFolder {
    id: string;
    name: string;
    sortOrder: number;
}

export interface BookmarkItem {
    id: string;
    folderId: string | null; // null = root level
    kind: "note" | "pdf" | "file";
    noteId: string | null;
    entryPath: string | null; // VaultEntryDto.relative_path
    sortOrder: number;
}

interface BookmarkState {
    folders: BookmarkFolder[];
    items: BookmarkItem[];
}

export interface BookmarkStore extends BookmarkState {
    // Folder actions
    createFolder: (name: string) => string;
    renameFolder: (folderId: string, newName: string) => void;
    deleteFolder: (folderId: string) => void;

    // Item actions
    addBookmark: (params: {
        kind: "note" | "pdf" | "file";
        noteId?: string | null;
        entryPath?: string | null;
        folderId?: string | null;
    }) => void;
    removeBookmark: (bookmarkId: string) => void;
    moveBookmark: (bookmarkId: string, targetFolderId: string | null) => void;

    // Queries
    isBookmarked: (noteId: string) => boolean;
    isEntryBookmarked: (entryPath: string) => boolean;

    // Vault sync
    handleNoteDeleted: (noteId: string) => void;
    handleNoteRenamed: (oldNoteId: string, newNoteId: string) => void;
    handleEntryDeleted: (relativePath: string) => void;

    // Lifecycle
    loadForVault: (vaultPath: string) => void;
    reset: () => void;
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

const BOOKMARKS_KEY_PREFIX = "vaultai:bookmarks:";

let _currentVaultPath: string | null = null;

function storageKey(vaultPath: string): string {
    return `${BOOKMARKS_KEY_PREFIX}${vaultPath}`;
}

function readBookmarks(vaultPath: string): BookmarkState {
    try {
        const raw = safeStorageGetItem(storageKey(vaultPath));
        if (!raw) return { folders: [], items: [] };
        const parsed = JSON.parse(raw) as Partial<BookmarkState>;
        return {
            folders: Array.isArray(parsed.folders) ? parsed.folders : [],
            items: Array.isArray(parsed.items) ? parsed.items : [],
        };
    } catch {
        return { folders: [], items: [] };
    }
}

function persistBookmarks(state: BookmarkState) {
    if (!_currentVaultPath) return;
    try {
        safeStorageSetItem(
            storageKey(_currentVaultPath),
            JSON.stringify({ folders: state.folders, items: state.items }),
        );
    } catch {
        // localStorage quota exceeded — ignore
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nextSortOrder(arr: { sortOrder: number }[]): number {
    if (arr.length === 0) return 0;
    return Math.max(...arr.map((a) => a.sortOrder)) + 1;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useBookmarkStore = create<BookmarkStore>((set, get) => ({
    folders: [],
    items: [],

    // ---- Folder actions ----

    createFolder: (name) => {
        const id = crypto.randomUUID();
        set((s) => ({
            folders: [
                ...s.folders,
                { id, name, sortOrder: nextSortOrder(s.folders) },
            ],
        }));
        return id;
    },

    renameFolder: (folderId, newName) => {
        set((s) => ({
            folders: s.folders.map((f) =>
                f.id === folderId ? { ...f, name: newName } : f,
            ),
        }));
    },

    deleteFolder: (folderId) => {
        set((s) => ({
            folders: s.folders.filter((f) => f.id !== folderId),
            items: s.items.filter((i) => i.folderId !== folderId),
        }));
    },

    // ---- Item actions ----

    addBookmark: ({ kind, noteId, entryPath, folderId }) => {
        const state = get();

        // Deduplicate: don't add if already bookmarked
        if (kind === "note" && noteId) {
            if (state.items.some((i) => i.noteId === noteId)) return;
        } else if (entryPath) {
            if (state.items.some((i) => i.entryPath === entryPath)) return;
        }

        const item: BookmarkItem = {
            id: crypto.randomUUID(),
            folderId: folderId ?? null,
            kind,
            noteId: noteId ?? null,
            entryPath: entryPath ?? null,
            sortOrder: nextSortOrder(
                state.items.filter((i) => i.folderId === (folderId ?? null)),
            ),
        };

        set((s) => ({ items: [...s.items, item] }));
    },

    removeBookmark: (bookmarkId) => {
        set((s) => ({
            items: s.items.filter((i) => i.id !== bookmarkId),
        }));
    },

    moveBookmark: (bookmarkId, targetFolderId) => {
        set((s) => ({
            items: s.items.map((i) =>
                i.id === bookmarkId
                    ? {
                          ...i,
                          folderId: targetFolderId,
                          sortOrder: nextSortOrder(
                              s.items.filter(
                                  (x) => x.folderId === targetFolderId,
                              ),
                          ),
                      }
                    : i,
            ),
        }));
    },

    // ---- Queries ----

    isBookmarked: (noteId) => {
        return get().items.some((i) => i.noteId === noteId);
    },

    isEntryBookmarked: (entryPath) => {
        return get().items.some((i) => i.entryPath === entryPath);
    },

    // ---- Vault sync ----

    handleNoteDeleted: (noteId) => {
        set((s) => ({
            items: s.items.filter((i) => i.noteId !== noteId),
        }));
    },

    handleNoteRenamed: (oldNoteId, newNoteId) => {
        set((s) => ({
            items: s.items.map((i) =>
                i.noteId === oldNoteId ? { ...i, noteId: newNoteId } : i,
            ),
        }));
    },

    handleEntryDeleted: (relativePath) => {
        set((s) => ({
            items: s.items.filter((i) => i.entryPath !== relativePath),
        }));
    },

    // ---- Lifecycle ----

    loadForVault: (vaultPath) => {
        _currentVaultPath = vaultPath;
        const data = readBookmarks(vaultPath);
        set({ folders: data.folders, items: data.items });
    },

    reset: () => {
        _currentVaultPath = null;
        set({ folders: [], items: [] });
    },
}));

// Auto-persist on every state change
useBookmarkStore.subscribe((state) => {
    persistBookmarks(state);
});
