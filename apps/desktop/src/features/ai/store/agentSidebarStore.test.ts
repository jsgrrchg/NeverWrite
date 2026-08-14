import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    EMPTY_AGENT_SIDEBAR_STATE,
    getAgentSidebarStorageKey,
    resetAgentSidebarStore,
    useAgentSidebarStore,
} from "./agentSidebarStore";

const VAULT_A = "/vault/a";
const VAULT_B = "/vault/b";

function metadata(overrides: Record<string, unknown> = {}) {
    return {
        pinnedAt: null,
        completedAt: null,
        snoozedAt: null,
        snoozedUntil: null,
        folderId: null,
        lastVisitedAt: null,
        ...overrides,
    };
}

describe("agentSidebarStore", () => {
    beforeEach(() => {
        localStorage.clear();
        resetAgentSidebarStore();
        vi.restoreAllMocks();
    });

    it("hydrates valid fields and normalizes corrupt collections", () => {
        localStorage.setItem(
            getAgentSidebarStorageKey(VAULT_A),
            JSON.stringify({
                version: 9,
                folders: {
                    research: { name: "  Research  ", createdAt: 2 },
                    empty: { name: "   ", createdAt: 1 },
                },
                folderOrder: ["research", "research", "missing"],
                collapsedFolderIds: ["research", "missing", 2],
                collapsedParentSessionIds: ["root", "root", null],
                pinnedOrder: ["root", "root", 2],
                activeOrder: ["active", "active"],
                completedShelfExpanded: true,
                extra: "ignored",
                sessionMetadata: {
                    root: metadata({ pinnedAt: 4, folderId: "research" }),
                    invalid: metadata({ pinnedAt: "bad", folderId: "missing" }),
                },
            }),
        );

        useAgentSidebarStore.getState().setVaultPath(VAULT_A);

        expect(useAgentSidebarStore.getState()).toMatchObject({
            version: 1,
            folders: {
                research: { id: "research", name: "Research", createdAt: 2 },
            },
            folderOrder: ["research"],
            collapsedFolderIds: ["research"],
            collapsedParentSessionIds: ["root"],
            pinnedOrder: ["root"],
            activeOrder: ["active"],
            completedShelfExpanded: true,
            sessionMetadata: {
                root: metadata({ pinnedAt: 4, folderId: "research" }),
                invalid: metadata(),
            },
        });
    });

    it("falls back safely for malformed JSON", () => {
        localStorage.setItem(getAgentSidebarStorageKey(VAULT_A), "{");
        useAgentSidebarStore.getState().setVaultPath(VAULT_A);
        expect(useAgentSidebarStore.getState()).toMatchObject(
            EMPTY_AGENT_SIDEBAR_STATE,
        );
    });

    it("keeps metadata isolated by vault", () => {
        useAgentSidebarStore.getState().setVaultPath(VAULT_A);
        useAgentSidebarStore.getState().pinSession("a", 10);
        useAgentSidebarStore.getState().setVaultPath(VAULT_B);
        useAgentSidebarStore.getState().pinSession("b", 20);
        expect(Object.keys(useAgentSidebarStore.getState().sessionMetadata)).toEqual([
            "b",
        ]);

        useAgentSidebarStore.getState().setVaultPath(VAULT_A);
        expect(useAgentSidebarStore.getState().sessionMetadata.a?.pinnedAt).toBe(10);
        expect(useAgentSidebarStore.getState().sessionMetadata.b).toBeUndefined();
    });

    it("waits for the inventory before importing global legacy metadata", () => {
        localStorage.setItem(
            "neverwrite.chats.pinnedIds",
            JSON.stringify({ a: { pinnedAt: 2 }, b: { pinnedAt: 3 } }),
        );
        localStorage.setItem(
            "neverwrite.ai.agentsSidebar.collapsedParents",
            JSON.stringify(["a", "b"]),
        );
        useAgentSidebarStore.getState().setVaultPath(VAULT_A);
        expect(useAgentSidebarStore.getState().sessionMetadata).toEqual({});

        useAgentSidebarStore.getState().migrateLegacyMetadata(["a"]);
        expect(useAgentSidebarStore.getState()).toMatchObject({
            legacyMigrationPending: false,
            pinnedOrder: ["a"],
            collapsedParentSessionIds: ["a"],
            sessionMetadata: { a: metadata({ pinnedAt: 2 }) },
        });
        expect(JSON.parse(localStorage.getItem("neverwrite.chats.pinnedIds")!)).toHaveProperty("b");
    });

    it("imports per-vault folders into session metadata", () => {
        localStorage.setItem(
            `neverwrite.chats.folders:${encodeURIComponent(VAULT_A)}`,
            JSON.stringify({
                folders: {
                    research: { id: "research", name: "Research", createdAt: 1 },
                },
                folderOrder: ["research"],
                sessionFolderIds: { a: "research" },
                collapsedFolderIds: ["research"],
            }),
        );
        useAgentSidebarStore.getState().setVaultPath(VAULT_A);
        expect(useAgentSidebarStore.getState()).toMatchObject({
            folders: {
                research: { id: "research", name: "Research", createdAt: 1 },
            },
            collapsedFolderIds: ["research"],
            sessionMetadata: { a: metadata({ folderId: "research" }) },
        });
    });

    it("applies lifecycle transitions atomically", () => {
        useAgentSidebarStore.getState().setVaultPath(VAULT_A);
        const store = useAgentSidebarStore.getState();
        store.pinSession("a", 1);
        store.snoozeSession("a", 100, 2);
        expect(useAgentSidebarStore.getState()).toMatchObject({
            pinnedOrder: ["a"],
            sessionMetadata: {
                a: metadata({ pinnedAt: 1, snoozedAt: 2, snoozedUntil: 100 }),
            },
        });

        useAgentSidebarStore.getState().completeSession("a", 3);
        expect(useAgentSidebarStore.getState()).toMatchObject({
            pinnedOrder: [],
            activeOrder: [],
            sessionMetadata: { a: metadata({ completedAt: 3 }) },
        });

        useAgentSidebarStore.getState().reopenSession("a");
        expect(useAgentSidebarStore.getState().sessionMetadata.a).toEqual(metadata());
    });

    it("moves all metadata and normalized orders when a session id changes", () => {
        useAgentSidebarStore.setState({
            sessionMetadata: {
                pending: metadata({
                    pinnedAt: 1,
                    completedAt: 2,
                    snoozedAt: 3,
                    snoozedUntil: 4,
                    folderId: null,
                    lastVisitedAt: 5,
                }),
            },
            pinnedOrder: ["pending", "live"],
            activeOrder: ["pending"],
            collapsedParentSessionIds: ["pending"],
        });
        useAgentSidebarStore.getState().replaceSessionId("pending", "live");
        expect(useAgentSidebarStore.getState()).toMatchObject({
            sessionMetadata: {
                live: metadata({
                    pinnedAt: 1,
                    completedAt: 2,
                    snoozedAt: 3,
                    snoozedUntil: 4,
                    lastVisitedAt: 5,
                }),
            },
            pinnedOrder: ["live"],
            activeOrder: ["live"],
            collapsedParentSessionIds: ["live"],
        });
    });

    it("reconciles only known roots and preserves persisted identity migration", () => {
        useAgentSidebarStore.setState({
            sessionMetadata: {
                history: metadata({ pinnedAt: 1 }),
                stale: metadata({ pinnedAt: 2 }),
            },
            pinnedOrder: ["history", "stale"],
            activeOrder: ["stale"],
        });
        useAgentSidebarStore.getState().reconcile(["persisted:history"]);
        expect(useAgentSidebarStore.getState()).toMatchObject({
            sessionMetadata: {
                "persisted:history": metadata({ pinnedAt: 1 }),
            },
            pinnedOrder: [],
            activeOrder: [],
        });
    });
});
