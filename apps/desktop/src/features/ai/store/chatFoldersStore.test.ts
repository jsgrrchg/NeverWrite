import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatFoldersStore } from "./chatFoldersStore";

const CHAT_FOLDERS_KEY = "neverwrite.chats.folders";

function resetFoldersStore() {
    useChatFoldersStore.setState({
        folders: {},
        sessionFolderIds: {},
        collapsedFolderIds: [],
    });
}

describe("chatFoldersStore", () => {
    beforeEach(() => {
        localStorage.clear();
        resetFoldersStore();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        localStorage.clear();
        resetFoldersStore();
    });

    it("normalizes names and persists a created folder", () => {
        vi.spyOn(crypto, "randomUUID").mockReturnValue("folder-research");

        expect(useChatFoldersStore.getState().createFolder("   \t ")).toBeNull();
        expect(
            useChatFoldersStore
                .getState()
                .createFolder("  Research   and   planning  "),
        ).toBe("folder-research");
        expect(useChatFoldersStore.getState().folders).toEqual({
            "folder-research": expect.objectContaining({
                id: "folder-research",
                name: "Research and planning",
            }),
        });
        expect(JSON.parse(localStorage.getItem(CHAT_FOLDERS_KEY) ?? "{}")).toEqual(
            expect.objectContaining({
                folders: expect.objectContaining({
                    "folder-research": expect.objectContaining({
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

        expect(hydratedStore.getState()).toMatchObject({
            folders: {
                valid: { id: "valid", name: "Research", createdAt: 4 },
            },
            sessionFolderIds: { "session-a": "valid" },
            collapsedFolderIds: ["valid"],
        });
    });
});
