import { isNoteTab, type Tab } from "../../app/store/editorStore";

type NoteScopedCacheMap = {
    clear(): void;
    delete(key: string): boolean;
    keys(): IterableIterator<string>;
};

export interface NoteStateCacheCollection {
    tabStates: NoteScopedCacheMap;
    tabScrollPositions: NoteScopedCacheMap;
    lastSavedContentByTabId: NoteScopedCacheMap;
    lastAckRevisionByTabId: NoteScopedCacheMap;
    pendingLocalOpIdByTabId: NoteScopedCacheMap;
    frontmatterByTabId: NoteScopedCacheMap;
}

function getNoteStateCacheMaps(caches: NoteStateCacheCollection) {
    return [
        caches.tabStates,
        caches.tabScrollPositions,
        caches.lastSavedContentByTabId,
        caches.lastAckRevisionByTabId,
        caches.pendingLocalOpIdByTabId,
        caches.frontmatterByTabId,
    ];
}

export function collectLiveNoteIdsFromTabs(tabs: readonly Tab[]) {
    const liveNoteIds = new Set<string>();

    for (const tab of tabs) {
        if (!isNoteTab(tab)) continue;

        liveNoteIds.add(tab.noteId);
        for (const entry of tab.history) {
            if (entry.kind === "note") {
                liveNoteIds.add(entry.noteId);
            }
        }
    }

    return liveNoteIds;
}

export function buildLiveNoteCacheKey(tabs: readonly Tab[]) {
    return Array.from(collectLiveNoteIdsFromTabs(tabs)).sort().join("\u0000");
}

export function deleteNoteStateCacheEntries(
    noteIds: Iterable<string>,
    caches: NoteStateCacheCollection,
) {
    const uniqueNoteIds = new Set(noteIds);
    for (const noteId of uniqueNoteIds) {
        for (const map of getNoteStateCacheMaps(caches)) {
            map.delete(noteId);
        }
    }
}

export function pruneNoteStateCaches(
    tabs: readonly Tab[],
    caches: NoteStateCacheCollection,
) {
    const liveNoteIds = collectLiveNoteIdsFromTabs(tabs);
    const staleNoteIds = new Set<string>();

    for (const map of getNoteStateCacheMaps(caches)) {
        for (const noteId of map.keys()) {
            if (!liveNoteIds.has(noteId)) {
                staleNoteIds.add(noteId);
            }
        }
    }

    deleteNoteStateCacheEntries(staleNoteIds, caches);
}

export function clearNoteStateCaches(caches: NoteStateCacheCollection) {
    for (const map of getNoteStateCacheMaps(caches)) {
        map.clear();
    }
}
