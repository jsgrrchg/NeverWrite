import {
    safeStorageGetItem,
    safeStorageKeys,
    safeStorageRemoveItem,
    safeStorageSetItem,
} from "../../app/utils/safeStorage";

export interface GraphNodePosition {
    x: number;
    y: number;
    z?: number;
}

export interface GraphLayoutSnapshot {
    positions: Record<string, GraphNodePosition>;
    savedAt: number;
}

const GRAPH_LAYOUT_CACHE_PREFIX = "vault-graph-layout:v1:";
const GRAPH_LAYOUT_CACHE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30;
const GRAPH_LAYOUT_CACHE_MAX_ENTRIES_PER_VAULT = 12;

interface GraphLayoutCacheKeyParts {
    vaultPath: string;
    graphVersion: number;
    graphMode: string;
    rendererMode: string;
    localDepth: number;
    rootNoteId?: string | null;
    showTagNodes: boolean;
    showAttachmentNodes: boolean;
    showOrphans: boolean;
    layoutStrategy: string;
}

interface GraphPreparedSnapshotKeyParts extends GraphLayoutCacheKeyParts {
    searchFilter: string;
}

interface ParsedGraphLayoutCacheKey extends GraphLayoutCacheKeyParts {
    searchFilter?: string;
}

interface StoredGraphLayoutCacheEntry {
    storageKey: string;
    layoutKey: string;
    snapshot: GraphLayoutSnapshot;
    parts: ParsedGraphLayoutCacheKey;
}

let didPruneGraphLayoutCacheThisSession = false;

function parseGraphLayoutSnapshot(
    raw: string | null,
): GraphLayoutSnapshot | null {
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GraphLayoutSnapshot;
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.positions || typeof parsed.positions !== "object") {
        return null;
    }
    if (!Number.isFinite(parsed.savedAt)) {
        return null;
    }
    return parsed;
}

function parseGraphLayoutCacheKey(
    storageKey: string,
): ParsedGraphLayoutCacheKey | null {
    if (!storageKey.startsWith(GRAPH_LAYOUT_CACHE_PREFIX)) {
        return null;
    }
    try {
        const parsed = JSON.parse(
            storageKey.slice(GRAPH_LAYOUT_CACHE_PREFIX.length),
        ) as ParsedGraphLayoutCacheKey;
        if (!parsed || typeof parsed !== "object") return null;
        if (
            typeof parsed.vaultPath !== "string" ||
            parsed.vaultPath.length === 0
        ) {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

function removeGraphLayoutSnapshot(storageKey: string) {
    safeStorageRemoveItem(storageKey);
}

function collectStoredGraphLayoutEntries(): StoredGraphLayoutCacheEntry[] {
    const entries: StoredGraphLayoutCacheEntry[] = [];
    for (const storageKey of safeStorageKeys()) {
        if (!storageKey.startsWith(GRAPH_LAYOUT_CACHE_PREFIX)) continue;

        const parts = parseGraphLayoutCacheKey(storageKey);
        if (!parts) {
            removeGraphLayoutSnapshot(storageKey);
            continue;
        }

        try {
            const snapshot = parseGraphLayoutSnapshot(
                safeStorageGetItem(storageKey),
            );
            if (!snapshot) {
                removeGraphLayoutSnapshot(storageKey);
                continue;
            }
            entries.push({
                storageKey,
                layoutKey: storageKey.slice(GRAPH_LAYOUT_CACHE_PREFIX.length),
                snapshot,
                parts,
            });
        } catch {
            removeGraphLayoutSnapshot(storageKey);
        }
    }
    return entries;
}

function pruneGraphLayoutCache(force = false) {
    if (!force && didPruneGraphLayoutCacheThisSession) {
        return;
    }
    didPruneGraphLayoutCacheThisSession = true;

    const now = Date.now();
    const entriesByVault = new Map<string, StoredGraphLayoutCacheEntry[]>();

    for (const entry of collectStoredGraphLayoutEntries()) {
        const searchFilter = entry.parts.searchFilter?.trim() ?? "";
        const isExpired =
            now - entry.snapshot.savedAt > GRAPH_LAYOUT_CACHE_MAX_AGE_MS;

        if (searchFilter.length > 0 || isExpired) {
            removeGraphLayoutSnapshot(entry.storageKey);
            continue;
        }

        const bucket = entriesByVault.get(entry.parts.vaultPath);
        if (bucket) {
            bucket.push(entry);
        } else {
            entriesByVault.set(entry.parts.vaultPath, [entry]);
        }
    }

    for (const entries of entriesByVault.values()) {
        entries.sort(
            (left, right) => right.snapshot.savedAt - left.snapshot.savedAt,
        );
        for (const staleEntry of entries.slice(
            GRAPH_LAYOUT_CACHE_MAX_ENTRIES_PER_VAULT,
        )) {
            removeGraphLayoutSnapshot(staleEntry.storageKey);
        }
    }
}

export function loadGraphLayoutSnapshot(
    layoutKey: string,
): GraphLayoutSnapshot | null {
    pruneGraphLayoutCache();
    try {
        return parseGraphLayoutSnapshot(
            safeStorageGetItem(GRAPH_LAYOUT_CACHE_PREFIX + layoutKey),
        );
    } catch {
        return null;
    }
}

export function saveGraphLayoutSnapshot(
    layoutKey: string,
    positions: Record<string, GraphNodePosition>,
): void {
    pruneGraphLayoutCache();
    try {
        const storageKey = GRAPH_LAYOUT_CACHE_PREFIX + layoutKey;
        const existing = parseGraphLayoutSnapshot(
            safeStorageGetItem(storageKey),
        );
        safeStorageSetItem(
            storageKey,
            JSON.stringify({
                positions: {
                    ...(existing?.positions ?? {}),
                    ...positions,
                },
                savedAt: Date.now(),
            } satisfies GraphLayoutSnapshot),
        );
        pruneGraphLayoutCache(true);
    } catch {
        // Ignore storage quota and serialization failures.
    }
}

export function buildGraphLayoutCacheKey(
    parts: GraphLayoutCacheKeyParts,
): string {
    return JSON.stringify(parts);
}

export function buildGraphPreparedSnapshotKey(
    parts: GraphPreparedSnapshotKeyParts,
): string {
    return JSON.stringify(parts);
}
