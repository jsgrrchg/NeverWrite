import { beforeEach, describe, expect, it, vi } from "vitest";
import { useVaultStore } from "../../../app/store/vaultStore";
import {
    markChatTabsReady,
    readPersistedChatWorkspace,
    resetChatTabsStore,
    useChatTabsStore,
} from "./chatTabsStore";

describe("chatTabsStore", () => {
    beforeEach(() => {
        resetChatTabsStore();
        vi.useRealTimers();
        useVaultStore.setState({ vaultPath: null, notes: [] });
    });

    it("opens a new tab for an existing session", () => {
        useChatTabsStore.getState().openSessionTab("session-a");

        expect(useChatTabsStore.getState().tabs).toHaveLength(1);
        expect(useChatTabsStore.getState().tabs[0]).toMatchObject({
            sessionId: "session-a",
        });
        expect(useChatTabsStore.getState().activeTabId).toBe(
            useChatTabsStore.getState().tabs[0]?.id,
        );
    });

    it("does not duplicate tabs for the same session", () => {
        useChatTabsStore.getState().openSessionTab("session-a");
        const firstTabId = useChatTabsStore.getState().tabs[0]?.id;

        useChatTabsStore.getState().openSessionTab("session-a");

        expect(useChatTabsStore.getState().tabs).toHaveLength(1);
        expect(useChatTabsStore.getState().tabs[0]?.id).toBe(firstTabId);
        expect(useChatTabsStore.getState().activeTabId).toBe(firstTabId);
    });

    it("closes the active tab and activates the nearest remaining tab", () => {
        useChatTabsStore.getState().openSessionTab("session-a");
        useChatTabsStore.getState().openSessionTab("session-b");
        useChatTabsStore.getState().openSessionTab("session-c");

        const middleTabId = useChatTabsStore.getState().tabs[1]?.id;
        expect(middleTabId).toBeTruthy();

        useChatTabsStore.getState().setActiveTab(middleTabId!);
        useChatTabsStore.getState().closeTab(middleTabId!);

        expect(
            useChatTabsStore.getState().tabs.map((tab) => tab.sessionId),
        ).toEqual(["session-a", "session-c"]);
        expect(useChatTabsStore.getState().activeTabId).toBe(
            useChatTabsStore.getState().tabs[0]?.id,
        );
    });

    it("persists and rehydrates tabs per vault path", () => {
        vi.useFakeTimers();
        markChatTabsReady();
        useVaultStore.setState({ vaultPath: "/vaults/work" });

        useChatTabsStore.getState().openSessionTab("session-a");
        useChatTabsStore.getState().openSessionTab("session-b");
        vi.runAllTimers();

        const persisted = readPersistedChatWorkspace("/vaults/work");
        expect(persisted).toMatchObject({
            version: 1,
            tabs: [
                { sessionId: "session-a" },
                { sessionId: "session-b" },
            ],
        });
        expect(persisted?.activeTabId).toBe(
            useChatTabsStore.getState().activeTabId,
        );

        resetChatTabsStore();
        useChatTabsStore.getState().hydrateForVault(persisted ?? null);

        expect(
            useChatTabsStore.getState().tabs.map((tab) => tab.sessionId),
        ).toEqual(["session-a", "session-b"]);
        expect(useChatTabsStore.getState().activeTabId).toBe(
            persisted?.activeTabId ?? null,
        );
    });

    it("prunes invalid tabs and keeps a valid active tab", () => {
        useChatTabsStore.getState().openSessionTab("session-a");
        useChatTabsStore.getState().openSessionTab("session-b");
        useChatTabsStore.getState().openSessionTab("session-c");

        const firstTabId = useChatTabsStore.getState().tabs[0]?.id ?? null;
        useChatTabsStore.getState().setActiveTab(firstTabId!);
        useChatTabsStore.getState().pruneInvalidTabs(["session-a", "session-c"]);

        expect(
            useChatTabsStore.getState().tabs.map((tab) => tab.sessionId),
        ).toEqual(["session-a", "session-c"]);
        expect(useChatTabsStore.getState().activeTabId).toBe(firstTabId);
    });

    it("replaces persisted session ids with live ids", () => {
        useChatTabsStore.getState().openSessionTab("persisted:history-1");
        const originalTabId = useChatTabsStore.getState().tabs[0]?.id;

        useChatTabsStore
            .getState()
            .replaceSessionId("persisted:history-1", "codex-session-1");

        expect(useChatTabsStore.getState().tabs).toEqual([
            {
                id: originalTabId,
                sessionId: "codex-session-1",
                historySessionId: "history-1",
            },
        ]);
        expect(useChatTabsStore.getState().activeTabId).toBe(originalTabId);
    });

    it("restores valid persisted tabs after session hydration", () => {
        useChatTabsStore.getState().restoreWorkspace(
            {
                version: 1,
                tabs: [
                    { id: "tab-a", sessionId: "session-a" },
                    { id: "tab-b", sessionId: "session-b" },
                ],
                activeTabId: "tab-b",
            },
            [{ sessionId: "session-b" }, { sessionId: "session-c" }],
            "session-c",
        );

        expect(useChatTabsStore.getState().tabs).toEqual([
            {
                id: "tab-b",
                sessionId: "session-b",
            },
        ]);
        expect(useChatTabsStore.getState().activeTabId).toBe("tab-b");
    });

    it("opens a default tab when no persisted tab survives validation", () => {
        useChatTabsStore.getState().restoreWorkspace(
            {
                version: 1,
                tabs: [{ id: "tab-a", sessionId: "session-a" }],
                activeTabId: "tab-a",
            },
            [{ sessionId: "session-b" }],
            "session-b",
        );

        expect(useChatTabsStore.getState().tabs).toHaveLength(1);
        expect(useChatTabsStore.getState().tabs[0]?.sessionId).toBe(
            "session-b",
        );
        expect(useChatTabsStore.getState().activeTabId).toBe(
            useChatTabsStore.getState().tabs[0]?.id,
        );
    });

    it("restores a tab against a resumed live session via historySessionId", () => {
        useChatTabsStore.getState().restoreWorkspace(
            {
                version: 1,
                tabs: [
                    {
                        id: "tab-a",
                        sessionId: "codex-session-1",
                        historySessionId: "history-1",
                    },
                ],
                activeTabId: "tab-a",
            },
            [
                {
                    sessionId: "codex-session-9",
                    historySessionId: "history-1",
                },
            ],
        );

        expect(useChatTabsStore.getState().tabs).toEqual([
            {
                id: "tab-a",
                sessionId: "codex-session-9",
                historySessionId: "history-1",
            },
        ]);
        expect(useChatTabsStore.getState().activeTabId).toBe("tab-a");
    });

    it("restores a persisted tab against a resumed live session via persisted id", () => {
        useChatTabsStore.getState().restoreWorkspace(
            {
                version: 1,
                tabs: [
                    {
                        id: "tab-a",
                        sessionId: "persisted:history-1",
                    },
                ],
                activeTabId: "tab-a",
            },
            [
                {
                    sessionId: "codex-session-9",
                    historySessionId: "history-1",
                },
            ],
        );

        expect(useChatTabsStore.getState().tabs).toEqual([
            {
                id: "tab-a",
                sessionId: "codex-session-9",
                historySessionId: "history-1",
            },
        ]);
        expect(useChatTabsStore.getState().activeTabId).toBe("tab-a");
    });

    it("flushes pending persistence on reset", () => {
        vi.useFakeTimers();
        markChatTabsReady();
        useVaultStore.setState({ vaultPath: "/vaults/work" });

        useChatTabsStore
            .getState()
            .openSessionTab("session-a", { historySessionId: "history-a" });

        resetChatTabsStore();

        const persisted = readPersistedChatWorkspace("/vaults/work");
        expect(persisted).toMatchObject({
            tabs: [{ sessionId: "session-a", historySessionId: "history-a" }],
        });
    });
});
