import { beforeEach, describe, expect, it, vi } from "vitest";
import { useVaultStore } from "../../app/store/vaultStore";
import { useEditorStore, isChatTab, isChatHistoryTab } from "../../app/store/editorStore";
import { createChatTab, createChatHistoryTab } from "../../app/store/editorTabs";
import { resetChatTabsStore, readPersistedChatWorkspace, useChatTabsStore } from "./store/chatTabsStore";
import { preserveLegacyChatTabsForVault } from "./chatWorkspaceRestoration";
import { useArchivedChatsStore } from "./store/archivedChatsStore";
import * as storage from "../../app/utils/safeStorage";

const legacy = () => ({ ...createChatTab("runtime-b", "Second", "history-b"), history: [
    { sessionId: "runtime-a", historySessionId: "history-a", title: "First" },
    { sessionId: "runtime-b", historySessionId: "history-b", title: "Second" },
], historyIndex: 1 });

describe("dedicated chat migration", () => {
    beforeEach(() => {
        storage.safeStorageClear();
        useVaultStore.setState({ vaultPath: "/migration" });
        useArchivedChatsStore.setState({ vaultPath: "/migration", entries: {} });
        resetChatTabsStore();
        useEditorStore.getState().hydrateTabs([], null);
    });
    it("preserves every internal history entry and documents across repeated migration", () => {
        const chat = legacy();
        const note = { id: "note", noteId: "note", title: "Note", content: "Keep" };
        const panes = [{ id: "primary", tabs: [note], activeTabId: note.id }, { id: "secondary", tabs: [chat], activeTabId: chat.id }];
        useEditorStore.getState().hydrateWorkspace(panes, "secondary");
        expect(useEditorStore.getState().panes).toHaveLength(1);
        expect(useEditorStore.getState().tabs[0].title).toBe("Note");
        expect(useChatTabsStore.getState().view).toEqual({ mode: "conversation", sessionId: "runtime-b" });
        useEditorStore.getState().hydrateWorkspace(panes, "secondary");
        const saved = readPersistedChatWorkspace("/migration")!;
        expect(saved.version).toBe(2);
        expect(saved.tabs.map(tab => tab.historySessionId).sort()).toEqual(["history-a", "history-b"]);
        expect(saved.view).toEqual({ mode: "conversation", sessionId: "history-b" });
    });
    it("restores focused History and creates a valid empty editor for chat-only layouts", () => {
        const history = createChatHistoryTab();
        useEditorStore.getState().hydrateTabs([legacy(), history], history.id);
        expect(useEditorStore.getState().panes).toHaveLength(1);
        expect(useEditorStore.getState().tabs).toEqual([]);
        expect(useChatTabsStore.getState().view.mode).toBe("history");
        expect(readPersistedChatWorkspace("/migration")?.view).toEqual({ mode: "history", selectedHistorySessionId: null, returnSessionId: null });
    });
    it("does not choose archived fallbacks, and retains references when discovery is empty", () => {
        useArchivedChatsStore.getState().archive("history-a");
        useArchivedChatsStore.getState().archive("history-b");
        useEditorStore.getState().hydrateTabs([legacy()], null);
        expect(useChatTabsStore.getState().view.mode).toBe("empty");
        const saved = readPersistedChatWorkspace("/migration");
        useChatTabsStore.getState().restoreWorkspace(saved, []);
        expect(useChatTabsStore.getState().tabs).toHaveLength(2);
    });
    it("leaves the editor unchanged when migration persistence fails", () => {
        useEditorStore.getState().openNote("note", "Note", "Keep");
        const before = useEditorStore.getState().panes;
        const write = vi.spyOn(storage, "safeStorageSetItem").mockReturnValue(false);
        expect(() => useEditorStore.getState().hydrateTabs([legacy()], null)).toThrow("Could not preserve");
        expect(useEditorStore.getState().panes).toBe(before);
        write.mockRestore();
    });
    it("rejects generic chat insertions including split targets", () => {
        const editor = useEditorStore.getState();
        for (const tab of [legacy(), createChatHistoryTab()]) {
            editor.insertExternalTab(tab);
            editor.insertExternalTabInPane(tab, "primary");
            expect(editor.insertExternalTabInNewSplit(tab, "row", "primary")).toBeNull();
            expect(editor.insertExternalTabAtPaneDropTarget(tab, "primary", "right")).toBeNull();
        }
        expect(useEditorStore.getState().panes).toHaveLength(1);
        expect(useEditorStore.getState().tabs.some(tab => isChatTab(tab) || isChatHistoryTab(tab))).toBe(false);
    });
    it("preserves a detached payload in its source vault without mixing the current vault", () => {
        const tab = legacy();
        expect(preserveLegacyChatTabsForVault("/source", [tab], tab.id)).toBe(true);
        expect(readPersistedChatWorkspace("/source")?.tabs).toHaveLength(2);
        expect(readPersistedChatWorkspace("/migration")).toBeNull();
        expect(useChatTabsStore.getState().view.mode).toBe("empty");
    });
});
