import { beforeEach, describe, expect, it, vi } from "vitest";
import { AIChatDetachedWindowHost } from "./AIChatDetachedWindowHost";
import { AIChatWorkspaceHost } from "./AIChatWorkspaceHost";
import { renderComponent, flushPromises } from "../../test/test-utils";
import { resetChatStore, useChatStore } from "./store/chatStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { useEditorStore } from "../../app/store/editorStore";

const eventBridgeMock = vi.hoisted(() => vi.fn());

vi.mock("./useAiChatEventBridge", () => ({
    useAiChatEventBridge: eventBridgeMock,
}));

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

describe("AIChatDetachedWindowHost", () => {
    beforeEach(() => {
        resetChatStore();
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
            entries: [],
        });
        useEditorStore.getState().hydrateTabs([], null);
        eventBridgeMock.mockClear();
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

    it("waits for startup initialization before recovering the active chat", async () => {
        useEditorStore.getState().hydrateTabs(
            [
                {
                    id: "chat-tab-1",
                    kind: "ai-chat",
                    sessionId: "persisted:history-1",
                    historySessionId: "history-1",
                    title: "Chat",
                },
            ],
            "chat-tab-1",
        );

        const initialization = createDeferred<{
            sessionInventoryLoaded: boolean;
        }>();
        const initialize = vi.fn().mockReturnValue(initialization.promise);
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
        expect(loadSession).not.toHaveBeenCalled();

        initialization.resolve({ sessionInventoryLoaded: true });
        await flushPromises();
        await flushPromises();

        expect(loadSession).toHaveBeenCalledWith("persisted:history-1");
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

    it("keeps the main-window event bridge active before any chat tab mounts", () => {
        renderComponent(<AIChatWorkspaceHost listenWithoutChatTabs />);

        expect(eventBridgeMock).toHaveBeenCalledWith(true);
    });

    it("keeps detached windows quiet until they have a chat tab", () => {
        renderComponent(<AIChatDetachedWindowHost />);

        expect(eventBridgeMock).toHaveBeenCalledWith(false);
    });
});
