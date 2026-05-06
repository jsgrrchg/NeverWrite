import { invoke } from "@neverwrite/runtime";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    isChatTab,
    selectFocusedEditorTab,
    selectEditorWorkspaceTabs,
    useEditorStore,
} from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { createDeferred, setEditorTabs } from "../../test/test-utils";
import {
    createNewChatInWorkspace,
    openOrMoveChatSessionAtDropTarget,
} from "./chatPaneMovement";
import { resetChatStore, useChatStore } from "./store/chatStore";
import { resetChatTabsStore } from "./store/chatTabsStore";
import type { AIChatSession, AIRuntimeSetupStatus } from "./types";

const invokeMock = vi.mocked(invoke);

const runtimeDescriptor = {
    runtime: {
        id: "codex-acp",
        name: "Codex ACP",
        description: "Codex runtime",
        capabilities: ["create_session"],
    },
    models: [
        {
            id: "test-model",
            runtimeId: "codex-acp",
            name: "Test Model",
            description: "Model for tests",
        },
    ],
    modes: [
        {
            id: "default",
            runtimeId: "codex-acp",
            name: "Default",
            description: "Default mode",
            disabled: false,
        },
    ],
    configOptions: [
        {
            id: "model",
            runtimeId: "codex-acp",
            category: "model" as const,
            label: "Model",
            type: "select" as const,
            value: "test-model",
            options: [{ value: "test-model", label: "Test Model" }],
        },
    ],
};

const claudeRuntimeDescriptor = {
    runtime: {
        id: "claude-acp",
        name: "Claude ACP",
        description: "Claude runtime",
        capabilities: ["create_session"],
    },
    models: [
        {
            id: "claude-model",
            runtimeId: "claude-acp",
            name: "Claude Model",
            description: "Model for tests",
        },
    ],
    modes: [
        {
            id: "default",
            runtimeId: "claude-acp",
            name: "Default",
            description: "Default mode",
            disabled: false,
        },
    ],
    configOptions: [
        {
            id: "model",
            runtimeId: "claude-acp",
            category: "model" as const,
            label: "Model",
            type: "select" as const,
            value: "claude-model",
            options: [{ value: "claude-model", label: "Claude Model" }],
        },
    ],
};

const setupStatusPayload = {
    runtime_id: "codex-acp",
    binary_ready: true,
    binary_path: "/Applications/NeverWrite/codex-acp",
    binary_source: "bundled" as const,
    auth_ready: true,
    auth_method: "openai-api-key",
    auth_methods: [],
    onboarding_required: false,
    message: null,
};

const readySetupStatusState: AIRuntimeSetupStatus = {
    runtimeId: "codex-acp",
    binaryReady: true,
    binaryPath: "/Applications/NeverWrite/codex-acp",
    binarySource: "bundled",
    authReady: true,
    authMethod: "openai-api-key",
    authMethods: [],
    onboardingRequired: false,
};

const createdSessionPayload = {
    session_id: "codex-session-1",
    runtime_id: "codex-acp",
    model_id: "test-model",
    mode_id: "default",
    status: "idle" as const,
    efforts_by_model: {},
    models: [
        {
            id: "test-model",
            runtime_id: "codex-acp",
            name: "Test Model",
            description: "Model for tests",
        },
    ],
    modes: [
        {
            id: "default",
            runtime_id: "codex-acp",
            name: "Default",
            description: "Default mode",
            disabled: false,
        },
    ],
    config_options: [
        {
            id: "model",
            runtime_id: "codex-acp",
            category: "model",
            label: "Model",
            type: "select",
            value: "test-model",
            options: [{ value: "test-model", label: "Test Model" }],
        },
    ],
};

function createStoredSession(
    sessionId: string,
    title: string,
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
                timestamp: 100,
            },
        ],
        attachments: [],
        activeWorkCycleId: null,
        visibleWorkCycleId: null,
        isResumingSession: false,
        runtimeState: "live",
    };
}

function seedChatSessions(...sessions: AIChatSession[]) {
    useChatStore.setState((state) => ({
        ...state,
        sessionsById: Object.fromEntries(
            sessions.map((session) => [session.sessionId, session]),
        ),
        sessionOrder: sessions.map((session) => session.sessionId),
        loadSession: vi.fn(),
    }));
}

