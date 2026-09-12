import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { useVaultStore } from "../../../app/store/vaultStore";
import { useChatTabsStore } from "./chatTabsStore";
import { useUnreadChatsStore } from "./unreadChatsStore";

describe("unread completed turns", () => {
    beforeEach(() => {
        localStorage.clear();
        useVaultStore.setState({ vaultPath: "/unread-test" });
        useUnreadChatsStore.setState({ entries: {} });
        useChatTabsStore.setState({ view: { mode: "empty" }, focusedSurface: "chat" });
        vi.spyOn(document, "hasFocus").mockReturnValue(true);
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    });
    afterEach(() => vi.restoreAllMocks());

    it("marks a background completion unread and clears only the opened conversation", () => {
        useUnreadChatsStore.getState().markCompleted("parent");
        useUnreadChatsStore.getState().markCompleted("child");
        useChatTabsStore.getState().showConversation("parent");
        expect(useUnreadChatsStore.getState().entries).toEqual({ child: true });
        useChatTabsStore.getState().showConversation("child");
        expect(useUnreadChatsStore.getState().entries).toEqual({});
    });

    it("does not mark a completion unread while viewing the conversation", () => {
        useChatTabsStore.getState().showConversation("chat");
        useUnreadChatsStore.getState().markCompleted("chat");
        expect(useUnreadChatsStore.getState().entries).toEqual({});
    });

    it("keeps the selected chat unread while the window is unfocused", () => {
        useChatTabsStore.getState().showConversation("chat");
        vi.mocked(document.hasFocus).mockReturnValue(false);
        useUnreadChatsStore.getState().markCompleted("chat");
        expect(useUnreadChatsStore.getState().entries).toEqual({ chat: true });
        vi.mocked(document.hasFocus).mockReturnValue(true);
        window.dispatchEvent(new Event("focus"));
        expect(useUnreadChatsStore.getState().entries).toEqual({});
    });

    it("waits for chat focus when the editor has focus", () => {
        useChatTabsStore.getState().showConversation("chat");
        useChatTabsStore.getState().setFocusedSurface("editor");
        useUnreadChatsStore.getState().markCompleted("chat");
        expect(useUnreadChatsStore.getState().entries).toEqual({ chat: true });
        useChatTabsStore.getState().setFocusedSurface("chat");
        expect(useUnreadChatsStore.getState().entries).toEqual({});
    });

    it("persists per vault and preserves unread state across session replacement", () => {
        useUnreadChatsStore.getState().markCompleted("old");
        useUnreadChatsStore.getState().replaceSessionId("old", "new");
        useVaultStore.setState({ vaultPath: "/other-unread-test" });
        expect(useUnreadChatsStore.getState().entries).toEqual({});
        useVaultStore.setState({ vaultPath: "/unread-test" });
        expect(useUnreadChatsStore.getState().entries).toEqual({ new: true });
        useUnreadChatsStore.getState().markRead("new");
        useVaultStore.setState({ vaultPath: "/other-unread-test" });
        useVaultStore.setState({ vaultPath: "/unread-test" });
        expect(useUnreadChatsStore.getState().entries).toEqual({});
    });
});
