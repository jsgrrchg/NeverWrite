import { isFileTab, type Tab } from "../../app/store/editorStore";

type FilePathScopedCacheMap = {
    clear(): void;
    delete(key: string): boolean;
    keys(): IterableIterator<string>;
};

export interface FilePathStateCacheCollection {
    lastSavedContentByPath: FilePathScopedCacheMap;
    lastAckRevisionByPath: FilePathScopedCacheMap;
    pendingLocalOpIdByPath: FilePathScopedCacheMap;
    saveRequestIdByPath: FilePathScopedCacheMap;
}

function getFilePathStateCacheMaps(caches: FilePathStateCacheCollection) {
    return [
        caches.lastSavedContentByPath,
        caches.lastAckRevisionByPath,
        caches.pendingLocalOpIdByPath,
        caches.saveRequestIdByPath,
    ];
}

export function collectLiveFilePathsFromTabs(tabs: readonly Tab[]) {
    const liveFilePaths = new Set<string>();

    for (const tab of tabs) {
        if (!isFileTab(tab)) continue;

        liveFilePaths.add(tab.relativePath);
        for (const entry of tab.history) {
            if (entry.kind === "file") {
                liveFilePaths.add(entry.relativePath);
            }
        }
    }

    return liveFilePaths;
}

export function buildLiveFilePathCacheKey(tabs: readonly Tab[]) {
    return Array.from(collectLiveFilePathsFromTabs(tabs)).sort().join("\u0000");
}

export function deleteFilePathStateCacheEntries(
    relativePaths: Iterable<string>,
    caches: FilePathStateCacheCollection,
) {
    const uniqueRelativePaths = new Set(relativePaths);
    for (const relativePath of uniqueRelativePaths) {
        for (const map of getFilePathStateCacheMaps(caches)) {
            map.delete(relativePath);
        }
    }
}

export function pruneFilePathStateCaches(
    tabs: readonly Tab[],
    caches: FilePathStateCacheCollection,
) {
    const liveFilePaths = collectLiveFilePathsFromTabs(tabs);
    const staleRelativePaths = new Set<string>();

    for (const map of getFilePathStateCacheMaps(caches)) {
        for (const relativePath of map.keys()) {
            if (!liveFilePaths.has(relativePath)) {
                staleRelativePaths.add(relativePath);
            }
        }
    }

    deleteFilePathStateCacheEntries(staleRelativePaths, caches);
}

export function clearFilePathStateCaches(caches: FilePathStateCacheCollection) {
    for (const map of getFilePathStateCacheMaps(caches)) {
        map.clear();
    }
}
