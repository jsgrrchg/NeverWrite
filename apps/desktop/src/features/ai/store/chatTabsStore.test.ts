import { describe, expect, it, beforeEach } from "vitest";
import {
    markChatTabsReady,
    readPersistedChatWorkspace,
    resetChatTabsStore,
    useChatTabsStore,
} from "./chatTabsStore";
import { useVaultStore } from "../../../app/store/vaultStore";

describe("chatTabsStore", () => {
    beforeEach(() => {
        resetChatTabsStore();
        useVaultStore.setState({ vaultPath: "/vaults/work" });
        localStorage.clear();
    });

    it("opens and deduplicates session metadata tabs", () => {
        useChatTabsStore.getState().openSessionTab("session-a", {
            historySessionId: "history-a",
            runtimeId: "runtime-a",
        });
        const firstTabId = useChatTabsStore.getState().tabs[0]?.id ?? null;

        useChatTabsStore.getState().openSessionTab("session-a", {
            historySessionId: "history-a",
            runtimeId: "runtime-a",
        });

        expect(useChatTabsStore.getState().tabs).toHaveLength(1);
        expect(useChatTabsStore.getState().tabs[0]).toMatchObject({
            id: firstTabId,
            sessionId: "session-a",
            historySessionId: "history-a",
            runtimeId: "runtime-a",
        });
        expect(useChatTabsStore.getState().activeTabId).toBe(firstTabId);
    });

    it("reorders tabs without changing the active tab id", () => {
        useChatTabsStore.getState().openSessionTab("session-a");
        useChatTabsStore.getState().openSessionTab("session-b");
        useChatTabsStore.getState().openSessionTab("session-c");
        const activeTabId = useChatTabsStore.getState().activeTabId;

        useChatTabsStore.getState().reorderTabs(2, 0);

        expect(
            useChatTabsStore.getState().tabs.map((tab) => tab.sessionId),
        ).toEqual(["session-c", "session-a", "session-b"]);
        expect(useChatTabsStore.getState().activeTabId).toBe(activeTabId);
    });

    it("persists and restores metadata for the current vault", async () => {
        markChatTabsReady();
        useChatTabsStore.getState().openSessionTab("session-a", {
            historySessionId: "history-a",
            runtimeId: "runtime-a",
        });
        useChatTabsStore.getState().openSessionTab("session-b", {
            historySessionId: "history-b",
            runtimeId: "runtime-b",
        });

        await new Promise((resolve) => setTimeout(resolve, 550));

        const persisted = readPersistedChatWorkspace("/vaults/work");
        expect(persisted?.tabs).toMatchObject([
            {
                sessionId: "session-a",
                historySessionId: "history-a",
                runtimeId: "runtime-a",
            },
            {
                sessionId: "session-b",
                historySessionId: "history-b",
                runtimeId: "runtime-b",
            },
        ]);

        resetChatTabsStore();
        useChatTabsStore.getState().hydrateForVault(persisted ?? null);

        expect(
            useChatTabsStore.getState().tabs.map((tab) => tab.sessionId),
        ).toEqual(["session-a", "session-b"]);
    });

    it("replaces persisted session ids while preserving history metadata", () => {
        useChatTabsStore.getState().openSessionTab("persisted:history-1", {
            historySessionId: "history-1",
            runtimeId: "runtime-a",
        });

        useChatTabsStore.getState().replaceSessionId(
            "persisted:history-1",
            "session-live-1",
            "history-1",
            "runtime-a",
        );

        expect(useChatTabsStore.getState().tabs).toEqual([
            expect.objectContaining({
                sessionId: "session-live-1",
                historySessionId: "history-1",
                runtimeId: "runtime-a",
            }),
        ]);
    });

    it("closes only the selected session tab when parent and child are open", () => {
        useChatTabsStore.setState({
            tabs: [
                { id: "tab-parent", sessionId: "session-parent" },
                { id: "tab-child", sessionId: "session-child" },
            ],
            activeTabId: "tab-parent",
        });

        useChatTabsStore.getState().closeTab("tab-parent");

        expect(useChatTabsStore.getState().tabs).toEqual([
            { id: "tab-child", sessionId: "session-child" },
        ]);
        expect(useChatTabsStore.getState().activeTabId).toBe("tab-child");
    });

    it("restores valid metadata tabs against the available sessions", () => {
        useChatTabsStore.getState().restoreWorkspace(
            {
                version: 1,
                tabs: [
                    {
                        id: "tab-a",
                        sessionId: "persisted:history-a",
                        historySessionId: "history-a",
                        runtimeId: "runtime-a",
                    },
                    {
                        id: "tab-b",
                        sessionId: "session-b",
                        historySessionId: "history-b",
                        runtimeId: "runtime-b",
                    },
                ],
                activeTabId: "tab-a",
            },
            [
                {
                    sessionId: "session-a",
                    historySessionId: "history-a",
                    runtimeId: "runtime-a",
                },
                {
                    sessionId: "session-b",
                    historySessionId: "history-b",
                    runtimeId: "runtime-b",
                },
            ],
            null,
        );

        expect(useChatTabsStore.getState().tabs).toEqual([
            expect.objectContaining({
                id: "tab-a",
                sessionId: "session-a",
                historySessionId: "history-a",
                runtimeId: "runtime-a",
            }),
            expect.objectContaining({
                id: "tab-b",
                sessionId: "session-b",
                historySessionId: "history-b",
                runtimeId: "runtime-b",
            }),
        ]);
        expect(useChatTabsStore.getState().activeTabId).toBe("tab-a");
    });
});
