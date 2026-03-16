import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../../app/store/editorStore";
import { useVaultStore } from "../../../app/store/vaultStore";
import { serializeComposerParts } from "../composerParts";
import type {
    AIChatAttachment,
    AIComposerPart,
    QueuedChatMessage,
} from "../types";
import { resetChatTabsStore, useChatTabsStore } from "./chatTabsStore";
import { flushDeltasSync, resetChatStore, useChatStore } from "./chatStore";

const invokeMock = vi.mocked(invoke);
const AI_PREFS_KEY = "vaultai.ai.preferences";

const runtimePayload = [
    {
        runtime: {
            id: "codex-acp",
            name: "Codex ACP",
            description: "Codex runtime embedded as an ACP sidecar.",
            capabilities: [
                "attachments",
                "permissions",
                "reasoning",
                "create_session",
                "user_input",
            ],
        },
        // Models, modes and config come from the ACP session, not the descriptor.
        models: [],
        modes: [],
        config_options: [],
    },
];

// Session payload simulates what the ACP returns at session creation time.
const acpModels = [
    {
        id: "test-model",
        runtime_id: "codex-acp",
        name: "Test Model",
        description: "A test model for unit tests.",
    },
];

const acpModes = [
    {
        id: "default",
        runtime_id: "codex-acp",
        name: "Default",
        description: "Prompt for actions that need explicit approval.",
        disabled: false,
    },
];

const acpConfigOptions = [
    {
        id: "model",
        runtime_id: "codex-acp",
        category: "model",
        label: "Model",
        type: "select",
        value: "test-model",
        options: [
            { value: "test-model", label: "Test Model" },
            { value: "wide-model", label: "Wide Model" },
        ],
    },
    {
        id: "reasoning_effort",
        runtime_id: "codex-acp",
        category: "reasoning",
        label: "Reasoning Effort",
        type: "select",
        value: "medium",
        options: [
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
        ],
    },
];

const sessionPayload = {
    session_id: "codex-session-1",
    runtime_id: "codex-acp",
    model_id: "test-model",
    mode_id: "default",
    status: "idle" as const,
    efforts_by_model: {
        "test-model": ["medium", "high"],
        "wide-model": ["low", "medium", "high", "xhigh"],
    },
    models: acpModels,
    modes: acpModes,
    config_options: acpConfigOptions,
};

const readySetupStatus = {
    runtime_id: "codex-acp",
    binary_ready: true,
    binary_path: "/Applications/VaultAI/codex-acp",
    binary_source: "bundled" as const,
    auth_ready: true,
    auth_method: "openai-api-key",
    auth_methods: [
        {
            id: "chatgpt",
            name: "ChatGPT account",
            description:
                "Sign in with your paid ChatGPT account to connect Codex.",
        },
        {
            id: "openai-api-key",
            name: "API key",
            description: "Use an OpenAI API key stored locally in VaultAI.",
        },
    ],
    onboarding_required: false,
    message: null,
};

const readySetupStatusState = {
    runtimeId: readySetupStatus.runtime_id,
    binaryReady: readySetupStatus.binary_ready,
    binaryPath: readySetupStatus.binary_path,
    binarySource: readySetupStatus.binary_source,
    authReady: readySetupStatus.auth_ready,
    authMethod: readySetupStatus.auth_method,
    authMethods: readySetupStatus.auth_methods,
    onboardingRequired: readySetupStatus.onboarding_required,
    message: readySetupStatus.message ?? undefined,
};

function getActiveSessionId(): string {
    const id = useChatStore.getState().activeSessionId;
    expect(id, "activeSessionId should not be null").not.toBeNull();
    return id!;
}

function createTextParts(text: string): AIComposerPart[] {
    return [
        {
            id: `part:${text}`,
            type: "text",
            text,
        },
    ];
}

function createQueuedMessage(
    id: string,
    text: string,
    overrides: Partial<QueuedChatMessage> = {},
): QueuedChatMessage {
    return {
        id,
        content: overrides.content ?? text,
        prompt: overrides.prompt ?? text,
        composerParts: overrides.composerParts ?? createTextParts(text),
        attachments: overrides.attachments ?? [],
        createdAt: overrides.createdAt ?? 1,
        status: overrides.status ?? "queued",
        modelId: overrides.modelId ?? "test-model",
        modeId: overrides.modeId ?? "default",
        optionsSnapshot: overrides.optionsSnapshot ?? {
            model: "test-model",
            reasoning_effort: "medium",
        },
        optimisticMessageId: overrides.optimisticMessageId,
    };
}

