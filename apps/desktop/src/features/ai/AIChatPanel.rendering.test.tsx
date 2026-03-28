import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { renderComponent } from "../../test/test-utils";
import type { AIChatSession, AIRuntimeDescriptor } from "./types";
import { AIChatPanel } from "./AIChatPanel";
import { resetChatStore, useChatStore } from "./store/chatStore";
import {
    markChatTabsReady,
    resetChatTabsStore,
    useChatTabsStore,
} from "./store/chatTabsStore";

let messageListRenderCount = 0;
let composerRenderCount = 0;

vi.mock("./api", () => {
    const noop = async () => () => {};
    return {
        listenToAiAvailableCommandsUpdated: noop,
        listenToAiMessageCompleted: noop,
        listenToAiMessageDelta: noop,
        listenToAiMessageStarted: noop,
        listenToAiPlanUpdated: noop,
        listenToAiPermissionRequest: noop,
        listenToAiRuntimeConnection: noop,
        listenToAiSessionCreated: noop,
        listenToAiSessionError: noop,
        listenToAiSessionUpdated: noop,
        listenToAiStatusEvent: noop,
        listenToAiThinkingCompleted: noop,
        listenToAiThinkingDelta: noop,
        listenToAiThinkingStarted: noop,
        listenToAiToolActivity: noop,
        listenToAiUserInputRequest: noop,
    };
});

vi.mock("./components/AIChatHeader", () => ({
    AIChatHeader: () => <div data-testid="chat-header" />,
}));

vi.mock("./components/AIChatRuntimeBanner", () => ({
    AIChatRuntimeBanner: () => <div data-testid="runtime-banner" />,
}));

vi.mock("./components/AIChatMessageList", () => ({
    AIChatMessageList: ({ messages }: { messages: unknown[] }) => {
        messageListRenderCount += 1;
        return <div data-testid="message-list">{messages.length}</div>;
    },
}));

vi.mock("./components/EditedFilesBufferPanel", () => ({
    EditedFilesBufferPanel: () => <div data-testid="edited-files-buffer" />,
}));

vi.mock("./components/QueuedMessagesPanel", () => ({
    QueuedMessagesPanel: () => <div data-testid="queued-messages" />,
}));

vi.mock("./components/AIChatComposer", () => ({
    AIChatComposer: ({ parts }: { parts: unknown[] }) => {
        composerRenderCount += 1;
        return <div data-testid="chat-composer">{parts.length}</div>;
    },
}));

vi.mock("./components/AIChatContextBar", () => ({
    AIChatContextBar: () => <div data-testid="context-bar" />,
}));

vi.mock("./components/AIChatAgentControls", () => ({
    AIChatAgentControls: () => <div data-testid="agent-controls" />,
}));

vi.mock("./components/AIAuthTerminalModal", () => ({
    AIAuthTerminalModal: () => null,
}));

const runtimeDescriptor: AIRuntimeDescriptor = {
    runtime: {
        id: "codex-acp",
        name: "Codex ACP",
        description: "Codex runtime",
        capabilities: [],
    },
    models: [],
    modes: [],
    configOptions: [],
};

function createSession(
    sessionId: string,
    title: string,
    overrides: Partial<AIChatSession> = {},
): AIChatSession {
    return {
        sessionId,
        historySessionId: sessionId,
        status: "idle",
        runtimeId: "codex-acp",
        modelId: "test-model",
        modeId: "default",
        models: [],
        modes: [],
        configOptions: [],
        messages: [
            {
                id: `${sessionId}-message`,
                role: "user",
                kind: "text",
                content: title,
                timestamp: 1,
            },
        ],
        attachments: [],
        activeWorkCycleId: null,
        visibleWorkCycleId: null,
        runtimeState: "live",
        ...overrides,
    };
}

describe("AIChatPanel rendering", () => {
    beforeEach(() => {
        messageListRenderCount = 0;
        composerRenderCount = 0;
        resetChatStore();
        resetChatTabsStore();
        markChatTabsReady();
        useVaultStore.setState({ vaultPath: "/vault", notes: [], entries: [] });
        useEditorStore.setState({
            tabs: [],
            activeTabId: null,
            activationHistory: [],
            tabNavigationHistory: [],
            tabNavigationIndex: -1,
            pendingReveal: null,
            pendingSelectionReveal: null,
            currentSelection: null,
        });
    });

    it("does not rerender the visible body when an inactive session updates", () => {
        const sessionA = createSession("session-a", "Active session");
        const sessionB = createSession("session-b", "Background session");

        useChatStore.setState((state) => ({
            ...state,
            runtimes: [runtimeDescriptor],
            sessionsById: {
                [sessionA.sessionId]: sessionA,
                [sessionB.sessionId]: sessionB,
            },
            sessionOrder: [sessionA.sessionId, sessionB.sessionId],
            activeSessionId: sessionA.sessionId,
            composerPartsBySessionId: {
                [sessionA.sessionId]: [
                    {
                        id: "draft-a",
                        type: "text",
                        text: "draft-a",
                    },
                ],
                [sessionB.sessionId]: [
                    {
                        id: "draft-b",
                        type: "text",
                        text: "draft-b",
                    },
                ],
            },
        }));
        useChatTabsStore.setState({
            tabs: [{ id: "tab-a", sessionId: sessionA.sessionId }],
            activeTabId: "tab-a",
            isReady: true,
        });

        renderComponent(<AIChatPanel />);

        const initialMessageListRenderCount = messageListRenderCount;
        const initialComposerRenderCount = composerRenderCount;

        act(() => {
            useChatStore.setState((state) => ({
                ...state,
                sessionsById: {
                    ...state.sessionsById,
                    [sessionB.sessionId]: {
                        ...state.sessionsById[sessionB.sessionId]!,
                        messages: [
                            ...state.sessionsById[sessionB.sessionId]!.messages,
                            {
                                id: "session-b-update",
                                role: "assistant",
                                kind: "text",
                                content: "new background message",
                                timestamp: 2,
                            },
                        ],
                    },
                },
            }));
        });

        expect(messageListRenderCount).toBe(initialMessageListRenderCount);
        expect(composerRenderCount).toBe(initialComposerRenderCount);

        act(() => {
            useChatStore.setState((state) => ({
                ...state,
                sessionsById: {
                    ...state.sessionsById,
                    [sessionA.sessionId]: {
                        ...state.sessionsById[sessionA.sessionId]!,
                        messages: [
                            ...state.sessionsById[sessionA.sessionId]!.messages,
                            {
                                id: "session-a-update",
                                role: "assistant",
                                kind: "text",
                                content: "new active message",
                                timestamp: 2,
                            },
                        ],
                    },
                },
            }));
        });

        expect(messageListRenderCount).toBeGreaterThan(
            initialMessageListRenderCount,
        );
        expect(composerRenderCount).toBeGreaterThan(initialComposerRenderCount);
    });
});
