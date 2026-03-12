import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../../app/store/editorStore";
import { useVaultStore } from "../../../app/store/vaultStore";
import { serializeComposerParts } from "../composerParts";
import { resetChatTabsStore, useChatTabsStore } from "./chatTabsStore";
import { flushDeltasSync, resetChatStore, useChatStore } from "./chatStore";

const invokeMock = vi.mocked(invoke);

const runtimePayload = [
    {
        runtime: {
            id: "codex-acp",
            name: "Codex ACP",
            description: "Codex runtime embedded as an ACP sidecar.",
            capabilities: ["attachments", "permissions", "reasoning"],
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

describe("chatStore", () => {
    beforeEach(() => {
        resetChatStore();
        resetChatTabsStore();
        vi.clearAllMocks();
        useVaultStore.setState({ vaultPath: null, notes: [] });
        useEditorStore.setState({
            tabs: [],
            activeTabId: null,
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

    it("loads runtimes and creates an initial session", async () => {
        await useChatStore.getState().initialize();

        const state = useChatStore.getState();
        expect(state.runtimeConnection.status).toBe("ready");
        expect(state.runtimes).toHaveLength(1);
        expect(state.activeSessionId).toBe("codex-session-1");
        expect(state.sessionsById["codex-session-1"]?.runtimeId).toBe(
            "codex-acp",
        );
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
        expect(useChatStore.getState().setupStatus?.onboardingRequired).toBe(
            true,
        );
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

        const activeSessionId = useChatStore.getState().activeSessionId!;
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

        const activeSessionId = useChatStore.getState().activeSessionId!;
        const parts =
            useChatStore.getState().composerPartsBySessionId[activeSessionId] ??
            [];

        expect(serializeComposerParts(parts)).toBe("Use @README.md");
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

        const activeSessionId = useChatStore.getState().activeSessionId!;
        const session = useChatStore.getState().sessionsById[activeSessionId]!;

        expect(session.status).toBe("error");
        expect(session.messages[0]?.role).toBe("user");
        expect(session.messages.at(-1)?.kind).toBe("error");
    });

    it("returns the session to idle after a completed tool event with no active work left", async () => {
        vi.useFakeTimers();
        await useChatStore.getState().initialize();

        const activeSessionId = useChatStore.getState().activeSessionId!;
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

    it("upserts status events as system messages and updates them by event id", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = useChatStore.getState().activeSessionId!;

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

        const activeSessionId = useChatStore.getState().activeSessionId!;

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

        const activeSessionId = useChatStore.getState().activeSessionId!;

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
                        messages: [],
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
                        model_id: "test-model",
                        mode_id: "default",
                        created_at: 10,
                        updated_at: 20,
                        messages: [],
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
            },
        ]);
        expect(useChatTabsStore.getState().activeTabId).toBe("tab-history-1");
    });

    it("persists empty sessions so blank chats can be restored after reopening", async () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
        });
        let firstBoot = true;

        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_list_runtimes") return runtimePayload;
            if (command === "ai_get_setup_status") return readySetupStatus;
            if (command === "ai_list_sessions") return [];
            if (command === "ai_create_session") return sessionPayload;
            if (command === "ai_save_session_history") return undefined;
            if (command === "ai_load_session_histories") {
                if (firstBoot) {
                    return [];
                }
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

        await vi.waitFor(() => {
            expect(invokeMock).toHaveBeenCalledWith("ai_save_session_history", {
                vaultPath: "/vault",
                history: expect.objectContaining({
                    session_id: "codex-session-1",
                    messages: [],
                }),
            });
        });
        firstBoot = false;

        resetChatStore();
        useChatTabsStore.setState({
            tabs: [
                {
                    id: "tab-empty",
                    sessionId: "codex-session-1",
                    historySessionId: "codex-session-1",
                },
            ],
            activeTabId: "tab-empty",
        });

        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_list_runtimes") return runtimePayload;
            if (command === "ai_get_setup_status") return readySetupStatus;
            if (command === "ai_list_sessions") return [];
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
            if (command === "ai_create_session") return sessionPayload;
            return sessionPayload;
        });

        await useChatStore.getState().initialize();

        expect(
            useChatStore.getState().sessionsById["codex-session-1"],
        ).toMatchObject({
            historySessionId: "codex-session-1",
            isPersistedSession: false,
            messages: [],
        });
    });

    it("waits for the initial empty-session persistence before initialize resolves", async () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
        });

        let resolveSave: (() => void) | null = null;
        const savePromise = new Promise<void>((resolve) => {
            resolveSave = resolve;
        });

        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_list_runtimes") return runtimePayload;
            if (command === "ai_get_setup_status") return readySetupStatus;
            if (command === "ai_list_sessions") return [];
            if (command === "ai_load_session_histories") return [];
            if (command === "ai_create_session") return sessionPayload;
            if (command === "ai_save_session_history") return savePromise;
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
        expect(resolved).toBe(false);

        const resolvePendingSave = resolveSave as (() => void) | null;
        if (!resolvePendingSave) {
            throw new Error("Missing save resolver");
        }
        resolvePendingSave();
        await initializePromise;

        expect(resolved).toBe(true);
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

        const activeSessionId = useChatStore.getState().activeSessionId!;
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

    it("does not send a new turn while the session is waiting for permission", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = useChatStore.getState().activeSessionId!;
        useChatStore.setState({
            sessionsById: {
                ...useChatStore.getState().sessionsById,
                [activeSessionId]: {
                    ...useChatStore.getState().sessionsById[activeSessionId]!,
                    status: "waiting_permission",
                },
            },
        });
        useChatStore.getState().setComposerParts([
            {
                id: "text-1",
                type: "text",
                text: "Should not send",
            },
        ]);

        await useChatStore.getState().sendMessage();

        expect(invokeMock).not.toHaveBeenCalledWith(
            "ai_send_message",
            expect.anything(),
        );
    });
});