describe("chatStore", () => {
    beforeEach(() => {
        resetChatStore();
        resetChatTabsStore();
        vi.clearAllMocks();
        useVaultStore.setState({ vaultPath: null, notes: [] });
        useEditorStore.setState({
            tabs: [],
            activeTabId: null,
            activationHistory: [],
            tabNavigationHistory: [],
            tabNavigationIndex: -1,
            currentSelection: null,
        });

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_list_runtimes") {
                return runtimePayload;
            }

            if (command === "ai_create_session") {
                return sessionPayload;
            }

            if (command === "ai_list_sessions") {
                return [];
            }

            if (command === "ai_get_setup_status") {
                return readySetupStatus;
            }

            if (command === "ai_update_setup") {
                return readySetupStatus;
            }

            if (command === "ai_start_auth") {
                return readySetupStatus;
            }

            if (command === "ai_load_session") {
                return sessionPayload;
            }

            if (command === "ai_set_model") {
                return {
                    ...sessionPayload,
                    model_id: "test-model",
                };
            }

            if (command === "ai_set_config_option") {
                const input =
                    typeof args === "object" && args !== null && "input" in args
                        ? (args.input as {
                              option_id: string;
                              value: string;
                          })
                        : null;

                if (input?.option_id === "model") {
                    return {
                        ...sessionPayload,
                        model_id: input.value,
                        config_options: [
                            {
                                ...acpConfigOptions[0],
                                value: input.value,
                            },
                            {
                                ...acpConfigOptions[1],
                                value: "low",
                                options: [
                                    { value: "low", label: "Low" },
                                    { value: "medium", label: "Medium" },
                                    { value: "high", label: "High" },
                                    { value: "xhigh", label: "Extra High" },
                                ],
                            },
                        ],
                    };
                }

                return {
                    ...sessionPayload,
                    config_options: acpConfigOptions.map((option) =>
                        option.id === input?.option_id
                            ? { ...option, value: input.value }
                            : option,
                    ),
                };
            }

            if (command === "ai_send_message") {
                throw new Error("Codex ACP is unavailable.");
            }

            if (command === "ai_cancel_turn") {
                return {
                    ...sessionPayload,
                    status: "idle",
                };
            }

            if (command === "ai_respond_user_input") {
                return {
                    ...sessionPayload,
                    status: "streaming",
                };
            }

            if (command === "ai_load_session_histories") {
                return [];
            }

            return sessionPayload;
        });
    });

    it("loads the default edit diff zoom when no preference is stored", () => {
        expect(useChatStore.getState().editDiffZoom).toBe(0.72);
    });

    it("restores persisted edit diff zoom from AI preferences", () => {
        localStorage.setItem(
            AI_PREFS_KEY,
            JSON.stringify({
                editDiffZoom: 0.88,
            }),
        );

        resetChatStore();

        expect(useChatStore.getState().editDiffZoom).toBe(0.88);
    });

    it("persists edit diff zoom updates rounded to two decimals", () => {
        useChatStore.getState().setEditDiffZoom(0.823);

        expect(useChatStore.getState().editDiffZoom).toBe(0.82);
        expect(
            JSON.parse(localStorage.getItem(AI_PREFS_KEY) ?? "{}"),
        ).toMatchObject({
            editDiffZoom: 0.82,
        });
    });

    it("restores persisted AI font families from preferences", () => {
        localStorage.setItem(
            AI_PREFS_KEY,
            JSON.stringify({
                composerFontFamily: "serif",
                chatFontFamily: "typewriter",
            }),
        );

        resetChatStore();

        expect(useChatStore.getState().composerFontFamily).toBe("serif");
        expect(useChatStore.getState().chatFontFamily).toBe("typewriter");
    });

    it("normalizes invalid persisted AI font families back to system", () => {
        localStorage.setItem(
            AI_PREFS_KEY,
            JSON.stringify({
                composerFontFamily: "not-a-font",
                chatFontFamily: "also-bad",
            }),
        );

        resetChatStore();

        expect(useChatStore.getState().composerFontFamily).toBe("system");
        expect(useChatStore.getState().chatFontFamily).toBe("system");
    });

    it("persists AI font family updates", () => {
        useChatStore.getState().setComposerFontFamily("reading");
        useChatStore.getState().setChatFontFamily("rounded");

        expect(useChatStore.getState().composerFontFamily).toBe("reading");
        expect(useChatStore.getState().chatFontFamily).toBe("rounded");
        expect(
            JSON.parse(localStorage.getItem(AI_PREFS_KEY) ?? "{}"),
        ).toMatchObject({
            composerFontFamily: "reading",
            chatFontFamily: "rounded",
        });
    });

    it("loads runtimes and creates an initial session", async () => {
        await useChatStore.getState().initialize();

        const state = useChatStore.getState();
        expect(state.runtimeConnectionByRuntimeId["codex-acp"]?.status).toBe(
            "ready",
        );
        expect(state.runtimes).toHaveLength(1);
        expect(state.activeSessionId).toBe("codex-session-1");
        expect(state.sessionsById["codex-session-1"]?.runtimeId).toBe(
            "codex-acp",
        );
    });

    it("starts a new local work cycle when sending a message", async () => {
        await useChatStore.getState().initialize();
        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_send_message") {
                return {
                    ...sessionPayload,
                    status: "streaming",
                };
            }

            return sessionPayload;
        });

        const activeSessionId = getActiveSessionId();
        useChatStore.getState().setComposerParts(createTextParts("Ship it"));

        await useChatStore.getState().sendMessage();

        const session = useChatStore.getState().sessionsById[activeSessionId]!;
        const userMessage = session.messages.at(-1);

        expect(session.activeWorkCycleId).toBeTruthy();
        expect(session.visibleWorkCycleId).toBe(session.activeWorkCycleId);
        expect(userMessage?.workCycleId).toBe(session.activeWorkCycleId);
    });

    it("keeps the previous visible work cycle while its permission buffer is unresolved", async () => {
        await useChatStore.getState().initialize();
        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_send_message") {
                return {
                    ...sessionPayload,
                    status: "streaming",
                };
            }

            return sessionPayload;
        });

        const activeSessionId = getActiveSessionId();
        const session = useChatStore.getState().sessionsById[activeSessionId]!;

        useChatStore.setState({
            sessionsById: {
                ...useChatStore.getState().sessionsById,
                [activeSessionId]: {
                    ...session,
                    activeWorkCycleId: "cycle-old",
                    visibleWorkCycleId: "cycle-old",
                    messages: [
                        {
                            id: "permission:req-1",
                            role: "assistant",
                            kind: "permission",
                            content: "Edit watcher",
                            title: "Permission request",
                            timestamp: Date.now() - 1_000,
                            workCycleId: "cycle-old",
                            permissionRequestId: "req-1",
                            permissionOptions: [
                                {
                                    option_id: "allow_once",
                                    name: "Allow once",
                                    kind: "allow_once",
                                },
                            ],
                            diffs: [
                                {
                                    path: "/vault/src/watcher.rs",
                                    kind: "update",
                                    old_text: "old line",
                                    new_text: "new line",
                                },
                            ],
                            meta: {
                                status: "pending",
                                target: "/vault/src/watcher.rs",
                            },
                        },
                    ],
                },
            },
        });

        useChatStore
            .getState()
            .setComposerParts(createTextParts("Second turn"));
        await useChatStore.getState().sendMessage();

        const updatedSession =
            useChatStore.getState().sessionsById[activeSessionId]!;
        const userMessages = updatedSession.messages.filter(
            (message) => message.role === "user",
        );

        expect(updatedSession.activeWorkCycleId).toBeTruthy();
        expect(updatedSession.activeWorkCycleId).not.toBe("cycle-old");
        expect(updatedSession.visibleWorkCycleId).toBe("cycle-old");
        expect(userMessages.at(-1)?.workCycleId).toBe(
            updatedSession.activeWorkCycleId,
        );
    });

    it("clears the auth error banner when setup status becomes ready again", async () => {
        useChatStore.setState({
            runtimes: [
                {
                    runtime: { ...runtimePayload[0].runtime },
                    models: [],
                    modes: [],
                    configOptions: [],
                },
            ],
            runtimeConnectionByRuntimeId: {
                "codex-acp": {
                    status: "error",
                    message:
                        "You were signed out. Reconnect in AI setup to continue chatting.",
                },
            },
            setupStatusByRuntimeId: {
                "codex-acp": {
                    ...readySetupStatusState,
                    authReady: false,
                    onboardingRequired: true,
                },
            },
            selectedRuntimeId: "codex-acp",
        });

        await useChatStore.getState().refreshSetupStatus();

        expect(
            useChatStore.getState().runtimeConnectionByRuntimeId["codex-acp"],
        ).toEqual({
            status: "ready",
            message: null,
        });
    });

    it("clears the auth error banner after startAuth succeeds", async () => {
        useChatStore.setState({
            runtimes: [
                {
                    runtime: { ...runtimePayload[0].runtime },
                    models: [],
                    modes: [],
                    configOptions: [],
                },
            ],
            runtimeConnectionByRuntimeId: {
                "codex-acp": {
                    status: "error",
                    message:
                        "You were signed out. Reconnect in AI setup to continue chatting.",
                },
            },
            setupStatusByRuntimeId: {
                "codex-acp": {
                    ...readySetupStatusState,
                    authReady: false,
                    onboardingRequired: true,
                },
            },
            selectedRuntimeId: "codex-acp",
        });

        await useChatStore.getState().startAuth({ methodId: "openai-api-key" });

        expect(
            useChatStore.getState().runtimeConnectionByRuntimeId["codex-acp"],
        ).toEqual({
            status: "ready",
            message: null,
        });
    });

    it("opens the selected runtime after onboarding completes while another runtime is active", async () => {
        const claudeReadySetupStatus = {
            ...readySetupStatus,
            runtime_id: "claude-acp",
            auth_method: "claude-login",
        };
        const codexSession = {
            sessionId: "codex-session-1",
            historySessionId: "codex-session-1",
            runtimeId: "codex-acp",
            modelId: "test-model",
            modeId: "default",
            status: "idle" as const,
            models: [],
            modes: [],
            configOptions: [],
            messages: [],
            attachments: [],
            runtimeState: "live" as const,
        };

        useChatStore.setState((state) => ({
            ...state,
            runtimes: [
                {
                    runtime: runtimePayload[0].runtime,
                    models: [],
                    modes: [],
                    configOptions: [],
                },
                {
                    runtime: {
                        id: "claude-acp",
                        name: "Claude ACP",
                        description:
                            "Claude runtime embedded as an ACP sidecar.",
                        capabilities: [
                            "attachments",
                            "permissions",
                            "plans",
                            "create_session",
                        ],
                    },
                    models: [],
                    modes: [],
                    configOptions: [],
                },
            ],
            sessionsById: {
                [codexSession.sessionId]: codexSession,
            },
            sessionOrder: [codexSession.sessionId],
            activeSessionId: codexSession.sessionId,
            selectedRuntimeId: "claude-acp",
            setupStatusByRuntimeId: {
                "claude-acp": {
                    runtimeId: "claude-acp",
                    binaryReady: true,
                    binarySource: "bundled",
                    authReady: false,
                    authMethods: [
                        {
                            id: "claude-login",
                            name: "Claude login",
                            description:
                                "Open a terminal-based Claude login flow.",
                        },
                    ],
                    onboardingRequired: true,
                },
            },
        }));

        invokeMock.mockImplementation(async (command, payload) => {
            if (
                command === "ai_get_setup_status" &&
                (payload as { runtimeId?: string } | undefined)?.runtimeId ===
                    "claude-acp"
            ) {
                return claudeReadySetupStatus;
            }
            if (command === "ai_create_session") {
                return {
                    ...sessionPayload,
                    session_id: "claude-session-1",
                    runtime_id: "claude-acp",
                };
            }
            if (command === "ai_save_session_history") {
                return null;
            }
            throw new Error(`Unexpected command: ${String(command)}`);
        });

        await useChatStore.getState().refreshSetupStatus("claude-acp");

        expect(useChatStore.getState().activeSessionId).toBe(
            "claude-session-1",
        );
    });

    it("updates setup copy with the active runtime when authentication expires", () => {
        useChatStore.setState({
            runtimes: [
                {
                    runtime: { ...runtimePayload[0].runtime },
                    models: [],
                    modes: [],
                    configOptions: [],
                },
            ],
            setupStatusByRuntimeId: {
                "codex-acp": {
                    ...readySetupStatusState,
                    runtimeId: "codex-acp",
                },
            },
            sessionsById: {
                "codex-session-1": {
                    sessionId: "codex-session-1",
                    historySessionId: "codex-session-1",
                    runtimeId: "codex-acp",
                    modelId: "test-model",
                    modeId: "default",
                    status: "streaming",
                    models: [],
                    modes: [],
                    configOptions: [],
                    messages: [
                        {
                            id: "assistant-1",
                            role: "assistant",
                            kind: "text",
                            content: "Working",
                            timestamp: 10,
                            inProgress: true,
                        },
                    ],
                    attachments: [],
                    runtimeState: "live",
                },
            },
            selectedRuntimeId: "codex-acp",
        });

        useChatStore.getState().applySessionError({
            session_id: "codex-session-1",
            message: "authentication required",
        });

        expect(
            useChatStore.getState().setupStatusByRuntimeId["codex-acp"],
        ).toMatchObject({
            authReady: false,
            onboardingRequired: true,
            message: "You were signed out. Reconnect Codex to continue.",
        });
        expect(
            useChatStore.getState().sessionsById["codex-session-1"]?.messages[0]
                ?.inProgress,
        ).toBe(false);
    });

    it("treats the normalized signed-out message as an authentication error", () => {
        useChatStore.setState({
            runtimes: [
                {
                    runtime: {
                        ...runtimePayload[0].runtime,
                        id: "claude-acp",
                        name: "Claude ACP",
                    },
                    models: [],
                    modes: [],
                    configOptions: [],
                },
            ],
            setupStatusByRuntimeId: {
                "claude-acp": {
                    ...readySetupStatusState,
                    runtimeId: "claude-acp",
                },
            },
            sessionsById: {
                "claude-session-1": {
                    sessionId: "claude-session-1",
                    historySessionId: "claude-session-1",
                    runtimeId: "claude-acp",
                    modelId: "test-model",
                    modeId: "default",
                    status: "error",
                    models: [],
                    modes: [],
                    configOptions: [],
                    messages: [],
                    attachments: [],
                    runtimeState: "live",
                },
            },
            selectedRuntimeId: "claude-acp",
        });

        useChatStore.getState().applySessionError({
            session_id: "claude-session-1",
            message:
                "You were signed out. Reconnect in AI setup to continue chatting.",
        });

        expect(
            useChatStore.getState().setupStatusByRuntimeId["claude-acp"],
        ).toMatchObject({
            authReady: false,
            onboardingRequired: true,
            message: "You were signed out. Reconnect Claude to continue.",
        });
    });

    it("hydrates existing backend sessions before creating a new one", async () => {
        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_list_runtimes") {
                return runtimePayload;
            }

            if (command === "ai_list_sessions") {
                return [
                    {
                        ...sessionPayload,
                        session_id: "codex-session-existing",
                    },
                ];
            }

            if (command === "ai_create_session") {
                throw new Error("Should not create a new session");
            }

            if (command === "ai_get_setup_status") {
                return readySetupStatus;
            }

            if (command === "ai_load_session_histories") {
                return [];
            }

            return sessionPayload;
        });

        await useChatStore.getState().initialize();

        const state = useChatStore.getState();
        expect(state.activeSessionId).toBe("codex-session-existing");
        expect(state.sessionOrder).toEqual(["codex-session-existing"]);
    });

    it("stops before creating a session when onboarding is still required", async () => {
        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_list_runtimes") {
                return runtimePayload;
            }

            if (command === "ai_get_setup_status") {
                return {
                    ...readySetupStatus,
                    binary_ready: false,
                    auth_methods: readySetupStatus.auth_methods,
                    onboarding_required: true,
                };
            }

            if (command === "ai_create_session") {
                throw new Error(
                    "Should not create a session while onboarding is required",
                );
            }

            if (command === "ai_load_session_histories") {
                return [];
            }

            return [];
        });

        await useChatStore.getState().initialize();

        expect(useChatStore.getState().activeSessionId).toBeNull();
        expect(
            useChatStore.getState().setupStatusByRuntimeId["codex-acp"]
                ?.onboardingRequired,
        ).toBe(true);
    });

    it("prevents duplicate note attachments of the same type", async () => {
        await useChatStore.getState().initialize();

        const note = {
            id: "notes/runtime",
            title: "Runtime",
            path: "/vault/notes/runtime.md",
        };

        useChatStore.getState().attachNote(note);
        useChatStore.getState().attachNote(note);

        const activeSessionId = getActiveSessionId();
        expect(
            useChatStore.getState().sessionsById[activeSessionId]?.attachments,
        ).toHaveLength(1);
    });

    it("serializes mention parts into the current session draft", async () => {
        await useChatStore.getState().initialize();

        useChatStore.getState().setComposerParts([
            {
                id: "text-1",
                type: "text",
                text: "Use ",
            },
            {
                id: "mention-1",
                type: "mention",
                noteId: "README.md",
                label: "README.md",
                path: "/vault/README.md",
            },
        ]);

        const activeSessionId = getActiveSessionId();
        const parts =
            useChatStore.getState().composerPartsBySessionId[activeSessionId] ??
            [];

        expect(serializeComposerParts(parts)).toBe("Use [@README.md]");
    });

    it("moves the updated session to the top of the history order", async () => {
        await useChatStore.getState().initialize();

        useChatStore.getState().upsertSession(
            {
                sessionId: "codex-session-2",
                historySessionId: "codex-session-2",
                runtimeId: "codex-acp",
                modelId: "test-model",
                modeId: "default",
                status: "idle",
                models: acpModels.map((model) => ({
                    id: model.id,
                    runtimeId: model.runtime_id,
                    name: model.name,
                    description: model.description,
                })),
                modes: acpModes.map((mode) => ({
                    id: mode.id,
                    runtimeId: mode.runtime_id,
                    name: mode.name,
                    description: mode.description,
                    disabled: mode.disabled,
                })),
                configOptions: [],
                messages: [],
                attachments: [],
            },
            true,
        );

        useChatStore.getState().applyMessageStarted({
            session_id: "codex-session-1",
            message_id: "assistant-1",
        });

        expect(useChatStore.getState().sessionOrder).toEqual([
            "codex-session-1",
            "codex-session-2",
        ]);
    });

    it("switches the active session without losing the per-session draft", async () => {
        await useChatStore.getState().initialize();

        useChatStore.getState().upsertSession(
            {
                sessionId: "codex-session-2",
                historySessionId: "codex-session-2",
                runtimeId: "codex-acp",
                modelId: "test-model",
                modeId: "default",
                status: "idle",
                models: acpModels.map((model) => ({
                    id: model.id,
                    runtimeId: model.runtime_id,
                    name: model.name,
                    description: model.description,
                })),
                modes: acpModes.map((mode) => ({
                    id: mode.id,
                    runtimeId: mode.runtime_id,
                    name: mode.name,
                    description: mode.description,
                    disabled: mode.disabled,
                })),
                configOptions: [],
                messages: [],
                attachments: [],
            },
            true,
        );
        useChatStore.getState().setActiveSession("codex-session-1");

        useChatStore.getState().setComposerParts([
            {
                id: "draft-1",
                type: "text",
                text: "first draft",
            },
        ]);

        useChatStore.getState().setActiveSession("codex-session-2");
        useChatStore.getState().setComposerParts([
            {
                id: "draft-2",
                type: "text",
                text: "second draft",
            },
        ]);
        useChatStore.getState().setActiveSession("codex-session-1");

        expect(
            serializeComposerParts(
                useChatStore.getState().composerPartsBySessionId[
                    "codex-session-1"
                ] ?? [],
            ),
        ).toBe("first draft");
        expect(
            serializeComposerParts(
                useChatStore.getState().composerPartsBySessionId[
                    "codex-session-2"
                ] ?? [],
            ),
        ).toBe("second draft");
    });

    it("keeps drafts, attachments and agent events isolated between sessions", async () => {
        await useChatStore.getState().initialize();

        useChatStore.getState().upsertSession(
            {
                sessionId: "codex-session-2",
                historySessionId: "codex-session-2",
                runtimeId: "codex-acp",
                modelId: "test-model",
                modeId: "default",
                status: "idle",
                models: acpModels.map((model) => ({
                    id: model.id,
                    runtimeId: model.runtime_id,
                    name: model.name,
                    description: model.description,
                })),
                modes: acpModes.map((mode) => ({
                    id: mode.id,
                    runtimeId: mode.runtime_id,
                    name: mode.name,
                    description: mode.description,
                    disabled: mode.disabled,
                })),
                configOptions: [],
                messages: [],
                attachments: [],
            },
            true,
        );

        useChatStore.getState().setActiveSession("codex-session-1");
        useChatStore.getState().setComposerParts([
            {
                id: "draft-1",
                type: "text",
                text: "draft session 1",
            },
        ]);
        useChatStore.getState().attachNote({
            id: "notes/one",
            title: "Note One",
            path: "/vault/Note One.md",
        });

        useChatStore.getState().setActiveSession("codex-session-2");
        useChatStore.getState().setComposerParts([
            {
                id: "draft-2",
                type: "text",
                text: "draft session 2",
            },
        ]);
        useChatStore.getState().attachNote({
            id: "notes/two",
            title: "Note Two",
            path: "/vault/Note Two.md",
        });

        useChatStore.getState().applyMessageDelta({
            session_id: "codex-session-1",
            message_id: "assistant-1",
            delta: "response for session 1",
        });
        flushDeltasSync();

        const state = useChatStore.getState();

        expect(
            serializeComposerParts(
                state.composerPartsBySessionId["codex-session-1"] ?? [],
            ),
        ).toBe("draft session 1");
        expect(
            serializeComposerParts(
                state.composerPartsBySessionId["codex-session-2"] ?? [],
            ),
        ).toBe("draft session 2");

        expect(
            state.sessionsById["codex-session-1"]?.attachments.map(
                (attachment) => attachment.label,
            ),
        ).toEqual(["Note One"]);
        expect(
            state.sessionsById["codex-session-2"]?.attachments.map(
                (attachment) => attachment.label,
            ),
        ).toEqual(["Note Two"]);

        expect(
            state.sessionsById["codex-session-1"]?.messages.at(-1)?.content,
        ).toBe("response for session 1");
        expect(state.sessionsById["codex-session-2"]?.messages).toHaveLength(0);
        expect(state.activeSessionId).toBe("codex-session-2");
    });

    it("loads a session from backend and promotes it to the top of the history", async () => {
        await useChatStore.getState().initialize();

        useChatStore.getState().upsertSession(
            {
                sessionId: "codex-session-2",
                historySessionId: "codex-session-2",
                runtimeId: "codex-acp",
                modelId: "test-model",
                modeId: "default",
                status: "idle",
                models: acpModels.map((model) => ({
                    id: model.id,
                    runtimeId: model.runtime_id,
                    name: model.name,
                    description: model.description,
                })),
                modes: acpModes.map((mode) => ({
                    id: mode.id,
                    runtimeId: mode.runtime_id,
                    name: mode.name,
                    description: mode.description,
                    disabled: mode.disabled,
                })),
                configOptions: [],
                messages: [],
                attachments: [],
            },
            true,
        );

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_list_runtimes") return runtimePayload;
            if (command === "ai_list_sessions") return [];
            if (command === "ai_load_session") {
                return {
                    ...sessionPayload,
                    session_id: (args as { sessionId: string }).sessionId,
                };
            }
            return sessionPayload;
        });

        await useChatStore.getState().loadSession("codex-session-2");

        expect(useChatStore.getState().activeSessionId).toBe("codex-session-2");
        expect(useChatStore.getState().sessionOrder[0]).toBe("codex-session-2");
    });

    it("adds the user message and turns the session into error when the runtime fails", async () => {
        await useChatStore.getState().initialize();

        useChatStore.getState().setComposerParts([
            {
                id: "text-1",
                type: "text",
                text: "Please rewrite this note",
            },
        ]);

        await useChatStore.getState().sendMessage();

        const activeSessionId = getActiveSessionId();
        const session = useChatStore.getState().sessionsById[activeSessionId]!;

        expect(session.status).toBe("error");
        expect(session.messages[0]?.role).toBe("user");
        expect(session.messages.at(-1)?.kind).toBe("error");
    });

    it("normalizes oversized context errors into a start-new-chat message", async () => {
        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_list_runtimes") return runtimePayload;
            if (command === "ai_create_session") return sessionPayload;
            if (command === "ai_list_sessions") return [];
            if (command === "ai_get_setup_status") return readySetupStatus;
            if (command === "ai_update_setup") return readySetupStatus;
            if (command === "ai_start_auth") return readySetupStatus;
            if (command === "ai_load_session") return sessionPayload;
            if (command === "ai_set_model") return sessionPayload;
            if (command === "ai_set_mode") return sessionPayload;
            if (command === "ai_set_config_option") return sessionPayload;
            if (command === "ai_send_message") {
                throw new Error(
                    'Internal error: {"codex_error_info":"other","message":"{\n  \\"type\\": \\"error\\",\n  \\"error\\": {\n    \\"type\\": \\"invalid_request_error\\",\n    \\"message\\": \\"[LargeStringParam] [input[2].content[0].text] [string_above_max_length] Invalid \'input[2].content[0].text\': string too long. Expected a string with maximum length 10485760, but got a string with length 14274669 instead.\\"\n  },\n  \\"status\\": 400\n}"}',
                );
            }
            if (command === "ai_cancel_turn") {
                return {
                    ...sessionPayload,
                    status: "idle",
                };
            }
            if (command === "ai_respond_user_input") {
                return {
                    ...sessionPayload,
                    status: "streaming",
                };
            }
            if (command === "ai_load_session_histories") return [];
            return sessionPayload;
        });

        await useChatStore.getState().initialize();

        useChatStore.getState().setComposerParts(createTextParts("hola"));
        await useChatStore.getState().sendMessage();

        const activeSessionId = getActiveSessionId();
        const session = useChatStore.getState().sessionsById[activeSessionId]!;

        expect(session.messages.at(-1)?.kind).toBe("error");
        expect(session.messages.at(-1)?.content).toBe(
            "This chat context grew too large to continue. Start a new chat and resend your last message.",
        );
    });

    it("queues a new turn while the session is waiting for permission", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        useChatStore.setState({
            sessionsById: {
                ...useChatStore.getState().sessionsById,
                [activeSessionId]: {
                    ...useChatStore.getState().sessionsById[activeSessionId]!,
                    status: "waiting_permission",
                    attachments: [
                        {
                            id: "file-1",
                            type: "file",
                            noteId: null,
                            label: "Scope.md",
                            path: null,
                            filePath: "/tmp/Scope.md",
                            mimeType: "text/markdown",
                            status: "ready",
                        },
                    ],
                },
            },
        });
        useChatStore.getState().setComposerParts([
            {
                id: "text-1",
                type: "text",
                text: "Queue this next",
            },
        ]);

        await useChatStore.getState().sendMessage();

        const state = useChatStore.getState();
        expect(
            invokeMock.mock.calls.filter(
                ([command]) => command === "ai_send_message",
            ),
        ).toHaveLength(0);
        expect(state.queuedMessagesBySessionId[activeSessionId]).toEqual([
            expect.objectContaining({
                content: "Queue this next",
                status: "queued",
                modelId: "test-model",
                modeId: "default",
                attachments: [
                    expect.objectContaining({
                        id: "file-1",
                        label: "Scope.md",
                    }),
                ],
            }),
        ]);
        expect(
            serializeComposerParts(
                state.composerPartsBySessionId[activeSessionId] ?? [],
            ),
        ).toBe("");
        expect(state.sessionsById[activeSessionId]?.attachments).toEqual([]);
    });

    it("clears the composer after sending immediately", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        useChatStore
            .getState()
            .setComposerParts(createTextParts("Send right away"));

        await useChatStore.getState().sendMessage();

        expect(
            serializeComposerParts(
                useChatStore.getState().composerPartsBySessionId[
                    activeSessionId
                ] ?? [],
            ),
        ).toBe("");
        expect(
            useChatStore
                .getState()
                .sessionsById[
                    activeSessionId
                ]?.messages.some((message) => message.role === "user" && message.content === "Send right away"),
        ).toBe(true);
    });

    it("drains the next queued message when the session returns to idle", async () => {
        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_list_runtimes") return runtimePayload;
            if (command === "ai_create_session") return sessionPayload;
            if (command === "ai_list_sessions") return [];
            if (command === "ai_get_setup_status") return readySetupStatus;
            if (command === "ai_update_setup") return readySetupStatus;
            if (command === "ai_start_auth") return readySetupStatus;
            if (command === "ai_load_session") return sessionPayload;
            if (command === "ai_set_model") return sessionPayload;
            if (command === "ai_set_mode") return sessionPayload;
            if (command === "ai_set_config_option") return sessionPayload;
            if (command === "ai_send_message") {
                return {
                    ...sessionPayload,
                    status: "streaming",
                };
            }
            if (command === "ai_cancel_turn") {
                return {
                    ...sessionPayload,
                    status: "idle",
                };
            }
            if (command === "ai_respond_user_input") {
                return {
                    ...sessionPayload,
                    status: "streaming",
                };
            }
            if (command === "ai_load_session_histories") return [];
            return sessionPayload;
        });

        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        useChatStore.setState({
            sessionsById: {
                ...useChatStore.getState().sessionsById,
                [activeSessionId]: {
                    ...useChatStore.getState().sessionsById[activeSessionId]!,
                    status: "streaming",
                },
            },
        });
        useChatStore.getState().setComposerParts([
            {
                id: "text-1",
                type: "text",
                text: "Send after this turn",
            },
        ]);

        await useChatStore.getState().sendMessage();

        expect(
            useChatStore.getState().queuedMessagesBySessionId[activeSessionId],
        ).toHaveLength(1);

        useChatStore.getState().applyMessageCompleted({
            session_id: activeSessionId,
            message_id: "assistant-1",
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(
            invokeMock.mock.calls.some(
                ([command, payload]) =>
                    command === "ai_send_message" &&
                    typeof payload === "object" &&
                    payload !== null &&
                    "content" in payload &&
                    payload.content === "Send after this turn",
            ),
        ).toBe(true);
        expect(
            useChatStore.getState().queuedMessagesBySessionId[activeSessionId],
        ).toBeUndefined();
        expect(
            useChatStore
                .getState()
                .sessionsById[
                    activeSessionId
                ]?.messages.some((message) => message.role === "user" && message.content === "Send after this turn"),
        ).toBe(true);
    });

    it("retries a failed queued message without duplicating the user turn", async () => {
        let sendAttempts = 0;
        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_list_runtimes") return runtimePayload;
            if (command === "ai_create_session") return sessionPayload;
            if (command === "ai_list_sessions") return [];
            if (command === "ai_get_setup_status") return readySetupStatus;
            if (command === "ai_update_setup") return readySetupStatus;
            if (command === "ai_start_auth") return readySetupStatus;
            if (command === "ai_load_session") return sessionPayload;
            if (command === "ai_set_model") return sessionPayload;
            if (command === "ai_set_mode") return sessionPayload;
            if (command === "ai_set_config_option") return sessionPayload;
            if (command === "ai_send_message") {
                sendAttempts += 1;
                if (sendAttempts === 1) {
                    throw new Error("Temporary send failure.");
                }
                return {
                    ...sessionPayload,
                    status: "streaming",
                };
            }
            if (command === "ai_cancel_turn") {
                return {
                    ...sessionPayload,
                    status: "idle",
                };
            }
            if (command === "ai_respond_user_input") {
                return {
                    ...sessionPayload,
                    status: "streaming",
                };
            }
            if (command === "ai_load_session_histories") return [];
            return sessionPayload;
        });

        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        useChatStore.setState({
            sessionsById: {
                ...useChatStore.getState().sessionsById,
                [activeSessionId]: {
                    ...useChatStore.getState().sessionsById[activeSessionId]!,
                    status: "streaming",
                },
            },
        });
        useChatStore.getState().setComposerParts([
            {
                id: "text-1",
                type: "text",
                text: "Retry me once",
            },
        ]);

        await useChatStore.getState().sendMessage();
        useChatStore.getState().applyMessageCompleted({
            session_id: activeSessionId,
            message_id: "assistant-1",
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        const failedItem =
            useChatStore.getState().queuedMessagesBySessionId[
                activeSessionId
            ]?.[0];
        expect(failedItem?.status).toBe("failed");

        await useChatStore
            .getState()
            .retryQueuedMessage(activeSessionId, failedItem!.id);
        await new Promise((resolve) => setTimeout(resolve, 0));

        const session = useChatStore.getState().sessionsById[activeSessionId]!;
        expect(
            session.messages.filter(
                (message) =>
                    message.role === "user" &&
                    message.content === "Retry me once",
            ),
        ).toHaveLength(1);
        expect(
            useChatStore.getState().queuedMessagesBySessionId[activeSessionId],
        ).toBeUndefined();
        expect(sendAttempts).toBe(2);
    });

    it("prioritizes a queued message when sending it now", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        useChatStore.setState({
            sessionsById: {
                ...useChatStore.getState().sessionsById,
                [activeSessionId]: {
                    ...useChatStore.getState().sessionsById[activeSessionId]!,
                    status: "streaming",
                },
            },
        });

        useChatStore
            .getState()
            .enqueueMessage(
                activeSessionId,
                createQueuedMessage("queued-1", "First"),
            );
        useChatStore
            .getState()
            .enqueueMessage(
                activeSessionId,
                createQueuedMessage("queued-2", "Second"),
            );
        await useChatStore
            .getState()
            .sendQueuedMessageNow(activeSessionId, "queued-2");

        expect(
            useChatStore
                .getState()
                .queuedMessagesBySessionId[
                    activeSessionId
                ]?.map((item) => item.id),
        ).toEqual(["queued-2", "queued-1"]);
    });

    it("moves a queued message into the composer and restores the previous draft on cancel", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        const currentDraft = createTextParts("Current draft");
        const currentAttachment: AIChatAttachment = {
            id: "current-file",
            type: "file",
            noteId: null,
            label: "Current.txt",
            path: null,
            filePath: "/tmp/current.txt",
            mimeType: "text/plain",
            status: "ready",
        };
        const queuedAttachment: AIChatAttachment = {
            id: "queued-file",
            type: "file",
            noteId: null,
            label: "Queued.txt",
            path: null,
            filePath: "/tmp/queued.txt",
            mimeType: "text/plain",
            status: "ready",
        };

        useChatStore.setState((state) => ({
            composerPartsBySessionId: {
                ...state.composerPartsBySessionId,
                [activeSessionId]: currentDraft,
            },
            sessionsById: {
                ...state.sessionsById,
                [activeSessionId]: {
                    ...state.sessionsById[activeSessionId]!,
                    attachments: [currentAttachment],
                },
            },
        }));
        useChatStore.getState().enqueueMessage(
            activeSessionId,
            createQueuedMessage("queued-1", "Queued draft", {
                attachments: [queuedAttachment],
            }),
        );

        useChatStore.getState().editQueuedMessage(activeSessionId, "queued-1");

        expect(
            useChatStore.getState().queuedMessagesBySessionId[activeSessionId],
        ).toBeUndefined();
        expect(
            serializeComposerParts(
                useChatStore.getState().composerPartsBySessionId[
                    activeSessionId
                ] ?? [],
            ),
        ).toBe("Queued draft");
        expect(
            useChatStore.getState().sessionsById[activeSessionId]?.attachments,
        ).toEqual([queuedAttachment]);

        useChatStore.getState().cancelQueuedMessageEdit(activeSessionId);

        expect(
            useChatStore
                .getState()
                .queuedMessagesBySessionId[
                    activeSessionId
                ]?.map((item) => item.id),
        ).toEqual(["queued-1"]);
        expect(
            serializeComposerParts(
                useChatStore.getState().composerPartsBySessionId[
                    activeSessionId
                ] ?? [],
            ),
        ).toBe("Current draft");
        expect(
            useChatStore.getState().sessionsById[activeSessionId]?.attachments,
        ).toEqual([currentAttachment]);
    });

    it("keeps an edited message ahead of later items when canceling after the queue changes", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore
            .getState()
            .enqueueMessage(
                activeSessionId,
                createQueuedMessage("queued-1", "First"),
            );
        useChatStore
            .getState()
            .enqueueMessage(
                activeSessionId,
                createQueuedMessage("queued-2", "Second"),
            );
        useChatStore
            .getState()
            .enqueueMessage(
                activeSessionId,
                createQueuedMessage("queued-3", "Third"),
            );

        useChatStore.getState().editQueuedMessage(activeSessionId, "queued-2");
        useChatStore
            .getState()
            .removeQueuedMessage(activeSessionId, "queued-1");
        useChatStore.getState().cancelQueuedMessageEdit(activeSessionId);

        expect(
            useChatStore
                .getState()
                .queuedMessagesBySessionId[
                    activeSessionId
                ]?.map((item) => item.id),
        ).toEqual(["queued-2", "queued-3"]);
    });

    it("requeues an edited message ahead of later items when saving from the composer", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        const previousDraft = createTextParts("Side draft");
        const previousAttachment: AIChatAttachment = {
            id: "side-file",
            type: "file",
            noteId: null,
            label: "Side.txt",
            path: null,
            filePath: "/tmp/side.txt",
            mimeType: "text/plain",
            status: "ready",
        };

        useChatStore.setState((state) => ({
            composerPartsBySessionId: {
                ...state.composerPartsBySessionId,
                [activeSessionId]: previousDraft,
            },
            sessionsById: {
                ...state.sessionsById,
                [activeSessionId]: {
                    ...state.sessionsById[activeSessionId]!,
                    status: "waiting_permission",
                    attachments: [previousAttachment],
                },
            },
        }));

        useChatStore
            .getState()
            .enqueueMessage(
                activeSessionId,
                createQueuedMessage("queued-1", "First"),
            );
        useChatStore
            .getState()
            .enqueueMessage(
                activeSessionId,
                createQueuedMessage("queued-2", "Second"),
            );
        useChatStore
            .getState()
            .enqueueMessage(
                activeSessionId,
                createQueuedMessage("queued-3", "Third"),
            );

        useChatStore.getState().editQueuedMessage(activeSessionId, "queued-2");
        useChatStore
            .getState()
            .removeQueuedMessage(activeSessionId, "queued-1");
        useChatStore
            .getState()
            .setComposerParts(createTextParts("Second updated"));

        await useChatStore.getState().sendMessage();

        expect(
            useChatStore
                .getState()
                .queuedMessagesBySessionId[
                    activeSessionId
                ]?.map((item) => item.id),
        ).toEqual(["queued-2", "queued-3"]);
        expect(
            useChatStore.getState().queuedMessagesBySessionId[
                activeSessionId
            ]?.[0]?.content,
        ).toBe("Second updated");
        expect(
            serializeComposerParts(
                useChatStore.getState().composerPartsBySessionId[
                    activeSessionId
                ] ?? [],
            ),
        ).toBe("Side draft");
        expect(
            useChatStore.getState().sessionsById[activeSessionId]?.attachments,
        ).toEqual([previousAttachment]);
        expect(
            useChatStore.getState().queuedMessageEditBySessionId[
                activeSessionId
            ],
        ).toBeUndefined();
    });

    it("returns the session to idle after a completed tool event with no active work left", async () => {
        vi.useFakeTimers();
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        const session = useChatStore.getState().sessionsById[activeSessionId]!;

        useChatStore.setState({
            sessionsById: {
                ...useChatStore.getState().sessionsById,
                [activeSessionId]: {
                    ...session,
                    status: "streaming",
                    messages: [
                        {
                            id: "user-1",
                            role: "user",
                            kind: "text",
                            content: "Open the file and fix it",
                            timestamp: Date.now() - 10,
                        },
                    ],
                },
            },
        });

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-1",
            title: "Read file",
            kind: "read",
            status: "completed",
            summary: "README.md",
        });
        vi.runAllTimers();

        expect(
            useChatStore.getState().sessionsById[activeSessionId]?.status,
        ).toBe("idle");
    });

    it("upserts tool diffs into a single tool message and preserves its timestamp", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-1",
            title: "Edit watcher",
            kind: "edit",
            status: "in_progress",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });

        const firstMessage =
            useChatStore.getState().sessionsById[activeSessionId]?.messages[0];

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-1",
            title: "Edit watcher",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });

        const session = useChatStore.getState().sessionsById[activeSessionId]!;
        const toolMessages = session.messages.filter(
            (message) => message.kind === "tool",
        );

        expect(toolMessages).toHaveLength(1);
        expect(toolMessages[0]).toMatchObject({
            id: "tool:tool-1",
            kind: "tool",
            content: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
            meta: {
                tool: "edit",
                status: "completed",
                target: "/vault/src/watcher.rs",
            },
        });
        expect(toolMessages[0].workCycleId).toBeTruthy();
        expect(session.activeWorkCycleId).toBe(toolMessages[0].workCycleId);
        expect(toolMessages[0].timestamp).toBe(firstMessage?.timestamp);
    });

    it("consolidates edited files only for completed tool diffs", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-progress",
            title: "Edit watcher",
            kind: "edit",
            status: "in_progress",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });

        let session = useChatStore.getState().sessionsById[activeSessionId]!;
        const workCycleId = session.activeWorkCycleId!;
        expect(
            session.editedFilesBufferByWorkCycleId?.[workCycleId],
        ).toBeUndefined();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-complete",
            title: "Edit watcher",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });

        session = useChatStore.getState().sessionsById[activeSessionId]!;
        expect(
            session.editedFilesBufferByWorkCycleId?.[workCycleId],
        ).toMatchObject([
            {
                identityKey: "/vault/src/watcher.rs",
                originPath: "/vault/src/watcher.rs",
                path: "/vault/src/watcher.rs",
                operation: "update",
                baseText: "old line",
                appliedText: "new line",
                supported: true,
            },
        ]);
    });

    it("ignores failed tool diffs when consolidating the edited files buffer", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-failed",
            title: "Edit watcher",
            kind: "edit",
            status: "failed",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });

        const session = useChatStore.getState().sessionsById[activeSessionId]!;
        const workCycleId = session.activeWorkCycleId!;

        expect(
            session.editedFilesBufferByWorkCycleId?.[workCycleId],
        ).toBeUndefined();
    });

    it("consolidates repeated edits for the same file into a single buffer entry", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-1",
            title: "Edit watcher",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "mid line",
                },
            ],
        });

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-2",
            title: "Edit watcher",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs again",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "mid line",
                    new_text: "final line",
                },
            ],
        });

        const session = useChatStore.getState().sessionsById[activeSessionId]!;
        const workCycleId = session.activeWorkCycleId!;
        const buffer =
            session.editedFilesBufferByWorkCycleId?.[workCycleId] ?? [];

        expect(buffer).toHaveLength(1);
        expect(buffer[0]).toMatchObject({
            identityKey: "/vault/src/watcher.rs",
            originPath: "/vault/src/watcher.rs",
            path: "/vault/src/watcher.rs",
            baseText: "old line",
            appliedText: "final line",
            operation: "update",
        });
    });

    it("removes the buffer entry when a later diff restores the base snapshot", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-1",
            title: "Edit watcher",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-2",
            title: "Restore watcher",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher.rs",
            summary: "Restored watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "new line",
                    new_text: "old line",
                },
            ],
        });

        const session = useChatStore.getState().sessionsById[activeSessionId]!;
        const workCycleId = session.activeWorkCycleId!;

        expect(
            session.editedFilesBufferByWorkCycleId?.[workCycleId],
        ).toBeUndefined();
    });

    it("keeps the edited files buffer after message completion transitions the session to idle", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-buffer-survives-complete",
            title: "Edit watcher",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });

        const workCycleId =
            useChatStore.getState().sessionsById[activeSessionId]!
                .activeWorkCycleId!;

        useChatStore.getState().applyMessageCompleted({
            session_id: activeSessionId,
            message_id: "assistant-1",
        });

        const session = useChatStore.getState().sessionsById[activeSessionId]!;
        expect(session.status).toBe("idle");
        expect(session.visibleWorkCycleId).toBe(workCycleId);
        expect(
            session.editedFilesBufferByWorkCycleId?.[workCycleId],
        ).toMatchObject([
            {
                identityKey: "/vault/src/watcher.rs",
                path: "/vault/src/watcher.rs",
                baseText: "old line",
                appliedText: "new line",
            },
        ]);
    });

    it("consolidates the edited files buffer when a permission request carries diffs", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        // First, trigger a tool activity so a work cycle is created
        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-before-perm",
            title: "Read file",
            kind: "read",
            status: "completed",
            summary: "file.rs",
        });

        const workCycleId =
            useChatStore.getState().sessionsById[activeSessionId]!
                .activeWorkCycleId!;

        // Now send a permission request with diffs
        useChatStore.getState().applyPermissionRequest({
            session_id: activeSessionId,
            request_id: "perm-1",
            tool_call_id: "tool-patch",
            title: "Edit watcher.rs",
            target: "/vault/src/watcher.rs",
            options: [],
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old content",
                    new_text: "new content",
                },
            ],
        });

        const session = useChatStore.getState().sessionsById[activeSessionId]!;
        expect(
            session.editedFilesBufferByWorkCycleId?.[workCycleId],
        ).toMatchObject([
            {
                identityKey: "/vault/src/watcher.rs",
                path: "/vault/src/watcher.rs",
                operation: "update",
                baseText: "old content",
                appliedText: "new content",
            },
        ]);
    });

    it("replaces a resolved visible work cycle when a new turn starts", async () => {
        await useChatStore.getState().initialize();
        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_send_message") {
                return {
                    ...sessionPayload,
                    status: "streaming",
                };
            }

            return sessionPayload;
        });

        const activeSessionId = getActiveSessionId();
        const oldEntry = {
            identityKey: "/vault/src/old.rs",
            originPath: "/vault/src/old.rs",
            path: "/vault/src/old.rs",
            previousPath: null,
            operation: "update" as const,
            baseText: "old base",
            appliedText: "old applied",
            reversible: true,
            isText: true,
            supported: true,
            status: "pending" as const,
            appliedHash: "old-hash",
            currentHash: null,
            additions: 1,
            deletions: 1,
            updatedAt: 1,
        };

        useChatStore.setState((state) => ({
            sessionsById: {
                ...state.sessionsById,
                [activeSessionId]: {
                    ...state.sessionsById[activeSessionId]!,
                    visibleWorkCycleId: "cycle-old",
                    activeWorkCycleId: "cycle-old",
                    editedFilesBuffer: [oldEntry],
                    editedFilesBufferByWorkCycleId: {
                        "cycle-old": [oldEntry],
                    },
                },
            },
        }));

        useChatStore
            .getState()
            .setComposerParts(createTextParts("Second turn"));
        await useChatStore.getState().sendMessage();

        let session = useChatStore.getState().sessionsById[activeSessionId]!;

        expect(session.activeWorkCycleId).toBeTruthy();
        expect(session.activeWorkCycleId).not.toBe("cycle-old");
        expect(session.visibleWorkCycleId).toBe(session.activeWorkCycleId);
        // Old cycle key is gone, but entries are carried forward to the new cycle
        expect(
            session.editedFilesBufferByWorkCycleId?.["cycle-old"],
        ).toBeUndefined();
        expect(session.editedFilesBuffer).toMatchObject([oldEntry]);

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-new-cycle",
            title: "Edit new file",
            kind: "edit",
            status: "completed",
            target: "/vault/src/new.rs",
            summary: "Updated new.rs",
            diffs: [
                {
                    path: "/vault/src/new.rs",
                    kind: "update",
                    old_text: "new old",
                    new_text: "new applied",
                },
            ],
        });

        session = useChatStore.getState().sessionsById[activeSessionId]!;

        expect(session.visibleWorkCycleId).toBe(session.activeWorkCycleId);
        // Buffer now has both the carried-forward entry and the new one
        expect(session.editedFilesBuffer).toHaveLength(2);
        expect(session.editedFilesBuffer).toMatchObject(
            expect.arrayContaining([
                expect.objectContaining({
                    identityKey: "/vault/src/old.rs",
                    baseText: "old base",
                    appliedText: "old applied",
                }),
                expect.objectContaining({
                    identityKey: "/vault/src/new.rs",
                    baseText: "new old",
                    appliedText: "new applied",
                }),
            ]),
        );
        expect(
            session.editedFilesBufferByWorkCycleId?.["cycle-old"],
        ).toBeUndefined();
    });

    it("merges accumulated entries when the same file is edited across cycles", async () => {
        await useChatStore.getState().initialize();
        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_send_message") {
                return { ...sessionPayload, status: "streaming" };
            }
            return sessionPayload;
        });

        const activeSessionId = getActiveSessionId();

        // Cycle A: edit file.md
        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-cycle-a",
            title: "Edit file",
            kind: "edit",
            status: "completed",
            diffs: [
                {
                    path: "/notes/file.md",
                    kind: "update",
                    old_text: "original",
                    new_text: "first edit",
                },
            ],
        });

        // Start cycle B
        useChatStore.getState().setComposerParts(createTextParts("Next turn"));
        await useChatStore.getState().sendMessage();

        // Cycle B: edit same file again
        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-cycle-b",
            title: "Edit file",
            kind: "edit",
            status: "completed",
            diffs: [
                {
                    path: "/notes/file.md",
                    kind: "update",
                    old_text: "first edit",
                    new_text: "second edit",
                },
            ],
        });

        const session = useChatStore.getState().sessionsById[activeSessionId]!;

        // Should have one merged entry: baseText from cycle A, appliedText from cycle B
        expect(session.editedFilesBuffer).toHaveLength(1);
        expect(session.editedFilesBuffer).toMatchObject([
            {
                identityKey: "/notes/file.md",
                baseText: "original",
                appliedText: "second edit",
            },
        ]);
    });

    it("auto-removes a carried entry when a later cycle reverts the file", async () => {
        await useChatStore.getState().initialize();
        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_send_message") {
                return { ...sessionPayload, status: "streaming" };
            }
            return sessionPayload;
        });

        const activeSessionId = getActiveSessionId();

        // Cycle A: edit file.md
        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-revert-a",
            title: "Edit file",
            kind: "edit",
            status: "completed",
            diffs: [
                {
                    path: "/notes/file.md",
                    kind: "update",
                    old_text: "original",
                    new_text: "changed",
                },
            ],
        });

        // Start cycle B
        useChatStore
            .getState()
            .setComposerParts(createTextParts("Revert turn"));
        await useChatStore.getState().sendMessage();

        // Cycle B: revert file back to original
        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-revert-b",
            title: "Edit file",
            kind: "edit",
            status: "completed",
            diffs: [
                {
                    path: "/notes/file.md",
                    kind: "update",
                    old_text: "changed",
                    new_text: "original",
                },
            ],
        });

        const session = useChatStore.getState().sessionsById[activeSessionId]!;

        // Entry should be auto-removed since baseText === appliedText
        expect(session.editedFilesBuffer).toHaveLength(0);
    });

    it("normalizes move entries to the destination path so later edits merge into one row", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-move",
            title: "Move watcher",
            kind: "move",
            status: "completed",
            target: "/vault/src/watcher-final.rs",
            summary: "Moved watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher-final.rs",
                    previous_path: "/vault/src/watcher.rs",
                    kind: "move",
                    old_text: "old line",
                    new_text: "old line",
                },
            ],
        });

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-update-after-move",
            title: "Edit moved watcher",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher-final.rs",
            summary: "Updated watcher-final.rs",
            diffs: [
                {
                    path: "/vault/src/watcher-final.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });

        const session = useChatStore.getState().sessionsById[activeSessionId]!;
        const workCycleId = session.activeWorkCycleId!;
        const buffer =
            session.editedFilesBufferByWorkCycleId?.[workCycleId] ?? [];

        expect(buffer).toHaveLength(1);
        expect(buffer[0]).toMatchObject({
            identityKey: "/vault/src/watcher-final.rs",
            originPath: "/vault/src/watcher.rs",
            path: "/vault/src/watcher-final.rs",
            previousPath: null,
            operation: "update",
            baseText: "old line",
            appliedText: "new line",
        });
    });

    it("keeps only the visible buffer in memory when Keep All is used", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-keep-all",
            title: "Edit watcher",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });

        useChatStore.getState().keepAllEditedFiles(activeSessionId);

        const session = useChatStore.getState().sessionsById[activeSessionId]!;

        expect(session.visibleWorkCycleId).toBeNull();
        expect(session.activeWorkCycleId).toBeNull();
        expect(session.editedFilesBufferByWorkCycleId).toEqual({});
    });

    function getEditedBufferEntry(sessionId: string, workCycleId: string) {
        const entry =
            useChatStore.getState().sessionsById[sessionId]!
                .editedFilesBufferByWorkCycleId?.[workCycleId]?.[0];
        expect(entry).toBeDefined();
        if (!entry) {
            throw new Error("Expected an edited files buffer entry");
        }
        return entry;
    }

    it("rejects a single edited file when the on-disk hash still matches the applied snapshot", async () => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-reject-one",
            title: "Edit watcher",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });

        const workCycleId =
            useChatStore.getState().sessionsById[activeSessionId]!
                .activeWorkCycleId!;
        const entry = getEditedBufferEntry(activeSessionId, workCycleId);

        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_get_text_file_hash") {
                return entry.appliedHash;
            }

            if (command === "ai_restore_text_file") {
                return undefined;
            }

            if (
                command === "ai_save_session_history" ||
                command === "ai_prune_session_histories"
            ) {
                return undefined;
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        await useChatStore
            .getState()
            .rejectEditedFile(activeSessionId, entry.identityKey);

        const session = useChatStore.getState().sessionsById[activeSessionId]!;
        expect(session.visibleWorkCycleId).toBeNull();
        expect(session.activeWorkCycleId).toBeNull();
        expect(session.editedFilesBufferByWorkCycleId).toEqual({});
        expect(invokeMock).toHaveBeenCalledWith("ai_restore_text_file", {
            vaultPath: "/vault",
            path: "/vault/src/watcher.rs",
            previousPath: null,
            content: "old line",
        });
    });

    it("marks a reject as conflict when the file changed after the tool completed", async () => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-conflict",
            title: "Edit watcher",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });

        const workCycleId =
            useChatStore.getState().sessionsById[activeSessionId]!
                .activeWorkCycleId!;
        const entry = getEditedBufferEntry(activeSessionId, workCycleId);

        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_get_text_file_hash") {
                return "different-hash";
            }

            if (command === "ai_restore_text_file") {
                return undefined;
            }

            if (
                command === "ai_save_session_history" ||
                command === "ai_prune_session_histories"
            ) {
                return undefined;
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        await useChatStore
            .getState()
            .rejectEditedFile(activeSessionId, entry.identityKey);

        const session = useChatStore.getState().sessionsById[activeSessionId]!;
        const remainingEntry =
            session.editedFilesBufferByWorkCycleId?.[workCycleId]?.[0] ?? null;

        expect(remainingEntry).toMatchObject({
            identityKey: entry.identityKey,
            status: "conflict",
            currentHash: "different-hash",
        });
        expect(invokeMock).not.toHaveBeenCalledWith("ai_restore_text_file", {
            vaultPath: "/vault",
            path: "/vault/src/watcher.rs",
            previousPath: null,
            content: "old line",
        });
    });

    it("marks move rejects as conflict when the original path has been reused", async () => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-move-conflict",
            title: "Move watcher",
            kind: "move",
            status: "completed",
            target: "/vault/src/watcher-final.rs",
            summary: "Moved watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher-final.rs",
                    previous_path: "/vault/src/watcher.rs",
                    kind: "move",
                    old_text: "same content",
                    new_text: "same content",
                },
            ],
        });

        const workCycleId =
            useChatStore.getState().sessionsById[activeSessionId]!
                .activeWorkCycleId!;
        const entry = getEditedBufferEntry(activeSessionId, workCycleId);

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_get_text_file_hash") {
                const path =
                    typeof args === "object" && args !== null && "path" in args
                        ? String(args.path)
                        : "";
                return path === "/vault/src/watcher-final.rs"
                    ? entry.appliedHash
                    : "origin-reused-hash";
            }

            if (command === "ai_restore_text_file") {
                return undefined;
            }

            if (
                command === "ai_save_session_history" ||
                command === "ai_prune_session_histories"
            ) {
                return undefined;
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        await useChatStore
            .getState()
            .rejectEditedFile(activeSessionId, entry.identityKey);

        const session = useChatStore.getState().sessionsById[activeSessionId]!;
        const remainingEntry =
            session.editedFilesBufferByWorkCycleId?.[workCycleId]?.[0] ?? null;

        expect(remainingEntry).toMatchObject({
            identityKey: entry.identityKey,
            status: "conflict",
            currentHash: "origin-reused-hash",
        });
        expect(invokeMock).not.toHaveBeenCalledWith("ai_restore_text_file", {
            vaultPath: "/vault",
            path: "/vault/src/watcher-final.rs",
            previousPath: "/vault/src/watcher.rs",
            content: "same content",
        });
    });

    it("resolves mixed hunk decisions by writing merged content and clearing the buffer entry", async () => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-resolve-hunks",
            title: "Edit watcher",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });

        const workCycleId =
            useChatStore.getState().sessionsById[activeSessionId]!
                .activeWorkCycleId!;
        const entry = getEditedBufferEntry(activeSessionId, workCycleId);

        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_get_text_file_hash") {
                return entry.appliedHash;
            }

            if (command === "ai_restore_text_file") {
                return undefined;
            }

            if (
                command === "ai_save_session_history" ||
                command === "ai_prune_session_histories"
            ) {
                return undefined;
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        await useChatStore
            .getState()
            .resolveEditedFileWithMergedText(
                activeSessionId,
                entry.identityKey,
                "merged line",
            );

        const session = useChatStore.getState().sessionsById[activeSessionId]!;
        expect(session.visibleWorkCycleId).toBeNull();
        expect(session.activeWorkCycleId).toBeNull();
        expect(session.editedFilesBufferByWorkCycleId).toEqual({});
        expect(invokeMock).toHaveBeenCalledWith("ai_restore_text_file", {
            vaultPath: "/vault",
            path: "/vault/src/watcher.rs",
            previousPath: null,
            content: "merged line",
        });
    });

    it("marks mixed hunk resolution as conflict when the applied file changed on disk", async () => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-resolve-hunks-conflict",
            title: "Edit watcher",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });

        const workCycleId =
            useChatStore.getState().sessionsById[activeSessionId]!
                .activeWorkCycleId!;
        const entry = getEditedBufferEntry(activeSessionId, workCycleId);

        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_get_text_file_hash") {
                return "different-hash";
            }

            if (command === "ai_restore_text_file") {
                return undefined;
            }

            if (
                command === "ai_save_session_history" ||
                command === "ai_prune_session_histories"
            ) {
                return undefined;
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        await useChatStore
            .getState()
            .resolveEditedFileWithMergedText(
                activeSessionId,
                entry.identityKey,
                "merged line",
            );

        const session = useChatStore.getState().sessionsById[activeSessionId]!;
        const remainingEntry =
            session.editedFilesBufferByWorkCycleId?.[workCycleId]?.[0] ?? null;

        expect(remainingEntry).toMatchObject({
            identityKey: entry.identityKey,
            status: "conflict",
            currentHash: "different-hash",
        });
        expect(invokeMock).not.toHaveBeenCalledWith("ai_restore_text_file", {
            vaultPath: "/vault",
            path: "/vault/src/watcher.rs",
            previousPath: null,
            content: "merged line",
        });
    });

    it("preserves previousPath when resolving merged text for moved files with content changes", async () => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-resolve-hunks-move",
            title: "Move watcher",
            kind: "move",
            status: "completed",
            target: "/vault/src/watcher-final.rs",
            summary: "Moved watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher-final.rs",
                    previous_path: "/vault/src/watcher.rs",
                    kind: "move",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });

        const workCycleId =
            useChatStore.getState().sessionsById[activeSessionId]!
                .activeWorkCycleId!;
        const entry = getEditedBufferEntry(activeSessionId, workCycleId);

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_get_text_file_hash") {
                const path =
                    typeof args === "object" && args !== null && "path" in args
                        ? String(args.path)
                        : "";
                if (path === "/vault/src/watcher-final.rs") {
                    return entry.appliedHash;
                }
                return null;
            }

            if (command === "ai_restore_text_file") {
                return undefined;
            }

            if (
                command === "ai_save_session_history" ||
                command === "ai_prune_session_histories"
            ) {
                return undefined;
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        await useChatStore
            .getState()
            .resolveEditedFileWithMergedText(
                activeSessionId,
                entry.identityKey,
                "merged moved line",
            );

        expect(invokeMock).toHaveBeenCalledWith("ai_restore_text_file", {
            vaultPath: "/vault",
            path: "/vault/src/watcher-final.rs",
            previousPath: "/vault/src/watcher.rs",
            content: "merged moved line",
        });
    });

    it("rejects all safe entries and leaves conflicting rows visible", async () => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-safe",
            title: "Edit watcher",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-conflict-all",
            title: "Edit parser",
            kind: "edit",
            status: "completed",
            target: "/vault/src/parser.rs",
            summary: "Updated parser.rs",
            diffs: [
                {
                    path: "/vault/src/parser.rs",
                    kind: "update",
                    old_text: "old parser",
                    new_text: "new parser",
                },
            ],
        });

        const workCycleId =
            useChatStore.getState().sessionsById[activeSessionId]!
                .activeWorkCycleId!;
        const entries =
            useChatStore.getState().sessionsById[activeSessionId]!
                .editedFilesBufferByWorkCycleId?.[workCycleId] ?? [];
        const safeEntry = entries.find(
            (entry) => entry.path === "/vault/src/watcher.rs",
        )!;

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_get_text_file_hash") {
                const path =
                    typeof args === "object" && args !== null && "path" in args
                        ? String(args.path)
                        : "";
                return path === "/vault/src/watcher.rs"
                    ? safeEntry.appliedHash
                    : "different-hash";
            }

            if (command === "ai_restore_text_file") {
                return undefined;
            }

            if (
                command === "ai_save_session_history" ||
                command === "ai_prune_session_histories"
            ) {
                return undefined;
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        await useChatStore.getState().rejectAllEditedFiles(activeSessionId);

        const session = useChatStore.getState().sessionsById[activeSessionId]!;
        const remainingEntries =
            session.editedFilesBufferByWorkCycleId?.[workCycleId] ?? [];

        expect(remainingEntries).toHaveLength(1);
        expect(remainingEntries[0]).toMatchObject({
            path: "/vault/src/parser.rs",
            status: "conflict",
            currentHash: "different-hash",
        });
        expect(session.visibleWorkCycleId).toBe(workCycleId);
        expect(invokeMock).toHaveBeenCalledWith("ai_restore_text_file", {
            vaultPath: "/vault",
            path: "/vault/src/watcher.rs",
            previousPath: null,
            content: "old line",
        });
    });

    it("upserts status events as system messages and updates them by event id", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyStatusEvent({
            session_id: activeSessionId,
            event_id: "vaultai:status:item:plan-1",
            kind: "item_activity",
            status: "in_progress",
            title: "Updating plan",
            detail: "Drafting next steps",
            emphasis: "neutral",
        });

        useChatStore.getState().applyStatusEvent({
            session_id: activeSessionId,
            event_id: "vaultai:status:item:plan-1",
            kind: "item_activity",
            status: "completed",
            title: "Updating plan",
            detail: "Plan ready",
            emphasis: "neutral",
        });

        const session = useChatStore.getState().sessionsById[activeSessionId]!;
        const statusMessages = session.messages.filter(
            (message) => message.kind === "status",
        );

        expect(statusMessages).toHaveLength(1);
        expect(statusMessages[0]).toMatchObject({
            id: "status:vaultai:status:item:plan-1",
            role: "system",
            kind: "status",
            title: "Updating plan",
            content: "Plan ready",
            meta: {
                status_event: "item_activity",
                status: "completed",
                emphasis: "neutral",
            },
        });
    });

    it("upserts plan updates into a single live plan message", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyPlanUpdate({
            session_id: activeSessionId,
            plan_id: "plan-1",
            title: "Plan de ejecución",
            detail: "Resumen breve del trabajo pendiente.",
            entries: [
                {
                    content: "Inspect current chat state",
                    priority: "medium",
                    status: "in_progress",
                },
                {
                    content: "Render the plan UI",
                    priority: "medium",
                    status: "pending",
                },
            ],
        });

        useChatStore.getState().applyPlanUpdate({
            session_id: activeSessionId,
            plan_id: "plan-1",
            title: "Plan de ejecución",
            detail: "Resumen breve del trabajo pendiente.",
            entries: [
                {
                    content: "Inspect current chat state",
                    priority: "medium",
                    status: "completed",
                },
                {
                    content: "Render the plan UI",
                    priority: "medium",
                    status: "in_progress",
                },
            ],
        });

        const session = useChatStore.getState().sessionsById[activeSessionId]!;
        const planMessages = session.messages.filter(
            (message) => message.kind === "plan",
        );

        expect(planMessages).toHaveLength(1);
        expect(planMessages[0]).toMatchObject({
            id: "plan:plan-1",
            kind: "plan",
            title: "Plan de ejecución",
            planDetail: "Resumen breve del trabajo pendiente.",
            meta: {
                status: "in_progress",
                completed_count: 1,
                total_count: 2,
            },
        });
        expect(planMessages[0].planEntries).toEqual([
            {
                content: "Inspect current chat state",
                priority: "medium",
                status: "completed",
            },
            {
                content: "Render the plan UI",
                priority: "medium",
                status: "in_progress",
            },
        ]);
    });

    it("tracks user input requests and resumes streaming after responding", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyUserInputRequest({
            session_id: activeSessionId,
            request_id: "input-1",
            title: "Need more detail",
            questions: [
                {
                    id: "scope",
                    header: "Scope",
                    question: "Which option should I use?",
                    is_other: true,
                    is_secret: false,
                    options: [
                        {
                            label: "Safe",
                            description: "Conservative option",
                        },
                    ],
                },
            ],
        });

        let session = useChatStore.getState().sessionsById[activeSessionId]!;
        expect(session.status).toBe("waiting_user_input");
        expect(session.messages.at(-1)).toMatchObject({
            id: "user-input:input-1",
            kind: "user_input_request",
            userInputRequestId: "input-1",
        });

        await useChatStore
            .getState()
            .respondUserInput("input-1", { scope: ["Safe"] });

        session = useChatStore.getState().sessionsById[activeSessionId]!;
        expect(session.status).toBe("streaming");
        expect(session.messages.at(-1)?.meta).toMatchObject({
            status: "resolved",
            answered: true,
        });
    });

    it("keeps Claude user input requests deferred instead of calling the backend", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.setState((state) => ({
            runtimes: [
                {
                    runtime: {
                        id: "claude-acp",
                        name: "Claude ACP",
                        description: "Claude runtime",
                        capabilities: ["attachments", "permissions"],
                    },
                    models: [],
                    modes: [],
                    configOptions: [],
                },
            ],
            sessionsById: {
                ...state.sessionsById,
                [activeSessionId]: {
                    ...state.sessionsById[activeSessionId]!,
                    runtimeId: "claude-acp",
                },
            },
        }));

        useChatStore.getState().applyUserInputRequest({
            session_id: activeSessionId,
            request_id: "input-claude-1",
            title: "Need more detail",
            questions: [
                {
                    id: "scope",
                    header: "Scope",
                    question: "Which option should I use?",
                    is_other: true,
                    is_secret: false,
                    options: [
                        {
                            label: "Safe",
                            description: "Conservative option",
                        },
                    ],
                },
            ],
        });

        await useChatStore
            .getState()
            .respondUserInput("input-claude-1", { scope: ["Safe"] });

        const session = useChatStore.getState().sessionsById[activeSessionId]!;
        expect(session.status).toBe("waiting_user_input");
        expect(session.messages.at(-1)).toMatchObject({
            kind: "error",
            content:
                "This runtime does not support interactive user input requests in this build.",
        });
        expect(
            invokeMock.mock.calls.some(
                ([command]) => command === "ai_respond_user_input",
            ),
        ).toBe(false);
    });

    it("resumes the active persisted history into a live ACP session", async () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
        });

        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_list_runtimes") return runtimePayload;
            if (command === "ai_get_setup_status") return readySetupStatus;
            if (command === "ai_list_sessions") return [];
            if (command === "ai_load_session_histories") {
                return [
                    {
                        version: 1,
                        session_id: "history-1",
                        runtime_id: "codex-acp",
                        model_id: "test-model",
                        mode_id: "default",
                        created_at: 10,
                        updated_at: 20,
                        messages: [
                            {
                                id: "m1",
                                role: "user",
                                kind: "text",
                                content: "Recovered from disk",
                                timestamp: 20,
                            },
                        ],
                    },
                ];
            }
            if (command === "ai_create_session") return sessionPayload;
            return sessionPayload;
        });

        await useChatStore.getState().initialize();

        const state = useChatStore.getState();
        expect(state.activeSessionId).toBe("codex-session-1");
        expect(state.sessionsById["persisted:history-1"]).toBeUndefined();
        const restored = state.sessionsById["codex-session-1"];
        expect(restored?.isPersistedSession).toBe(false);
        expect(restored?.historySessionId).toBe("history-1");
        expect(restored?.messages[0]?.content).toBe("Recovered from disk");
        expect(restored?.resumeContextPending).toBe(true);
        expect(restored?.models).toEqual([
            {
                id: "test-model",
                runtimeId: "codex-acp",
                name: "Test Model",
                description: "A test model for unit tests.",
            },
        ]);
        expect(restored?.modes).toEqual([
            {
                id: "default",
                runtimeId: "codex-acp",
                name: "Default",
                description: "Prompt for actions that need explicit approval.",
                disabled: false,
            },
        ]);
        expect(
            restored?.configOptions.find((option) => option.id === "model"),
        ).toEqual({
            id: "model",
            runtimeId: "codex-acp",
            category: "model",
            label: "Model",
            description: undefined,
            type: "select",
            value: "test-model",
            options: [
                {
                    value: "test-model",
                    label: "Test Model",
                    description: undefined,
                },
                {
                    value: "wide-model",
                    label: "Wide Model",
                    description: undefined,
                },
            ],
        });
        expect(
            restored?.configOptions.find(
                (option) => option.id === "reasoning_effort",
            ),
        ).toEqual({
            id: "reasoning_effort",
            runtimeId: "codex-acp",
            category: "reasoning",
            label: "Reasoning Effort",
            description: undefined,
            type: "select",
            value: "medium",
            options: [
                {
                    value: "medium",
                    label: "Medium",
                    description: undefined,
                },
                {
                    value: "high",
                    label: "High",
                    description: undefined,
                },
            ],
        });
        expect(invokeMock).toHaveBeenCalledWith("ai_create_session", {
            runtimeId: "codex-acp",
            vaultPath: "/vault",
        });
    });

    it("rehydrates Claude histories with their runtime and resumes them natively", async () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
        });

        const claudeRuntimePayload = [
            ...runtimePayload,
            {
                runtime: {
                    id: "claude-acp",
                    name: "Claude ACP",
                    description: "Claude runtime embedded as an ACP sidecar.",
                    capabilities: [
                        "create_session",
                        "list_sessions",
                        "resume_session",
                    ],
                },
                models: [],
                modes: [],
                config_options: [],
            },
        ];

        const claudeSessionPayload = {
            session_id: "claude-session-1",
            runtime_id: "claude-acp",
            model_id: "claude-sonnet",
            mode_id: "default",
            status: "idle" as const,
            models: [
                {
                    id: "claude-sonnet",
                    runtime_id: "claude-acp",
                    name: "Claude Sonnet",
                    description: "Claude test model.",
                },
            ],
            modes: [
                {
                    id: "default",
                    runtime_id: "claude-acp",
                    name: "Default",
                    description: "Claude default mode.",
                    disabled: false,
                },
            ],
            config_options: [
                {
                    id: "model",
                    runtime_id: "claude-acp",
                    category: "model",
                    label: "Model",
                    type: "select",
                    value: "claude-sonnet",
                    options: [
                        {
                            value: "claude-sonnet",
                            label: "Claude Sonnet",
                        },
                    ],
                },
            ],
        };

        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_list_runtimes") return claudeRuntimePayload;
            if (command === "ai_get_setup_status") return readySetupStatus;
            if (command === "ai_list_sessions") return [];
            if (command === "ai_load_session_histories") {
                return [
                    {
                        version: 1,
                        session_id: "history-claude-1",
                        runtime_id: "claude-acp",
                        model_id: "claude-sonnet",
                        mode_id: "default",
                        created_at: 10,
                        updated_at: 20,
                        messages: [
                            {
                                id: "m1",
                                role: "user",
                                kind: "text",
                                content: "Recovered Claude chat",
                                timestamp: 20,
                            },
                        ],
                    },
                ];
            }
            if (command === "ai_resume_runtime_session") {
                return claudeSessionPayload;
            }
            if (command === "ai_create_session") {
                throw new Error("should not create a fallback session");
            }
            return sessionPayload;
        });

        await useChatStore.getState().initialize();

        const state = useChatStore.getState();
        expect(state.activeSessionId).toBe("claude-session-1");
        expect(
            state.sessionsById["persisted:history-claude-1"],
        ).toBeUndefined();
        expect(state.sessionsById["claude-session-1"]).toMatchObject({
            historySessionId: "history-claude-1",
            runtimeId: "claude-acp",
            isPersistedSession: false,
            resumeContextPending: false,
        });
        expect(invokeMock).toHaveBeenCalledWith("ai_resume_runtime_session", {
            input: {
                runtime_id: "claude-acp",
                session_id: "history-claude-1",
            },
            vaultPath: "/vault",
        });
        expect(
            invokeMock.mock.calls.some(
                ([command]) => command === "ai_create_session",
            ),
        ).toBe(false);
    });

    it("restores persisted tool diffs from session history", async () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
        });

        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_list_runtimes") return runtimePayload;
            if (command === "ai_get_setup_status") return readySetupStatus;
            if (command === "ai_list_sessions") return [];
            if (command === "ai_load_session_histories") {
                return [
                    {
                        version: 1,
                        session_id: "history-1",
                        model_id: "test-model",
                        mode_id: "default",
                        created_at: 10,
                        updated_at: 20,
                        messages: [
                            {
                                id: "tool-1",
                                role: "assistant",
                                kind: "tool",
                                content: "Updated watcher.rs",
                                timestamp: 20,
                                title: "Edit watcher",
                                meta: {
                                    tool: "edit",
                                    status: "completed",
                                    target: "/vault/src/watcher.rs",
                                },
                                diffs: [
                                    {
                                        path: "/vault/src/watcher.rs",
                                        kind: "update",
                                        old_text: "old line",
                                        new_text: "new line",
                                    },
                                ],
                            },
                        ],
                    },
                ];
            }
            if (command === "ai_create_session") return sessionPayload;
            return sessionPayload;
        });

        await useChatStore.getState().initialize();

        const restored =
            useChatStore.getState().sessionsById["codex-session-1"];
        expect(restored?.messages[0]).toMatchObject({
            kind: "tool",
            content: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });
    });

    it("persists tool diffs when saving session history", async () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
        });

        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        const session = useChatStore.getState().sessionsById[activeSessionId]!;

        useChatStore.setState({
            sessionsById: {
                ...useChatStore.getState().sessionsById,
                [activeSessionId]: {
                    ...session,
                    messages: [
                        {
                            id: "tool:tool-1",
                            role: "assistant",
                            kind: "tool",
                            title: "Edit watcher",
                            content: "Updated watcher.rs",
                            timestamp: 10,
                            diffs: [
                                {
                                    path: "/vault/src/watcher.rs",
                                    kind: "update",
                                    old_text: "old line",
                                    new_text: "new line",
                                },
                            ],
                            meta: {
                                tool: "edit",
                                status: "completed",
                                target: "/vault/src/watcher.rs",
                            },
                        },
                    ],
                },
            },
        });

        useChatStore.getState().applySessionError({
            session_id: activeSessionId,
            message: "Trigger persistence",
        });
        await Promise.resolve();

        expect(invokeMock).toHaveBeenCalledWith("ai_save_session_history", {
            vaultPath: "/vault",
            history: expect.objectContaining({
                runtime_id: "codex-acp",
                messages: expect.arrayContaining([
                    expect.objectContaining({
                        kind: "tool",
                        diffs: [
                            {
                                path: "/vault/src/watcher.rs",
                                kind: "update",
                                old_text: "old line",
                                new_text: "new line",
                            },
                        ],
                    }),
                ]),
            }),
        });
    });

    it("does not persist the edited files buffer as part of session history", async () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
        });

        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        const workCycleId = "cycle-pending";

        useChatStore.setState((state) => ({
            sessionsById: {
                ...state.sessionsById,
                [activeSessionId]: {
                    ...state.sessionsById[activeSessionId]!,
                    activeWorkCycleId: workCycleId,
                    visibleWorkCycleId: workCycleId,
                    editedFilesBufferByWorkCycleId: {
                        [workCycleId]: [
                            {
                                identityKey: "/vault/src/watcher.rs",
                                originPath: "/vault/src/watcher.rs",
                                path: "/vault/src/watcher.rs",
                                previousPath: null,
                                operation: "update",
                                baseText: "old line",
                                appliedText: "new line",
                                reversible: true,
                                isText: true,
                                supported: true,
                                status: "pending",
                                appliedHash: "hash-1",
                                currentHash: null,
                                additions: 1,
                                deletions: 1,
                                updatedAt: 10,
                            },
                        ],
                    },
                    messages: [
                        {
                            id: "assistant-1",
                            role: "assistant",
                            kind: "text",
                            content: "Done",
                            timestamp: 10,
                        },
                    ],
                },
            },
        }));

        useChatStore.getState().applySessionError({
            session_id: activeSessionId,
            message: "Trigger persistence",
        });
        await Promise.resolve();

        const historyCall = invokeMock.mock.calls.find(
            ([command]) => command === "ai_save_session_history",
        );
        expect(historyCall).toBeTruthy();

        const historyPayload =
            typeof historyCall?.[1] === "object" && historyCall[1] !== null
                ? (historyCall[1] as { history?: Record<string, unknown> })
                : null;

        expect(historyPayload?.history).toMatchObject({
            session_id: activeSessionId,
            messages: expect.arrayContaining([
                expect.objectContaining({
                    id: "assistant-1",
                    content: "Done",
                }),
            ]),
        });
        expect(historyPayload?.history).not.toHaveProperty(
            "editedFilesBufferByWorkCycleId",
        );
        expect(historyPayload?.history).not.toHaveProperty("activeWorkCycleId");
        expect(historyPayload?.history).not.toHaveProperty(
            "visibleWorkCycleId",
        );
    });

    it("marks a persisted session as resuming while reconnecting it to ACP", async () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
        });

        let resolveCreateSession:
            | ((value: typeof sessionPayload) => void)
            | null = null;
        const createSessionPromise = new Promise<typeof sessionPayload>(
            (resolve) => {
                resolveCreateSession = resolve;
            },
        );

        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_list_runtimes") return runtimePayload;
            if (command === "ai_get_setup_status") return readySetupStatus;
            if (command === "ai_list_sessions") return [];
            if (command === "ai_load_session_histories") {
                return [
                    {
                        version: 1,
                        session_id: "history-1",
                        model_id: "test-model",
                        mode_id: "default",
                        created_at: 10,
                        updated_at: 20,
                        messages: [
                            {
                                id: "msg-1",
                                role: "user",
                                kind: "text",
                                content: "Hello",
                                timestamp: 20,
                            },
                        ],
                    },
                ];
            }
            if (command === "ai_create_session") return createSessionPromise;
            return sessionPayload;
        });

        const initializePromise = useChatStore.getState().initialize();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(
            useChatStore.getState().sessionsById["persisted:history-1"]
                ?.isResumingSession,
        ).toBe(true);

        if (!resolveCreateSession) {
            throw new Error("Missing create-session resolver");
        }
        (resolveCreateSession as (value: typeof sessionPayload) => void)(
            sessionPayload,
        );
        await initializePromise;
    });

    it("replaces persisted tab session ids when a saved chat is resumed", async () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
        });
        useChatTabsStore.setState({
            tabs: [
                {
                    id: "tab-history-1",
                    sessionId: "persisted:history-1",
                },
            ],
            activeTabId: "tab-history-1",
        });

        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_list_runtimes") return runtimePayload;
            if (command === "ai_get_setup_status") return readySetupStatus;
            if (command === "ai_list_sessions") return [];
            if (command === "ai_load_session_histories") {
                return [
                    {
                        version: 1,
                        session_id: "history-1",
                        runtime_id: "codex-acp",
                        model_id: "test-model",
                        mode_id: "default",
                        created_at: 10,
                        updated_at: 20,
                        messages: [
                            {
                                id: "msg-1",
                                role: "user",
                                kind: "text",
                                content: "Hello",
                                timestamp: 20,
                            },
                        ],
                    },
                ];
            }
            if (command === "ai_create_session") return sessionPayload;
            return sessionPayload;
        });

        await useChatStore.getState().initialize();

        expect(useChatTabsStore.getState().tabs).toEqual([
            {
                id: "tab-history-1",
                sessionId: "codex-session-1",
                historySessionId: "history-1",
                runtimeId: "codex-acp",
            },
        ]);
        expect(useChatTabsStore.getState().activeTabId).toBe("tab-history-1");
    });

    it("does not persist empty sessions and ignores empty persisted histories", async () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
        });

        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_list_runtimes") return runtimePayload;
            if (command === "ai_get_setup_status") return readySetupStatus;
            if (command === "ai_list_sessions") return [];
            if (command === "ai_create_session") return sessionPayload;
            if (command === "ai_load_session_histories") {
                return [
                    {
                        version: 1,
                        session_id: "codex-session-1",
                        model_id: "test-model",
                        mode_id: "default",
                        created_at: 10,
                        updated_at: 20,
                        messages: [],
                    },
                ];
            }
            if (command === "ai_set_session_mode") return sessionPayload;
            if (command === "ai_set_session_model") return sessionPayload;
            if (command === "ai_set_config_option") return sessionPayload;
            return sessionPayload;
        });

        await useChatStore.getState().initialize();

        expect(invokeMock).not.toHaveBeenCalledWith(
            "ai_save_session_history",
            expect.anything(),
        );

        expect(useChatStore.getState().sessionOrder).toEqual([
            "codex-session-1",
        ]);
        expect(
            useChatStore.getState().sessionsById["codex-session-1"],
        ).toMatchObject({
            historySessionId: "codex-session-1",
            isPersistedSession: false,
            messages: [],
        });
        expect(useChatStore.getState().activeSessionId).toBe("codex-session-1");
    });

    it("does not wait for persistence when the initial session is still empty", async () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
        });

        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_list_runtimes") return runtimePayload;
            if (command === "ai_get_setup_status") return readySetupStatus;
            if (command === "ai_list_sessions") return [];
            if (command === "ai_load_session_histories") return [];
            if (command === "ai_create_session") return sessionPayload;
            return sessionPayload;
        });

        let resolved = false;
        const initializePromise = useChatStore
            .getState()
            .initialize()
            .then(() => {
                resolved = true;
            });

        await new Promise((resolve) => setTimeout(resolve, 0));
        await initializePromise;

        expect(resolved).toBe(true);
        expect(invokeMock).not.toHaveBeenCalledWith(
            "ai_save_session_history",
            expect.anything(),
        );
    });

    it("removes chat tabs when deleting a session", async () => {
        await useChatStore.getState().initialize();

        useChatStore.getState().upsertSession(
            {
                sessionId: "codex-session-2",
                historySessionId: "codex-session-2",
                runtimeId: "codex-acp",
                modelId: "test-model",
                modeId: "default",
                status: "idle",
                messages: [
                    {
                        id: "m2",
                        role: "user",
                        kind: "text",
                        content: "Second chat",
                        timestamp: 30,
                    },
                ],
                attachments: [],
                models: acpModels.map((model) => ({
                    id: model.id,
                    runtimeId: model.runtime_id,
                    name: model.name,
                    description: model.description,
                })),
                modes: acpModes.map((mode) => ({
                    id: mode.id,
                    runtimeId: mode.runtime_id,
                    name: mode.name,
                    description: mode.description,
                    disabled: mode.disabled,
                })),
                configOptions: [],
            },
            true,
        );

        useChatTabsStore.setState({
            tabs: [
                {
                    id: "tab-1",
                    sessionId: "codex-session-1",
                },
                {
                    id: "tab-2",
                    sessionId: "codex-session-2",
                },
            ],
            activeTabId: "tab-2",
        });

        await useChatStore.getState().deleteSession("codex-session-2");

        expect(useChatTabsStore.getState().tabs).toEqual([
            {
                id: "tab-1",
                sessionId: "codex-session-1",
            },
        ]);
        expect(useChatTabsStore.getState().activeTabId).toBe("tab-1");
    });

    it("ignores agent changes while the session is busy", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        useChatStore.setState((state) => ({
            sessionsById: {
                ...state.sessionsById,
                [activeSessionId]: {
                    ...state.sessionsById[activeSessionId]!,
                    status: "streaming",
                },
            },
        }));

        await useChatStore.getState().setModel("test-model");
        await useChatStore.getState().setMode("default");
        await useChatStore
            .getState()
            .setConfigOption("reasoning_effort", "high");

        expect(
            invokeMock.mock.calls.filter(
                ([command]) => command === "ai_set_model",
            ),
        ).toHaveLength(0);
        expect(
            invokeMock.mock.calls.filter(
                ([command]) => command === "ai_set_mode",
            ),
        ).toHaveLength(0);
        expect(
            invokeMock.mock.calls.filter(
                ([command]) => command === "ai_set_config_option",
            ),
        ).toHaveLength(0);
        expect(
            useChatStore
                .getState()
                .sessionsById[
                    activeSessionId
                ]?.configOptions.find((option) => option.id === "reasoning_effort")
                ?.value,
        ).toBe("medium");
    });

    it("keeps session state aligned when the ACP model config changes", async () => {
        await useChatStore.getState().initialize();

        await useChatStore.getState().setConfigOption("model", "wide-model");

        expect(
            invokeMock.mock.calls.some(
                ([command, payload]) =>
                    command === "ai_set_config_option" &&
                    (() => {
                        if (
                            typeof payload !== "object" ||
                            payload === null ||
                            !("input" in payload)
                        ) {
                            return false;
                        }

                        const input = payload.input as
                            | { option_id?: string; value?: string }
                            | undefined;
                        return (
                            input?.option_id === "model" &&
                            input?.value === "wide-model"
                        );
                    })(),
            ),
        ).toBe(true);
        expect(
            invokeMock.mock.calls.filter(
                ([command]) => command === "ai_set_model",
            ),
        ).toHaveLength(0);
        expect(
            useChatStore.getState().sessionsById["codex-session-1"]?.modelId,
        ).toBe("wide-model");
        expect(
            useChatStore
                .getState()
                .sessionsById["codex-session-1"]?.configOptions.find(
                    (option) => option.id === "reasoning_effort",
                )
                ?.options.map((option) => option.value),
        ).toEqual(["low", "medium", "high", "xhigh"]);
    });

    it("attachSelectionFromEditor inserts a selection_mention composer part", async () => {
        useVaultStore.setState({
            notes: [
                {
                    id: "notes/demo",
                    title: "Demo",
                    path: "/vault/notes/demo.md",
                    modified_at: 0,
                    created_at: 0,
                },
            ],
        });

        useEditorStore.setState({
            currentSelection: {
                noteId: "notes/demo",
                text: "hello world",
                from: 10,
                to: 21,
                startLine: 3,
                endLine: 5,
            },
        });

        await useChatStore.getState().initialize();
        useChatStore.getState().attachSelectionFromEditor();

        const activeSessionId = getActiveSessionId();
        const parts =
            useChatStore.getState().composerPartsBySessionId[activeSessionId] ??
            [];
        const selectionParts = parts.filter(
            (p) => p.type === "selection_mention",
        );

        expect(selectionParts).toHaveLength(1);
        expect(selectionParts[0]).toMatchObject({
            type: "selection_mention",
            noteId: "notes/demo",
            label: "hello world  (3:5)",
            selectedText: "hello world",
            startLine: 3,
            endLine: 5,
        });
    });

    it("attachSelectionFromEditor shows single line label", async () => {
        useVaultStore.setState({
            notes: [
                {
                    id: "notes/demo",
                    title: "Demo",
                    path: "/vault/notes/demo.md",
                    modified_at: 0,
                    created_at: 0,
                },
            ],
        });

        useEditorStore.setState({
            currentSelection: {
                noteId: "notes/demo",
                text: "single line",
                from: 0,
                to: 11,
                startLine: 7,
                endLine: 7,
            },
        });

        await useChatStore.getState().initialize();
        useChatStore.getState().attachSelectionFromEditor();

        const activeSessionId = getActiveSessionId();
        const parts =
            useChatStore.getState().composerPartsBySessionId[activeSessionId] ??
            [];
        const selectionPart = parts.find((p) => p.type === "selection_mention");

        expect(selectionPart).toBeDefined();
        expect(
            selectionPart?.type === "selection_mention"
                ? selectionPart.label
                : null,
        ).toBe("single line  (7)");
    });

    it("attachSelectionFromEditor does nothing without a selection", async () => {
        await useChatStore.getState().initialize();
        useEditorStore.setState({ currentSelection: null });
        useChatStore.getState().attachSelectionFromEditor();

        const activeSessionId = getActiveSessionId();
        const parts =
            useChatStore.getState().composerPartsBySessionId[activeSessionId] ??
            [];

        expect(parts.some((p) => p.type === "selection_mention")).toBe(false);
    });

    it("attachSelectionFromEditor deduplicates identical selections", async () => {
        useVaultStore.setState({
            notes: [
                {
                    id: "notes/demo",
                    title: "Demo",
                    path: "/vault/notes/demo.md",
                    modified_at: 0,
                    created_at: 0,
                },
            ],
        });

        useEditorStore.setState({
            currentSelection: {
                noteId: "notes/demo",
                text: "hello",
                from: 0,
                to: 5,
                startLine: 1,
                endLine: 1,
            },
        });

        await useChatStore.getState().initialize();
        useChatStore.getState().attachSelectionFromEditor();
        useChatStore.getState().attachSelectionFromEditor();

        const activeSessionId = getActiveSessionId();
        const parts =
            useChatStore.getState().composerPartsBySessionId[activeSessionId] ??
            [];

        expect(
            parts.filter((p) => p.type === "selection_mention"),
        ).toHaveLength(1);
    });
});
