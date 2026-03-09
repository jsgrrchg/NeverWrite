import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { serializeComposerParts } from "../composerParts";
import { resetChatStore, useChatStore } from "./chatStore";

const invokeMock = vi.mocked(invoke);

const runtimePayload = [
    {
        runtime: {
            id: "codex-acp",
            name: "Codex ACP",
            description: "Codex runtime embedded as an ACP sidecar.",
            capabilities: ["attachments", "permissions", "reasoning"],
        },
        models: [
            {
                id: "gpt-5-codex",
                runtime_id: "codex-acp",
                name: "GPT-5 Codex",
                description: "General-purpose coding and editing model.",
            },
        ],
        modes: [
            {
                id: "default",
                runtime_id: "codex-acp",
                name: "Default",
                description: "Prompt for actions that need explicit approval.",
                disabled: false,
            },
        ],
        config_options: [
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
        ],
    },
];

const sessionPayload = {
    session_id: "codex-session-1",
    runtime_id: "codex-acp",
    model_id: "gpt-5-codex",
    mode_id: "default",
    status: "idle" as const,
    models: runtimePayload[0]!.models,
    modes: runtimePayload[0]!.modes,
    config_options: runtimePayload[0]!.config_options,
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
            description: "Sign in with your paid ChatGPT account to connect Codex.",
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
        vi.clearAllMocks();

        invokeMock.mockImplementation(async (command) => {
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
                    model_id: "gpt-5-codex",
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

            return sessionPayload;
        });
    });

    it("loads runtimes and creates an initial session", async () => {
        await useChatStore.getState().initialize();

        const state = useChatStore.getState();
        expect(state.runtimeConnection.status).toBe("ready");
        expect(state.runtimes).toHaveLength(1);
        expect(state.activeSessionId).toBe("codex-session-1");
        expect(state.sessionsById["codex-session-1"]?.runtimeId).toBe("codex-acp");
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
                throw new Error("Should not create a session while onboarding is required");
            }

            return [];
        });

        await useChatStore.getState().initialize();

        expect(useChatStore.getState().activeSessionId).toBeNull();
        expect(useChatStore.getState().setupStatus?.onboardingRequired).toBe(true);
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
            useChatStore.getState().composerPartsBySessionId[activeSessionId] ?? [];

        expect(serializeComposerParts(parts)).toBe("Use @README.md");
    });

    it("moves the updated session to the top of the history order", async () => {
        await useChatStore.getState().initialize();

        useChatStore.getState().upsertSession({
            sessionId: "codex-session-2",
            runtimeId: "codex-acp",
            modelId: "gpt-5-codex",
            modeId: "default",
            status: "idle",
            models: runtimePayload[0]!.models.map((model) => ({
                id: model.id,
                runtimeId: model.runtime_id,
                name: model.name,
                description: model.description,
            })),
            modes: runtimePayload[0]!.modes.map((mode) => ({
                id: mode.id,
                runtimeId: mode.runtime_id,
                name: mode.name,
                description: mode.description,
                disabled: mode.disabled,
            })),
            configOptions: [],
            messages: [],
            attachments: [],
        });

        useChatStore
            .getState()
            .applyMessageStarted({
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

        useChatStore.getState().upsertSession({
            sessionId: "codex-session-2",
            runtimeId: "codex-acp",
            modelId: "gpt-5-codex",
            modeId: "default",
            status: "idle",
            models: runtimePayload[0]!.models.map((model) => ({
                id: model.id,
                runtimeId: model.runtime_id,
                name: model.name,
                description: model.description,
            })),
            modes: runtimePayload[0]!.modes.map((mode) => ({
                id: mode.id,
                runtimeId: mode.runtime_id,
                name: mode.name,
                description: mode.description,
                disabled: mode.disabled,
            })),
            configOptions: [],
            messages: [],
            attachments: [],
        });

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
                useChatStore.getState().composerPartsBySessionId["codex-session-1"] ?? [],
            ),
        ).toBe("first draft");
        expect(
            serializeComposerParts(
                useChatStore.getState().composerPartsBySessionId["codex-session-2"] ?? [],
            ),
        ).toBe("second draft");
    });

    it("loads a session from backend and promotes it to the top of the history", async () => {
        await useChatStore.getState().initialize();

        useChatStore.getState().upsertSession({
            sessionId: "codex-session-2",
            runtimeId: "codex-acp",
            modelId: "gpt-5-codex",
            modeId: "default",
            status: "idle",
            models: runtimePayload[0]!.models.map((model) => ({
                id: model.id,
                runtimeId: model.runtime_id,
                name: model.name,
                description: model.description,
            })),
            modes: runtimePayload[0]!.modes.map((mode) => ({
                id: mode.id,
                runtimeId: mode.runtime_id,
                name: mode.name,
                description: mode.description,
                disabled: mode.disabled,
            })),
            configOptions: [],
            messages: [],
            attachments: [],
        });

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
});
