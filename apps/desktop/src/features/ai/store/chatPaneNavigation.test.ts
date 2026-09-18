import { beforeEach, describe, expect, it } from "vitest";
import { resetChatTabsStore, useChatTabsStore } from "./chatTabsStore";

describe("chat pane navigation", () => {
    beforeEach(() => resetChatTabsStore());
    it("keeps transcript inspection separate from the return conversation", () => {
        const nav = useChatTabsStore.getState();
        nav.showConversation("one");
        nav.showHistory();
        nav.selectHistoryEntry("history-two");
        expect(useChatTabsStore.getState().view).toEqual({ mode: "history", returnSessionId: "one", selectedHistorySessionId: "history-two" });
        nav.returnFromHistory(["one"]);
        expect(useChatTabsStore.getState().view).toEqual({ mode: "conversation", sessionId: "one" });
    });
    it("does not revive deleted or superseded return selections", () => {
        const nav = useChatTabsStore.getState();
        nav.showConversation("one");
        nav.showHistory();
        nav.removeTabsForSession("one");
        nav.returnFromHistory([]);
        expect(useChatTabsStore.getState().view).toEqual({ mode: "empty" });
        nav.showConversation("two");
        nav.returnFromHistory(["one", "two"]);
        expect(useChatTabsStore.getState().view).toEqual({ mode: "conversation", sessionId: "two" });
    });
    it("rebinds a pending selection without changing editor focus", () => {
        const nav = useChatTabsStore.getState();
        nav.showConversation("pending:one");
        nav.setFocusedSurface("editor");
        nav.replaceSessionId("pending:one", "real", "durable");
        expect(useChatTabsStore.getState().view).toEqual({ mode: "conversation", sessionId: "real" });
        expect(useChatTabsStore.getState().focusedSurface).toBe("editor");
        nav.showHistory();
        nav.replaceSessionId("real", "new-binding", "durable");
        nav.returnFromHistory(["new-binding"]);
        expect(useChatTabsStore.getState().view).toEqual({ mode: "conversation", sessionId: "new-binding" });
    });
});
