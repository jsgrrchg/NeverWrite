import { describe, expect, it } from "vitest";
import type { Tab } from "../../app/store/editorStore";
import {
    buildLiveFilePathCacheKey,
    collectLiveFilePathsFromTabs,
    pruneFilePathStateCaches,
    type FilePathStateCacheCollection,
} from "./filePathStateCache";

function createCaches(keys: string[]): FilePathStateCacheCollection {
    const values = keys.map((key, index) => [key, index] as const);
    return {
        lastSavedContentByPath: new Map(values),
        lastAckRevisionByPath: new Map(values),
        pendingLocalOpIdByPath: new Map(values),
        saveRequestIdByPath: new Map(values),
    };
}

function getAllCacheKeys(caches: FilePathStateCacheCollection) {
    return [
        caches.lastSavedContentByPath,
        caches.lastAckRevisionByPath,
        caches.pendingLocalOpIdByPath,
        caches.saveRequestIdByPath,
    ].map((map) => Array.from(map.keys()).sort());
}

describe("filePathStateCache", () => {
    it("keeps file paths that remain reachable from open file tab histories", () => {
        const tabs: Tab[] = [
            {
                id: "tab-file",
                kind: "file",
                relativePath: "src/current.ts",
                title: "current.ts",
                path: "/vault/src/current.ts",
                content: "export const current = true;",
                mimeType: "text/typescript",
                viewer: "text",
                history: [
                    {
                        kind: "file",
                        relativePath: "src/older.ts",
                        title: "older.ts",
                        path: "/vault/src/older.ts",
                        content: "export const older = true;",
                        mimeType: "text/typescript",
                        viewer: "text",
                    },
                    {
                        kind: "file",
                        relativePath: "src/current.ts",
                        title: "current.ts",
                        path: "/vault/src/current.ts",
                        content: "export const current = true;",
                        mimeType: "text/typescript",
                        viewer: "text",
                    },
                ],
                historyIndex: 1,
            },
            {
                id: "tab-note",
                kind: "note",
                noteId: "notes/current",
                title: "Current",
                content: "Body",
                history: [
                    {
                        kind: "note",
                        noteId: "notes/current",
                        title: "Current",
                        content: "Body",
                    },
                ],
                historyIndex: 0,
            },
        ];

        expect(Array.from(collectLiveFilePathsFromTabs(tabs)).sort()).toEqual([
            "src/current.ts",
            "src/older.ts",
        ]);
        expect(buildLiveFilePathCacheKey(tabs)).toBe(
            "src/current.ts\u0000src/older.ts",
        );
    });

    it("prunes orphaned file path state but preserves file history entries of open tabs", () => {
        const tabs: Tab[] = [
            {
                id: "tab-file",
                kind: "file",
                relativePath: "src/current.ts",
                title: "current.ts",
                path: "/vault/src/current.ts",
                content: "export const current = true;",
                mimeType: "text/typescript",
                viewer: "text",
                history: [
                    {
                        kind: "file",
                        relativePath: "src/older.ts",
                        title: "older.ts",
                        path: "/vault/src/older.ts",
                        content: "export const older = true;",
                        mimeType: "text/typescript",
                        viewer: "text",
                    },
                    {
                        kind: "file",
                        relativePath: "src/current.ts",
                        title: "current.ts",
                        path: "/vault/src/current.ts",
                        content: "export const current = true;",
                        mimeType: "text/typescript",
                        viewer: "text",
                    },
                ],
                historyIndex: 1,
            },
        ];
        const caches = createCaches([
            "src/current.ts",
            "src/older.ts",
            "src/orphan.ts",
        ]);

        pruneFilePathStateCaches(tabs, caches);

        expect(getAllCacheKeys(caches)).toEqual([
            ["src/current.ts", "src/older.ts"],
            ["src/current.ts", "src/older.ts"],
            ["src/current.ts", "src/older.ts"],
            ["src/current.ts", "src/older.ts"],
        ]);
    });
});
