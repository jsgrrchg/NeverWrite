import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    safeStorageClear,
    safeStorageGetItem,
    safeStorageKeys,
    safeStorageSetItem,
} from "../../app/utils/safeStorage";
import {
    buildGraphLayoutCacheKey,
    buildGraphPreparedSnapshotKey,
    loadGraphLayoutSnapshot,
    saveGraphLayoutSnapshot,
} from "./graphLayoutCache";

const GRAPH_LAYOUT_CACHE_PREFIX = "vault-graph-layout:v1:";
const DAY_MS = 1000 * 60 * 60 * 24;
const MAX_ENTRIES_PER_VAULT = 12;

function buildBaseParts(overrides: Partial<{
    vaultPath: string;
    graphVersion: number;
    graphMode: string;
    rendererMode: string;
    localDepth: number;
    rootNoteId: string | null;
    showTagNodes: boolean;
    showAttachmentNodes: boolean;
    showOrphans: boolean;
    layoutStrategy: string;
}> = {}) {
    return {
        vaultPath: "/tmp/neverwrite-test-vault",
        graphVersion: 1,
        graphMode: "global",
        rendererMode: "2d",
        localDepth: 2,
        rootNoteId: null,
        showTagNodes: false,
        showAttachmentNodes: false,
        showOrphans: true,
        layoutStrategy: "preset",
        ...overrides,
    };
}

function storedSnapshot(nodeId: string, savedAt = Date.now()) {
    return JSON.stringify({
        positions: {
            [nodeId]: { x: savedAt % 1000, y: savedAt % 100 },
        },
        savedAt,
    });
}

describe("graphLayoutCache", () => {
    beforeEach(() => {
        safeStorageClear();
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-04-11T12:00:00Z"));
    });

    afterEach(() => {
        safeStorageClear();
        vi.useRealTimers();
    });

    it("keeps persistent layout keys stable while prepared keys track the search filter", () => {
        const cacheKey = buildGraphLayoutCacheKey(buildBaseParts());
        const preparedFoo = buildGraphPreparedSnapshotKey({
            ...buildBaseParts(),
            searchFilter: "foo",
        });
        const preparedBar = buildGraphPreparedSnapshotKey({
            ...buildBaseParts(),
            searchFilter: "bar",
        });

        expect(preparedFoo).not.toBe(preparedBar);
        expect(cacheKey).not.toBe(preparedFoo);
        expect(cacheKey).not.toBe(preparedBar);
    });

    it("merges positions instead of replacing the stored snapshot", () => {
        const cacheKey = buildGraphLayoutCacheKey(buildBaseParts());

        saveGraphLayoutSnapshot(cacheKey, {
            alpha: { x: 10, y: 20 },
        });
        saveGraphLayoutSnapshot(cacheKey, {
            beta: { x: 30, y: 40, z: 5 },
        });

        expect(loadGraphLayoutSnapshot(cacheKey)?.positions).toEqual({
            alpha: { x: 10, y: 20 },
            beta: { x: 30, y: 40, z: 5 },
        });
    });

    it("prunes legacy filtered entries, expired entries, and the oldest overflow", () => {
        const recentKeys: string[] = [];
        for (let index = 0; index < MAX_ENTRIES_PER_VAULT + 1; index += 1) {
            const cacheKey = buildGraphLayoutCacheKey(
                buildBaseParts({ graphVersion: index + 1 }),
            );
            recentKeys.push(cacheKey);
            safeStorageSetItem(
                GRAPH_LAYOUT_CACHE_PREFIX + cacheKey,
                storedSnapshot(`node-${index}`, Date.now() - index * 1000),
            );
        }

        const legacyFilteredKey = buildGraphPreparedSnapshotKey({
            ...buildBaseParts({ graphVersion: 100 }),
            searchFilter: "tag:project",
        });
        safeStorageSetItem(
            GRAPH_LAYOUT_CACHE_PREFIX + legacyFilteredKey,
            storedSnapshot("legacy-filtered"),
        );

        const expiredKey = buildGraphLayoutCacheKey(
            buildBaseParts({ graphVersion: 200 }),
        );
        safeStorageSetItem(
            GRAPH_LAYOUT_CACHE_PREFIX + expiredKey,
            storedSnapshot("expired", Date.now() - DAY_MS * 31),
        );

        const currentKey = buildGraphLayoutCacheKey(
            buildBaseParts({ graphVersion: 999 }),
        );
        saveGraphLayoutSnapshot(currentKey, {
            current: { x: 1, y: 2 },
        });

        const graphLayoutKeys = safeStorageKeys().filter((key) =>
            key.startsWith(GRAPH_LAYOUT_CACHE_PREFIX),
        );

        expect(safeStorageGetItem(GRAPH_LAYOUT_CACHE_PREFIX + legacyFilteredKey)).toBeNull();
        expect(safeStorageGetItem(GRAPH_LAYOUT_CACHE_PREFIX + expiredKey)).toBeNull();
        expect(
            safeStorageGetItem(
                GRAPH_LAYOUT_CACHE_PREFIX + recentKeys[recentKeys.length - 1],
            ),
        ).toBeNull();
        expect(safeStorageGetItem(GRAPH_LAYOUT_CACHE_PREFIX + currentKey)).not.toBeNull();
        expect(graphLayoutKeys).toHaveLength(MAX_ENTRIES_PER_VAULT);
    });
});
