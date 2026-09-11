import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLayoutStore } from "../../app/store/layoutStore";
import { useEditorStore } from "../../app/store/editorStore";
import { resetChatStore, useChatStore } from "./store/chatStore";
import { resetChatTabsStore, useChatTabsStore } from "./store/chatTabsStore";
import { handleChatPaneShortcut } from "./useChatPaneShortcuts";
import type { AIChatSession } from "./types";

const key = (name: string, extra = {}) =>
    new KeyboardEvent("keydown", { key: name, cancelable: true, ...extra });
describe("chat surface shortcuts", () => {
    beforeEach(() => {
        resetChatStore();
        resetChatTabsStore();
        useLayoutStore.setState({ chatPaneVisible: true });
        useEditorStore.getState().hydrateTabs([], null);
        useEditorStore.getState().openNote("note", "Note", "Keep");
        useChatTabsStore.getState().showConversation("session");
        useChatStore.setState({
            sessionsById: {
                session: {
                    sessionId: "session",
                    status: "streaming",
                } as AIChatSession,
            },
            stopStreaming: vi.fn(),
        });
    });
    it("stops only the focused chat and respects previously handled Escape", () => {
        handleChatPaneShortcut(key("Escape"));
        expect(useChatStore.getState().stopStreaming).toHaveBeenCalledWith(
            "session",
        );
        vi.mocked(useChatStore.getState().stopStreaming).mockClear();
        const handled = key("Escape");
        handled.preventDefault();
        handleChatPaneShortcut(handled);
        useChatTabsStore.getState().setFocusedSurface("editor");
        handleChatPaneShortcut(key("Escape"));
        expect(useChatStore.getState().stopStreaming).not.toHaveBeenCalled();
    });
    it("hides chat with close without closing a document or cancelling the turn", () => {
        const before = useEditorStore.getState().panes;
        handleChatPaneShortcut(key("w", { ctrlKey: true }));
        expect(useLayoutStore.getState().chatPaneVisible).toBe(false);
        expect(useEditorStore.getState().panes).toBe(before);
        expect(useChatStore.getState().stopStreaming).not.toHaveBeenCalled();
    });
    it("returns from history without closing the editor", () => {
        useChatTabsStore.getState().showHistory();
        handleChatPaneShortcut(key("Escape"));
        expect(useChatTabsStore.getState().view).toEqual({
            mode: "conversation",
            sessionId: "session",
        });
        expect(useEditorStore.getState().tabs[0].title).toBe("Note");
        expect(useChatStore.getState().stopStreaming).not.toHaveBeenCalled();
    });
});
