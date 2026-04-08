import { describe, expect, it, beforeEach, vi } from "vitest";
import type { ReviewFileItem } from "../diff/editedFilesPresentationModel";
import {
    createPersistedReviewAnchor,
    persistReviewViewState,
    readPersistedReviewViewState,
    resolvePersistedReviewAnchor,
    type PersistedReviewAnchor,
} from "./reviewTabPersistence";

function makeItem(
    identityKey: string,
    trackedVersion: number,
    hunkKeys: string[],
    paths?: {
        path?: string;
        originPath?: string;
        previousPath?: string | null;
    },
): ReviewFileItem {
    return {
        file: {
            identityKey,
            path: paths?.path ?? `/vault/${identityKey}.md`,
            originPath:
                paths?.originPath ?? paths?.path ?? `/vault/${identityKey}.md`,
            previousPath: paths?.previousPath ?? null,
        },
        reviewProjection: {
            trackedVersion,
            hunks: hunkKeys.map((key) => ({ id: { key } })),
        },
    } as ReviewFileItem;
}

describe("reviewTabPersistence", () => {
    beforeEach(() => {
        localStorage.clear();
        vi.useRealTimers();
    });

    it("persists and rehydrates review view state scoped by vault and session", () => {
        persistReviewViewState("/vault", "sess-1", {
            expandedIdentityKeys: ["a", "b"],
            scrollTop: 128,
            anchor: {
                identityKey: "a",
                trackedVersion: 3,
                hunkKeys: ["0:1:0:1"],
            },
        });

        const persisted = readPersistedReviewViewState("/vault", "sess-1");
        expect(persisted).not.toBeNull();
        expect(persisted?.expandedIdentityKeys).toEqual(["a", "b"]);
        expect(persisted?.scrollTop).toBe(128);
        expect(persisted?.anchor).toEqual({
            identityKey: "a",
            trackedVersion: 3,
            hunkKeys: ["0:1:0:1"],
        });
    });

    it("returns null for invalid or mismatched persisted payloads", () => {
        localStorage.setItem(
            "neverwrite.ai.review.view:/vault:sess-2",
            JSON.stringify({
                version: 999,
                expandedIdentityKeys: ["a"],
                scrollTop: 42,
                anchor: null,
                updatedAt: Date.now(),
            }),
        );

        expect(readPersistedReviewViewState("/vault", "sess-2")).toBeNull();
    });

    it("invalidates persisted semantic anchors when tracked version or hunks drift", () => {
        const anchor: PersistedReviewAnchor = {
            identityKey: "file-1",
            trackedVersion: 5,
            hunkKeys: ["hunk-a"],
        };
        const validItems = [makeItem("file-1", 5, ["hunk-a", "hunk-b"])];
        const staleVersionItems = [makeItem("file-1", 6, ["hunk-a", "hunk-b"])];
        const missingHunkItems = [makeItem("file-1", 5, ["hunk-b"])];

        expect(resolvePersistedReviewAnchor(anchor, validItems)).toMatchObject(
            anchor,
        );
        expect(
            resolvePersistedReviewAnchor(anchor, staleVersionItems),
        ).toBeNull();
        expect(
            resolvePersistedReviewAnchor(anchor, missingHunkItems),
        ).toBeNull();
    });

    it("resolves persisted anchors after move/rename when identity key changes", () => {
        const anchor = createPersistedReviewAnchor(
            {
                identityKey: "/vault/old/name.md",
                path: "/vault/new/name.md",
                originPath: "/vault/old/name.md",
                previousPath: "/vault/old/name.md",
            },
            7,
            [{ trackedVersion: 7, key: "10:12:10:12" }],
        );
        const items = [
            makeItem("new-identity-key", 7, ["10:12:10:12"], {
                path: "/vault/new/name.md",
                originPath: "/vault/old/name.md",
                previousPath: "/vault/old/name.md",
            }),
        ];

        expect(resolvePersistedReviewAnchor(anchor, items)).toMatchObject({
            identityKey: "new-identity-key",
            trackedVersion: 7,
            hunkKeys: ["10:12:10:12"],
        });
    });

    it("matches hunks by line-span tolerance when newline normalization shifts keys", () => {
        const anchor = createPersistedReviewAnchor(
            {
                identityKey: "file-1",
                path: "/vault/file-1.md",
                originPath: "/vault/file-1.md",
                previousPath: null,
            },
            9,
            [{ trackedVersion: 9, key: "20:21:20:21" }],
        );
        const items = [makeItem("file-1", 9, ["21:22:21:22"])];

        expect(resolvePersistedReviewAnchor(anchor, items)).toMatchObject({
            identityKey: "file-1",
            trackedVersion: 9,
            hunkKeys: ["21:22:21:22"],
        });
    });

    it("avoids clobbering newer persisted state during stale multi-window writes", () => {
        const newer = persistReviewViewState("/vault", "sess-race", {
            expandedIdentityKeys: ["server-newer"],
            scrollTop: 400,
            anchor: {
                identityKey: "server-newer",
                trackedVersion: 4,
                hunkKeys: ["1:2:1:2"],
            },
        });
        const overwritten = persistReviewViewState(
            "/vault",
            "sess-race",
            {
                expandedIdentityKeys: ["local-stale"],
                scrollTop: 50,
                anchor: {
                    identityKey: "local-stale",
                    trackedVersion: 1,
                    hunkKeys: ["0:1:0:1"],
                },
            },
            {
                baseUpdatedAt: (newer?.updatedAt ?? 0) - 1,
            },
        );

        expect(overwritten).toMatchObject({
            scrollTop: 400,
            anchor: {
                identityKey: "server-newer",
            },
        });
        expect(overwritten?.expandedIdentityKeys).toEqual(
            expect.arrayContaining(["server-newer", "local-stale"]),
        );
    });

    it("skips rewriting localStorage when the persisted review state is semantically unchanged", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-03-24T12:00:00.000Z"));

        const first = persistReviewViewState("/vault", "sess-stable", {
            expandedIdentityKeys: ["a"],
            scrollTop: 64,
            anchor: {
                identityKey: "a",
                trackedVersion: 2,
                hunkKeys: ["1:2:1:2"],
            },
        });

        vi.setSystemTime(new Date("2026-03-24T12:00:05.000Z"));

        const second = persistReviewViewState("/vault", "sess-stable", {
            expandedIdentityKeys: ["a"],
            scrollTop: 64,
            anchor: {
                identityKey: "a",
                trackedVersion: 2,
                hunkKeys: ["1:2:1:2"],
            },
        });

        expect(second?.updatedAt).toBe(first?.updatedAt);
        expect(
            readPersistedReviewViewState("/vault", "sess-stable")?.updatedAt,
        ).toBe(first?.updatedAt);
    });
});
