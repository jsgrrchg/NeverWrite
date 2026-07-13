import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatFoldersStore } from "./chatFoldersStore";

const LEGACY_CHAT_FOLDERS_KEY = "neverwrite.chats.folders";
const VAULT_PATH = "/vault/research";
const CHAT_FOLDERS_KEY = `${LEGACY_CHAT_FOLDERS_KEY}:${encodeURIComponent(VAULT_PATH)}`;

function resetFoldersStore() {
    useChatFoldersStore.setState({
        vaultPath: null,
        folders: {},
        folderOrder: [],
        sessionFolderIds: {},
        collapsedFolderIds: [],
    });
}

describe("chatFoldersStore", () => {
    beforeEach(() => {
        localStorage.clear();
        resetFoldersStore();
        useChatFoldersStore.getState().setVaultPath(VAULT_PATH);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        localStorage.clear();
        resetFoldersStore();
    });

    it("normalizes names and persists a created folder", () => {
        const folderId = "00000000-0000-4000-8000-000000000001";
        vi.spyOn(crypto, "randomUUID").mockReturnValue(folderId);

        expect(useChatFoldersStore.getState().createFolder("   \t ")).toBeNull();
        expect(
            useChatFoldersStore
                .getState()
                .createFolder("  Research   and   planning  "),
        ).toBe(folderId);
        expect(useChatFoldersStore.getState().folders).toEqual({
            [folderId]: expect.objectContaining({
                id: folderId,
                name: "Research and planning",
            }),
        });
        expect(JSON.parse(localStorage.getItem(CHAT_FOLDERS_KEY) ?? "{}")).toEqual(
            expect.objectContaining({
                folders: expect.objectContaining({
                    [folderId]: expect.objectContaining({
                        name: "Research and planning",
                    }),
                }),
            }),
        );
    });

    it("cleans assignments and collapsed state when deleting a folder", () => {
        useChatFoldersStore.setState({
            folders: {
                research: { id: "research", name: "Research", createdAt: 1 },
                archive: { id: "archive", name: "Archive", createdAt: 2 },
            },
            folderOrder: ["research", "archive"],
            sessionFolderIds: {
                "session-a": "research",
                "session-b": "archive",
            },
            collapsedFolderIds: ["research", "archive"],
        });

        useChatFoldersStore.getState().deleteFolder("research");

        expect(useChatFoldersStore.getState()).toMatchObject({
            folders: {
                archive: { id: "archive", name: "Archive", createdAt: 2 },
            },
            folderOrder: ["archive"],
            sessionFolderIds: { "session-b": "archive" },
            collapsedFolderIds: ["archive"],
        });
    });

    it("moves folder metadata to the live session and reconciles stale assignments", () => {
        useChatFoldersStore.setState({
            folders: {
                research: { id: "research", name: "Research", createdAt: 1 },
                archive: { id: "archive", name: "Archive", createdAt: 2 },
            },
            folderOrder: ["research", "archive"],
            sessionFolderIds: {
                pending: "research",
                live: "archive",
                stale: "research",
            },
            collapsedFolderIds: [],
        });

        useChatFoldersStore.getState().replaceSessionId("pending", "live");
        useChatFoldersStore.getState().reconcile(["live"]);

        // The provisional assignment wins because both ids identify one chat.
        expect(useChatFoldersStore.getState().sessionFolderIds).toEqual({
            live: "research",
        });
    });

    it("keeps assignments when a cold-start chat has a persisted identity", () => {
        useChatFoldersStore.setState({
            folders: {
                research: { id: "research", name: "Research", createdAt: 1 },
            },
            folderOrder: ["research"],
            sessionFolderIds: { "history-1": "research" },
            collapsedFolderIds: [],
        });

        useChatFoldersStore.getState().reconcile(["persisted:history-1"]);

        expect(useChatFoldersStore.getState().sessionFolderIds).toEqual({
            "persisted:history-1": "research",
        });
    });

    it("persists a manual folder order", () => {
        useChatFoldersStore.setState({
            folders: {
                research: { id: "research", name: "Research", createdAt: 1 },
                archive: { id: "archive", name: "Archive", createdAt: 2 },
                later: { id: "later", name: "Later", createdAt: 3 },
            },
            folderOrder: ["research", "archive", "later"],
        });

        useChatFoldersStore.getState().reorderFolder("later", 0);

        expect(useChatFoldersStore.getState().folderOrder).toEqual([
            "later",
            "research",
            "archive",
        ]);
        expect(JSON.parse(localStorage.getItem(CHAT_FOLDERS_KEY) ?? "{}")).toEqual(
            expect.objectContaining({
                folderOrder: ["later", "research", "archive"],
            }),
        );
    });

    it("hydrates only valid folders, assignments, and collapse state", async () => {
        localStorage.setItem(
            CHAT_FOLDERS_KEY,
            JSON.stringify({
                folders: {
                    valid: { id: "ignored", name: "  Research  ", createdAt: 4 },
                    empty: { id: "empty", name: "  ", createdAt: 5 },
                },
                sessionFolderIds: {
                    "session-a": "valid",
                    "session-b": "missing",
                },
                collapsedFolderIds: ["valid", "missing", 12],
            }),
        );
        vi.resetModules();

        const { useChatFoldersStore: hydratedStore } = await import(
            "./chatFoldersStore"
        );
        hydratedStore.getState().setVaultPath(VAULT_PATH);

        expect(hydratedStore.getState()).toMatchObject({
            folders: {
                valid: { id: "valid", name: "Research", createdAt: 4 },
            },
            folderOrder: ["valid"],
            sessionFolderIds: { "session-a": "valid" },
            collapsedFolderIds: ["valid"],
        });
    });

    it("keeps folder assignments isolated per vault", () => {
        const folderId = useChatFoldersStore.getState().createFolder("Research");
        expect(folderId).toBeTruthy();
        useChatFoldersStore.getState().moveSession("session-a", folderId);

        useChatFoldersStore.getState().setVaultPath("/vault/other");
        expect(useChatFoldersStore.getState()).toMatchObject({
            folders: {},
            sessionFolderIds: {},
        });

        useChatFoldersStore.getState().setVaultPath(VAULT_PATH);
        expect(useChatFoldersStore.getState().sessionFolderIds).toEqual({
            "session-a": folderId,
        });
    });

    it("migrates the legacy global catalog into the first opened vault", async () => {
        localStorage.clear();
        localStorage.setItem(
            LEGACY_CHAT_FOLDERS_KEY,
            JSON.stringify({
                folders: {
                    research: { id: "research", name: "Research", createdAt: 1 },
                },
                folderOrder: ["research"],
                sessionFolderIds: { "session-a": "research" },
                collapsedFolderIds: [],
            }),
        );
        vi.resetModules();

        const { useChatFoldersStore: migratedStore } = await import(
            "./chatFoldersStore"
        );
        migratedStore.getState().setVaultPath(VAULT_PATH);

        expect(migratedStore.getState().sessionFolderIds).toEqual({
            "session-a": "research",
        });
        expect(localStorage.getItem(CHAT_FOLDERS_KEY)).toBeTruthy();
    });
});
