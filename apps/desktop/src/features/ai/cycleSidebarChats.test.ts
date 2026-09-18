import { beforeEach, describe, expect, it, vi } from "vitest";
import { cycleFocusedWorkspaceTabs } from "./cycleSidebarChats";
import { openChatSessionInWorkspace } from "./chatPaneMovement";
import { useChatStore } from "./store/chatStore";
import { useChatTabsStore } from "./store/chatTabsStore";
import { usePinnedChatsStore } from "./store/pinnedChatsStore";
import { useArchivedChatsStore } from "./store/archivedChatsStore";
import { useEditorStore } from "../../app/store/editorStore";
import type { AIChatSession } from "./types";

vi.mock("./chatPaneMovement", () => ({ openChatSessionInWorkspace: vi.fn() }));
const session = (id: string, parentSessionId?: string) => ({ sessionId: id, historySessionId: id, parentSessionId, runtimeId: "codex-acp", modelId: "test", modeId: "default", models: [], modes: [], configOptions: [], attachments: [], messages: [], status: "idle", customTitle: id } as AIChatSession);

describe("focused workspace tab cycling", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        usePinnedChatsStore.setState({ entries: { pinned: { pinnedAt: 1 } } });
        useArchivedChatsStore.setState({ vaultPath: "/vault", entries: {} });
        useChatStore.setState({
            sessionOrder: ["child", "parent", "pinned", "last"],
            sessionsById: { child: session("child", "parent"), parent: session("parent"), pinned: session("pinned"), last: session("last") },
        });
        useChatTabsStore.getState().showConversation("pinned");
    });
    it("follows pinned and parent/child sidebar ordering in both directions", () => {
        cycleFocusedWorkspaceTabs(false);
        expect(openChatSessionInWorkspace).toHaveBeenLastCalledWith("parent");
        useChatTabsStore.getState().showConversation("parent");
        cycleFocusedWorkspaceTabs(false);
        expect(openChatSessionInWorkspace).toHaveBeenLastCalledWith("child");
        useChatTabsStore.getState().showConversation("pinned");
        cycleFocusedWorkspaceTabs(true);
        expect(openChatSessionInWorkspace).toHaveBeenLastCalledWith("last");
    });
    it("keeps archived chats separate from active chats", () => {
        useArchivedChatsStore.getState().archive("parent");
        cycleFocusedWorkspaceTabs(false);
        expect(openChatSessionInWorkspace).toHaveBeenLastCalledWith("last");
        useChatTabsStore.getState().showConversation("parent");
        cycleFocusedWorkspaceTabs(false);
        expect(openChatSessionInWorkspace).toHaveBeenLastCalledWith("child");
    });
    it("cycles editor tabs when the editor has focus without opening a chat", () => {
        useEditorStore.getState().hydrateTabs([], null);
        useEditorStore.getState().openNote("a", "A", "a");
        const first = useEditorStore.getState().activeTabId;
        useEditorStore.getState().openNote("b", "B", "b");
        const second = useEditorStore.getState().activeTabId;
        useChatTabsStore.getState().setFocusedSurface("editor");
        cycleFocusedWorkspaceTabs(false);
        expect(useEditorStore.getState().activeTabId).toBe(first);
        cycleFocusedWorkspaceTabs(true);
        expect(useEditorStore.getState().activeTabId).toBe(second);
        expect(openChatSessionInWorkspace).not.toHaveBeenCalled();
    });
});
