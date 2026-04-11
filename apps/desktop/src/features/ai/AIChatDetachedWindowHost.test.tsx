import { beforeEach, describe, expect, it, vi } from "vitest";
import { AIChatDetachedWindowHost } from "./AIChatDetachedWindowHost";
import { renderComponent, flushPromises } from "../../test/test-utils";
import { resetChatStore, useChatStore } from "./store/chatStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { useEditorStore } from "../../app/store/editorStore";

vi.mock("./useAiChatEventBridge", () => ({
    useAiChatEventBridge: () => {},
}));

describe("AIChatDetachedWindowHost", () => {
    beforeEach(() => {
        resetChatStore();
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
            entries: [],
        });
    });

    it("initializes detached chat support without auto-creating a default session and loads the active chat", async () => {
        useEditorStore.getState().hydrateTabs(
            [
                {
                    id: "chat-tab-1",
                    kind: "ai-chat",
                    sessionId: "session-1",
                    title: "Chat",
                },
            ],
            "chat-tab-1",
        );

        const initialize = vi.fn().mockResolvedValue(undefined);
        const loadSession = vi.fn().mockResolvedValue(undefined);
        useChatStore.setState({
            initialize,
            loadSession,
        } as Partial<ReturnType<typeof useChatStore.getState>>);

        renderComponent(<AIChatDetachedWindowHost />);
        await flushPromises();

        expect(initialize).toHaveBeenCalledWith({
            createDefaultSession: false,
        });
        expect(loadSession).toHaveBeenCalledWith("session-1");
    });

    it("does not reload a live detached chat session", async () => {
        useEditorStore.getState().hydrateTabs(
            [
                {
                    id: "chat-tab-1",
                    kind: "ai-chat",
                    sessionId: "session-1",
                    title: "Chat",
                },
            ],
            "chat-tab-1",
        );

        const initialize = vi.fn().mockResolvedValue(undefined);
        const loadSession = vi.fn().mockResolvedValue(undefined);
        useChatStore.setState({
            initialize,
            loadSession,
            sessionsById: {
                "session-1": {
                    sessionId: "session-1",
                    runtimeState: "live",
                    isResumingSession: false,
                } as never,
            },
        } as Partial<ReturnType<typeof useChatStore.getState>>);

        renderComponent(<AIChatDetachedWindowHost />);
        await flushPromises();

        expect(initialize).toHaveBeenCalledWith({
            createDefaultSession: false,
        });
        expect(loadSession).not.toHaveBeenCalled();
    });
});