describe("createNewChatInWorkspace", () => {
    beforeEach(() => {
        resetChatStore();
        resetChatTabsStore();
        setEditorTabs([], null);
        useVaultStore.setState({ vaultPath: "/vault", notes: [], entries: [] });
        useChatStore.setState((state) => ({
            ...state,
            runtimes: [runtimeDescriptor],
            selectedRuntimeId: "codex-acp",
        }));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        resetChatStore();
        resetChatTabsStore();
        setEditorTabs([], null);
        useVaultStore.setState({ vaultPath: null, notes: [], entries: [] });
    });

    it("opens a pending chat tab immediately and swaps in the real session once creation finishes", async () => {
        const deferredSession = createDeferred<typeof createdSessionPayload>();
        invokeMock.mockImplementation((command) => {
            if (command === "ai_get_setup_status") {
                return Promise.resolve(setupStatusPayload);
            }
            if (command === "ai_create_session") {
                return deferredSession.promise;
            }
            return Promise.reject(new Error(`Unexpected invoke: ${command}`));
        });

        const pendingSessionId = await createNewChatInWorkspace("codex-acp");
        expect(pendingSessionId).toMatch(/^pending:/);

        const pendingSession =
            useChatStore.getState().sessionsById[pendingSessionId!];
        expect(pendingSession?.isPendingSessionCreation).toBe(true);

        const focusedPendingTab = selectFocusedEditorTab(useEditorStore.getState());
        expect(focusedPendingTab && isChatTab(focusedPendingTab)).toBe(true);
        if (!focusedPendingTab || !isChatTab(focusedPendingTab)) {
            throw new Error("Expected the focused tab to be the pending chat tab");
        }
        expect(focusedPendingTab.sessionId).toBe(pendingSessionId);

        deferredSession.resolve(createdSessionPayload);

        await waitFor(() => {
            expect(
                useChatStore.getState().sessionsById["codex-session-1"],
            ).toBeDefined();
        });

        expect(
            useChatStore.getState().sessionsById[pendingSessionId!],
        ).toBeUndefined();

        const focusedResolvedTab = selectFocusedEditorTab(useEditorStore.getState());
        expect(focusedResolvedTab && isChatTab(focusedResolvedTab)).toBe(true);
        if (!focusedResolvedTab || !isChatTab(focusedResolvedTab)) {
            throw new Error("Expected the focused tab to remain a chat tab");
        }
        expect(focusedResolvedTab.sessionId).toBe("codex-session-1");
    });

    it("uses the first configured runtime when the selected runtime still needs onboarding", async () => {
        useChatStore.setState((state) => ({
            ...state,
            runtimes: [runtimeDescriptor, claudeRuntimeDescriptor],
            selectedRuntimeId: "codex-acp",
            setupStatusByRuntimeId: {
                "codex-acp": {
                    ...readySetupStatusState,
                    authReady: false,
                    onboardingRequired: true,
                },
                "claude-acp": {
                    ...readySetupStatusState,
                    runtimeId: "claude-acp",
                    authMethod: "claude-login",
                },
            },
        }));

        invokeMock.mockImplementation((command) => {
            if (command === "ai_get_setup_status") {
                return Promise.resolve({
                    ...setupStatusPayload,
                    runtime_id: "claude-acp",
                    auth_method: "claude-login",
                });
            }
            if (command === "ai_create_session") {
                return Promise.resolve({
                    ...createdSessionPayload,
                    session_id: "claude-session-1",
                    runtime_id: "claude-acp",
                });
            }
            return Promise.reject(new Error(`Unexpected invoke: ${command}`));
        });

        const pendingSessionId = await createNewChatInWorkspace();
        expect(pendingSessionId).toMatch(/^pending:/);

        const pendingSession =
            useChatStore.getState().sessionsById[pendingSessionId!];
        expect(pendingSession?.runtimeId).toBe("claude-acp");
        expect(pendingSession?.modelId).toBe("claude-model");

        await waitFor(() => {
            expect(
                useChatStore.getState().sessionsById["claude-session-1"],
            ).toBeDefined();
        });
    });
});

describe("openOrMoveChatSessionAtDropTarget", () => {
    beforeEach(() => {
        resetChatStore();
        resetChatTabsStore();
        setEditorTabs([], null);
        useVaultStore.setState({ vaultPath: "/vault", notes: [], entries: [] });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        resetChatStore();
        resetChatTabsStore();
        setEditorTabs([], null);
        useVaultStore.setState({ vaultPath: null, notes: [], entries: [] });
    });

    it("opens a new chat at the requested pane strip index", () => {
        const alpha = createStoredSession("session-alpha", "Alpha");
        const beta = createStoredSession("session-beta", "Beta");
        seedChatSessions(alpha, beta);

        useEditorStore.getState().openChat(beta.sessionId, {
            title: "Beta",
            paneId: "primary",
        });

        openOrMoveChatSessionAtDropTarget(alpha.sessionId, {
            type: "strip",
            paneId: "primary",
            index: 0,
        });

        const pane = useEditorStore
            .getState()
            .panes.find((candidate) => candidate.id === "primary");
        expect(pane?.tabs.map((tab) => tab.title)).toEqual(["Alpha", "Beta"]);
        expect(pane?.activeTabId).toBe(pane?.tabs[0]?.id);
    });

    it("moves an existing chat to a split target without duplicating it", () => {
        const alpha = createStoredSession("session-alpha", "Alpha");
        const beta = createStoredSession("session-beta", "Beta");
        seedChatSessions(alpha, beta);

        useEditorStore.getState().openChat(alpha.sessionId, {
            title: "Alpha",
            paneId: "primary",
        });
        useEditorStore.getState().openChat(beta.sessionId, {
            title: "Beta",
            paneId: "primary",
            background: true,
        });

        openOrMoveChatSessionAtDropTarget(alpha.sessionId, {
            type: "split",
            paneId: "primary",
            direction: "right",
        });

        const chatTabs = selectEditorWorkspaceTabs(
            useEditorStore.getState(),
        ).filter(
            (tab) => isChatTab(tab) && tab.sessionId === alpha.sessionId,
        );
        expect(chatTabs).toHaveLength(1);
        expect(useEditorStore.getState().panes).toHaveLength(2);

        const focusedTab = selectFocusedEditorTab(useEditorStore.getState());
        expect(focusedTab && isChatTab(focusedTab)).toBe(true);
        if (!focusedTab || !isChatTab(focusedTab)) {
            throw new Error("Expected the moved chat to be focused");
        }
        expect(focusedTab.sessionId).toBe(alpha.sessionId);
    });
});
