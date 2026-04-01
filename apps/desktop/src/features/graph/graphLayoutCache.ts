import {
    safeStorageGetItem,
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

export function loadGraphLayoutSnapshot(
    layoutKey: string,
): GraphLayoutSnapshot | null {
    try {
        const raw = safeStorageGetItem(GRAPH_LAYOUT_CACHE_PREFIX + layoutKey);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as GraphLayoutSnapshot;
        if (!parsed || typeof parsed !== "object") return null;
        if (!parsed.positions || typeof parsed.positions !== "object") {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

export function saveGraphLayoutSnapshot(
    layoutKey: string,
    positions: Record<string, GraphNodePosition>,
): void {
    try {
        safeStorageSetItem(
            GRAPH_LAYOUT_CACHE_PREFIX + layoutKey,
            JSON.stringify({
                positions,
                savedAt: Date.now(),
            } satisfies GraphLayoutSnapshot),
        );
    } catch {
        // Ignore storage quota and serialization failures.
    }
}

export function buildGraphLayoutKey(parts: {
    vaultPath: string;
    graphVersion: number;
    graphMode: string;
    rendererMode: string;
    localDepth: number;
    rootNoteId?: string | null;
    showTagNodes: boolean;
    showAttachmentNodes: boolean;
    showOrphans: boolean;
    searchFilter: string;
    layoutStrategy: string;
}): string {
    return JSON.stringify(parts);
}
