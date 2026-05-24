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
    ensureWorkspaceChatSession,
    openOrMoveChatSessionAtDropTarget,
} from "./chatPaneMovement";
import { resetChatStore, useChatStore } from "./store/chatStore";
import { resetChatTabsStore } from "./store/chatTabsStore";
import type { AIChatSession, AIRuntimeSetupStatus } from "./types";
import { CLAUDE_TERMINAL_RUNTIME_ID } from "./utils/runtimeMetadata";

const invokeMock = vi.mocked(invoke);
const AI_PREFS_KEY = "neverwrite.ai.preferences";

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

const claudeTerminalRuntimeDescriptor = {
    runtime: {
        id: CLAUDE_TERMINAL_RUNTIME_ID,
        name: "Claude Code",
        description: "Claude Code terminal pseudo-runtime",
        capabilities: ["create_session"],
    },
    models: [
        {
            id: "claude-code-terminal-model",
            runtimeId: CLAUDE_TERMINAL_RUNTIME_ID,
            name: "Claude Code",
            description: "Terminal runtime model placeholder",
        },
    ],
    modes: [
        {
            id: "default",
            runtimeId: CLAUDE_TERMINAL_RUNTIME_ID,
            name: "Default",
            description: "Default mode",
            disabled: false,
        },
    ],
    configOptions: [
        {
            id: "model",
            runtimeId: CLAUDE_TERMINAL_RUNTIME_ID,
            category: "model" as const,
            label: "Model",
            type: "select" as const,
            value: "claude-code-terminal-model",
            options: [
                {
                    value: "claude-code-terminal-model",
                    label: "Claude Code",
                },
            ],
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
    runtimeId = "codex-acp",
): AIChatSession {
    return {
        sessionId,
        historySessionId: sessionId,
        status: "idle",
        runtimeId,
        modelId: runtimeId === "claude-acp" ? "claude-model" : "test-model",
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
        localStorage.removeItem(AI_PREFS_KEY);
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
        localStorage.removeItem(AI_PREFS_KEY);
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

    it("inherits the focused workspace chat runtime before the selected runtime", async () => {
        useChatStore.setState((state) => ({
            ...state,
            runtimes: [runtimeDescriptor, claudeRuntimeDescriptor],
            selectedRuntimeId: "codex-acp",
            setupStatusByRuntimeId: {
                "codex-acp": readySetupStatusState,
                "claude-acp": {
                    ...readySetupStatusState,
                    runtimeId: "claude-acp",
                    authMethod: "claude-login",
                },
            },
        }));
        const claudeSession = createStoredSession(
            "claude-session-existing",
            "Claude chat",
            "claude-acp",
        );
        seedChatSessions(claudeSession);
        useEditorStore.getState().openChat(claudeSession.sessionId, {
            title: "Claude chat",
            paneId: "primary",
        });

        invokeMock.mockImplementation((command, args) => {
            if (command === "ai_get_setup_status") {
                expect(
                    (args as { runtimeId?: string } | undefined)?.runtimeId,
                ).toBe("claude-acp");
                return Promise.resolve({
                    ...setupStatusPayload,
                    runtime_id: "claude-acp",
                    auth_method: "claude-login",
                });
            }
            if (command === "ai_create_session") {
                expect(
                    (
                        args as
                            | { input?: { runtime_id?: string } }
                            | undefined
                    )?.input?.runtime_id,
                ).toBe("claude-acp");
                return Promise.resolve({
                    ...createdSessionPayload,
                    session_id: "claude-session-2",
                    runtime_id: "claude-acp",
                    model_id: "claude-model",
                    models: [
                        {
                            id: "claude-model",
                            runtime_id: "claude-acp",
                            name: "Claude Model",
                            description: "Model for tests",
                        },
                    ],
                    config_options: [
                        {
                            id: "model",
                            runtime_id: "claude-acp",
                            category: "model",
                            label: "Model",
                            type: "select",
                            value: "claude-model",
                            options: [
                                {
                                    value: "claude-model",
                                    label: "Claude Model",
                                },
                            ],
                        },
                    ],
                });
            }
            return Promise.reject(new Error(`Unexpected invoke: ${command}`));
        });

        const pendingSessionId = await createNewChatInWorkspace();
        expect(pendingSessionId).toMatch(/^pending:/);
        expect(
            useChatStore.getState().sessionsById[pendingSessionId!]?.runtimeId,
        ).toBe("claude-acp");

        await waitFor(() => {
            expect(
                useChatStore.getState().sessionsById["claude-session-2"],
            ).toBeDefined();
        });
    });

    it("uses an explicit default runtime before the focused workspace chat runtime", async () => {
        useChatStore.setState((state) => ({
            ...state,
            defaultRuntimeId: "codex-acp",
            runtimes: [runtimeDescriptor, claudeRuntimeDescriptor],
            selectedRuntimeId: "claude-acp",
            setupStatusByRuntimeId: {
                "codex-acp": readySetupStatusState,
                "claude-acp": {
                    ...readySetupStatusState,
                    runtimeId: "claude-acp",
                    authMethod: "claude-login",
                },
            },
        }));
        const claudeSession = createStoredSession(
            "claude-session-existing",
            "Claude chat",
            "claude-acp",
        );
        seedChatSessions(claudeSession);
        useEditorStore.getState().openChat(claudeSession.sessionId, {
            title: "Claude chat",
            paneId: "primary",
        });

        invokeMock.mockImplementation((command, args) => {
            if (command === "ai_get_setup_status") {
                expect(
                    (args as { runtimeId?: string } | undefined)?.runtimeId,
                ).toBe("codex-acp");
                return Promise.resolve(setupStatusPayload);
            }
            if (command === "ai_create_session") {
                expect(
                    (
                        args as
                            | { input?: { runtime_id?: string } }
                            | undefined
                    )?.input?.runtime_id,
                ).toBe("codex-acp");
                return Promise.resolve(createdSessionPayload);
            }
            return Promise.reject(new Error(`Unexpected invoke: ${command}`));
        });

        const pendingSessionId = await createNewChatInWorkspace();

        expect(pendingSessionId).toMatch(/^pending:/);
        expect(
            useChatStore.getState().sessionsById[pendingSessionId!]?.runtimeId,
        ).toBe("codex-acp");
    });

    it("does not create an ACP chat when the selected runtime is Claude Code terminal", async () => {
        useChatStore.setState((state) => ({
            ...state,
            runtimes: [runtimeDescriptor, claudeTerminalRuntimeDescriptor],
            selectedRuntimeId: CLAUDE_TERMINAL_RUNTIME_ID,
            setupStatusByRuntimeId: {
                "codex-acp": readySetupStatusState,
                [CLAUDE_TERMINAL_RUNTIME_ID]: {
                    ...readySetupStatusState,
                    runtimeId: CLAUDE_TERMINAL_RUNTIME_ID,
                    authMethod: "claude-code",
                },
            },
        }));
        const newSession = vi.spyOn(useChatStore.getState(), "newSession");
        const upsertSession = vi.spyOn(useChatStore.getState(), "upsertSession");
        const openChat = vi.spyOn(useEditorStore.getState(), "openChat");

        await expect(createNewChatInWorkspace()).resolves.toBeNull();

        expect(newSession).not.toHaveBeenCalled();
        expect(upsertSession).not.toHaveBeenCalled();
        expect(openChat).not.toHaveBeenCalled();
        expect(selectEditorWorkspaceTabs(useEditorStore.getState())).toEqual([]);
    });

    it("uses the selected native runtime over a stale Claude Code terminal preference", async () => {
        localStorage.setItem(
            AI_PREFS_KEY,
            JSON.stringify({ defaultRuntimeId: CLAUDE_TERMINAL_RUNTIME_ID }),
        );
        useChatStore.setState((state) => ({
            ...state,
            runtimes: [runtimeDescriptor, claudeTerminalRuntimeDescriptor],
            selectedRuntimeId: "codex-acp",
            setupStatusByRuntimeId: {
                "codex-acp": readySetupStatusState,
                [CLAUDE_TERMINAL_RUNTIME_ID]: {
                    ...readySetupStatusState,
                    runtimeId: CLAUDE_TERMINAL_RUNTIME_ID,
                    authMethod: "claude-code",
                },
            },
        }));
        const newSession = vi.spyOn(useChatStore.getState(), "newSession");
        const upsertSession = vi.spyOn(useChatStore.getState(), "upsertSession");
        const openChat = vi.spyOn(useEditorStore.getState(), "openChat");

        const sessionId = await createNewChatInWorkspace();

        expect(sessionId).toMatch(/^pending:/);
        expect(newSession).toHaveBeenCalledWith("codex-acp", sessionId);
        expect(upsertSession).toHaveBeenCalled();
        expect(openChat).toHaveBeenCalled();
    });

    it("does not create an ACP chat when Claude Code is the explicit default runtime", async () => {
        useChatStore.setState((state) => ({
            ...state,
            defaultRuntimeId: CLAUDE_TERMINAL_RUNTIME_ID,
            runtimes: [runtimeDescriptor, claudeTerminalRuntimeDescriptor],
            selectedRuntimeId: "codex-acp",
            setupStatusByRuntimeId: {
                "codex-acp": readySetupStatusState,
                [CLAUDE_TERMINAL_RUNTIME_ID]: {
                    ...readySetupStatusState,
                    runtimeId: CLAUDE_TERMINAL_RUNTIME_ID,
                    authMethod: "claude-code",
                },
            },
        }));
        const newSession = vi.spyOn(useChatStore.getState(), "newSession");
        const upsertSession = vi.spyOn(useChatStore.getState(), "upsertSession");
        const openChat = vi.spyOn(useEditorStore.getState(), "openChat");

        await expect(createNewChatInWorkspace()).resolves.toBeNull();

        expect(newSession).not.toHaveBeenCalled();
        expect(upsertSession).not.toHaveBeenCalled();
        expect(openChat).not.toHaveBeenCalled();
    });

    it("does not create a pending chat when Claude Code terminal is the only ready runtime", async () => {
        localStorage.setItem(
            AI_PREFS_KEY,
            JSON.stringify({ defaultRuntimeId: "missing-runtime" }),
        );
        useChatStore.setState((state) => ({
            ...state,
            runtimes: [claudeTerminalRuntimeDescriptor],
            selectedRuntimeId: null,
            setupStatusByRuntimeId: {
                [CLAUDE_TERMINAL_RUNTIME_ID]: {
                    ...readySetupStatusState,
                    runtimeId: CLAUDE_TERMINAL_RUNTIME_ID,
                    authMethod: "claude-code",
                },
            },
        }));
        const newSession = vi.spyOn(useChatStore.getState(), "newSession");
        const upsertSession = vi.spyOn(useChatStore.getState(), "upsertSession");
        const openChat = vi.spyOn(useEditorStore.getState(), "openChat");

        await expect(createNewChatInWorkspace()).resolves.toBeNull();

        expect(newSession).not.toHaveBeenCalled();
        expect(upsertSession).not.toHaveBeenCalled();
        expect(openChat).not.toHaveBeenCalled();
    });

    it("does not create an ACP chat when the active session uses Claude Code terminal", async () => {
        const terminalSession = createStoredSession(
            "claude-terminal-session",
            "Claude Code terminal",
            CLAUDE_TERMINAL_RUNTIME_ID,
        );
        seedChatSessions(terminalSession);
        useChatStore.setState((state) => ({
            ...state,
            activeSessionId: terminalSession.sessionId,
            lastFocusedSessionId: terminalSession.sessionId,
        }));
        const newSession = vi.spyOn(useChatStore.getState(), "newSession");
        const upsertSession = vi.spyOn(useChatStore.getState(), "upsertSession");
        const openChat = vi.spyOn(useEditorStore.getState(), "openChat");

        await expect(createNewChatInWorkspace()).resolves.toBeNull();

        expect(newSession).not.toHaveBeenCalled();
        expect(upsertSession).not.toHaveBeenCalled();
        expect(openChat).not.toHaveBeenCalled();
    });

    it("does not create an ACP chat when ensure is explicitly asked for Claude Code terminal", async () => {
        const newSession = vi.spyOn(useChatStore.getState(), "newSession");
        const upsertSession = vi.spyOn(useChatStore.getState(), "upsertSession");
        const openChat = vi.spyOn(useEditorStore.getState(), "openChat");

        await expect(
            ensureWorkspaceChatSession({
                runtimeId: CLAUDE_TERMINAL_RUNTIME_ID,
            }),
        ).resolves.toBeNull();

        expect(newSession).not.toHaveBeenCalled();
        expect(upsertSession).not.toHaveBeenCalled();
        expect(openChat).not.toHaveBeenCalled();
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
