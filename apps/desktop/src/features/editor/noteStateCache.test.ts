import { describe, expect, it } from "vitest";
import type { Tab } from "../../app/store/editorStore";
import {
    buildLiveNoteCacheKey,
    collectLiveNoteIdsFromTabs,
    pruneNoteStateCaches,
    type NoteStateCacheCollection,
} from "./noteStateCache";

function createCaches(keys: string[]): NoteStateCacheCollection {
    const values = keys.map((key, index) => [key, index] as const);
    return {
        tabStates: new Map(values),
        tabScrollPositions: new Map(values),
        lastSavedContentByTabId: new Map(values),
        lastAckRevisionByTabId: new Map(values),
        pendingLocalOpIdByTabId: new Map(values),
        pendingLocalSerializedContentByTabId: new Map(values),
        frontmatterByTabId: new Map(values),
    };
}

function getAllCacheKeys(caches: NoteStateCacheCollection) {
    return [
        caches.tabStates,
        caches.tabScrollPositions,
        caches.lastSavedContentByTabId,
        caches.lastAckRevisionByTabId,
        caches.pendingLocalOpIdByTabId,
        caches.pendingLocalSerializedContentByTabId,
        caches.frontmatterByTabId,
    ].map((map) => Array.from(map.keys()).sort());
}

describe("noteStateCache", () => {
    it("keeps note ids that remain reachable from open tab histories", () => {
        const tabs: Tab[] = [
            {
                id: "tab-note",
                kind: "note",
                noteId: "notes/current",
                title: "Current",
                content: "Current body",
                history: [
                    {
                        kind: "note",
                        noteId: "notes/older",
                        title: "Older",
                        content: "Older body",
                    },
                    {
                        kind: "note",
                        noteId: "notes/current",
                        title: "Current",
                        content: "Current body",
                    },
                ],
                historyIndex: 1,
            },
            {
                id: "tab-file",
                kind: "file",
                relativePath: "docs/readme.md",
                path: "/vault/docs/readme.md",
                title: "Readme",
                content: "Readme",
                mimeType: "text/markdown",
                viewer: "text",
                history: [
                    {
                        kind: "file",
                        relativePath: "docs/readme.md",
                        path: "/vault/docs/readme.md",
                        title: "Readme",
                        content: "Readme",
                        mimeType: "text/markdown",
                        viewer: "text",
                    },
                ],
                historyIndex: 0,
            },
        ];

        expect(Array.from(collectLiveNoteIdsFromTabs(tabs)).sort()).toEqual([
            "notes/current",
            "notes/older",
        ]);
        expect(buildLiveNoteCacheKey(tabs)).toBe(
            "notes/current\u0000notes/older",
        );
    });

    it("prunes orphaned note state but preserves note history entries of open tabs", () => {
        const tabs: Tab[] = [
            {
                id: "tab-note",
                kind: "note",
                noteId: "notes/current",
                title: "Current",
                content: "Current body",
                history: [
                    {
                        kind: "note",
                        noteId: "notes/older",
                        title: "Older",
                        content: "Older body",
                    },
                    {
                        kind: "note",
                        noteId: "notes/current",
                        title: "Current",
                        content: "Current body",
                    },
                ],
                historyIndex: 1,
            },
        ];
        const caches = createCaches([
            "notes/current",
            "notes/older",
            "notes/orphan",
        ]);

        pruneNoteStateCaches(tabs, caches);

        expect(getAllCacheKeys(caches)).toEqual([
            ["notes/current", "notes/older"],
            ["notes/current", "notes/older"],
            ["notes/current", "notes/older"],
            ["notes/current", "notes/older"],
            ["notes/current", "notes/older"],
            ["notes/current", "notes/older"],
            ["notes/current", "notes/older"],
        ]);
    });
});
