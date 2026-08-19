import { describe, expect, it } from "vitest";
import {
    createConversationBindingsFromLegacySession,
    createLegacyBindingId,
    deserializeConversationBindings,
    forkConversationBindings,
    getConversationProviderSelectionBlocker,
    getLegacyConversationId,
    projectLegacySessionToCanonical,
    serializeConversationBindings,
    updateConversationBindingsFromLegacySession,
    validateCanonicalConversation,
} from "./conversationModel";
import type { AIChatSession } from "./types";

function createLegacySession(
    overrides: Partial<AIChatSession> = {},
): AIChatSession {
    return {
        sessionId: "local-session",
        historySessionId: "history-session",
        parentSessionId: "parent-history",
        runtimeSessionId: "native-session",
        vaultPath: "/vault",
        status: "idle",
        runtimeId: "claude-acp",
        runtimeDisplayName: "Claude",
        runtimeRevision: 3,
        runtimeLaunchFingerprint: "launch-3",
        continuationStrategy: "resume",
        modelId: "sonnet",
        modeId: "default",
        models: [
            {
                id: "sonnet",
                runtimeId: "claude-acp",
                name: "Sonnet",
                description: "",
            },
        ],
        modes: [
            {
                id: "default",
                runtimeId: "claude-acp",
                name: "Default",
                description: "",
            },
        ],
        configOptions: [
            {
                id: "reasoning",
                runtimeId: "claude-acp",
                category: "reasoning",
                label: "Reasoning",
                type: "select",
                value: "high",
                options: [{ value: "high", label: "High" }],
            },
        ],
        effortsByModel: { sonnet: ["high"] },
        messages: [
            {
                id: "message-1",
                role: "user",
                kind: "text",
                content: "Continue",
                timestamp: 10,
            },
        ],
        attachments: [],
        persistedCreatedAt: 10,
        persistedUpdatedAt: 20,
        persistedTitle: "Canonical chat",
        isPersistedSession: true,
        runtimeState: "persisted_only",
        ...overrides,
    };
}

describe("canonical conversation model", () => {
    it("reuses the durable history id as the conversation identity", () => {
        expect(getLegacyConversationId(createLegacySession())).toBe(
            "history-session",
        );
        expect(
            getLegacyConversationId(
                createLegacySession({ historySessionId: "   " }),
            ),
        ).toBe("local-session");
    });

    it("projects a legacy session without changing routing state", () => {
        const legacy = createLegacySession();
        const { conversation, bindings } =
            projectLegacySessionToCanonical(legacy);
        const binding = bindings[0];

        expect(conversation.conversationId).toBe("history-session");
        expect(conversation.parentConversationId).toBe("parent-history");
        expect(conversation.preferredSelection).toEqual({
            runtimeId: "claude-acp",
            modelId: "sonnet",
            modeId: "default",
            options: { reasoning: "high" },
        });
        expect(conversation.activeBindingId).toBe(
            createLegacyBindingId("history-session", "claude-acp"),
        );
        expect(binding).toMatchObject({
            conversationId: "history-session",
            runtimeId: "claude-acp",
            runtimeSessionId: "native-session",
            continuationStrategy: "resume",
            modelId: "sonnet",
            modeId: "default",
            options: { reasoning: "high" },
            runtimeState: "persisted_only",
        });
        expect(conversation.messages).toBe(legacy.messages);
        expect(validateCanonicalConversation(conversation, bindings)).toEqual(
            [],
        );
    });

    it("reports ownership, identity and active-binding violations", () => {
        const { conversation, bindings } = projectLegacySessionToCanonical(
            createLegacySession(),
        );
        const invalidBinding = {
            ...bindings[0],
            conversationId: "another-conversation",
        };

        expect(
            validateCanonicalConversation(
                { ...conversation, activeBindingId: "missing" },
                [invalidBinding, invalidBinding],
            ),
        ).toEqual([
            "multiple_provider_bindings",
            "binding_conversation_mismatch",
            "duplicate_binding_id",
            "missing_active_binding",
        ]);
    });

    it("allows provider selection only while the conversation is empty", () => {
        const { conversation } = projectLegacySessionToCanonical(
            createLegacySession({
                messages: [],
                persistedMessageCount: 0,
            }),
        );

        expect(getConversationProviderSelectionBlocker(conversation)).toBeNull();
        expect(
            getConversationProviderSelectionBlocker({
                ...conversation,
                status: "streaming",
            }),
        ).toBe("conversation_not_idle");
        expect(
            getConversationProviderSelectionBlocker({
                ...conversation,
                isResumingSession: true,
            }),
        ).toBe("session_transition_pending");
        expect(
            getConversationProviderSelectionBlocker(conversation, {
                hasQueuedMessages: true,
            }),
        ).toBe("queued_messages_pending");
        expect(
            getConversationProviderSelectionBlocker({
                ...conversation,
                messages: createLegacySession().messages,
            }),
        ).toBe("conversation_started");
    });

    it("roundtrips the versioned provider bindings sidecar", () => {
        const state = createConversationBindingsFromLegacySession(
            createLegacySession(),
        );
        state.contextSummary = "Earlier decisions";
        state.providerBindings[0].contextCursor = "message-1";
        state.providerBindings[0].contextGeneration = 2;
        state.providerBindings[0].options.fast = "on";
        state.preferredSelection.options.fast = "on";
        state.providerBindings[0].configOptions.push({
            id: "fast",
            runtimeId: "claude-acp",
            category: "service_tier",
            label: "Fast mode",
            type: "select",
            value: "on",
            options: [
                { value: "on", label: "On" },
                { value: "off", label: "Off" },
            ],
        });

        const serialized = serializeConversationBindings(state);
        const restored = deserializeConversationBindings(serialized);

        expect(serializeConversationBindings(restored)).toEqual(serialized);
        expect(restored.contextSummary).toBe("Earlier decisions");
        expect(restored.providerBindings[0].contextCursor).toBe("message-1");
        expect(restored.providerBindings[0].options.fast).toBe("on");
        expect(restored.providerBindings[0].configOptions[1]?.category).toBe(
            "service_tier",
        );
    });

    it("drops bindings from the retired mid-conversation switching flow", () => {
        const legacy = createLegacySession();
        const state = createConversationBindingsFromLegacySession(legacy);
        state.providerBindings.push({
            ...state.providerBindings[0],
            bindingId: "binding:codex",
            runtimeId: "codex-acp",
            runtimeSessionId: "codex-native",
        });

        const updated = updateConversationBindingsFromLegacySession({
            ...legacy,
            modelId: "opus",
            conversationBindings: state,
        });

        expect(updated.providerBindings).toHaveLength(1);
        expect(updated.providerBindings[0].modelId).toBe("opus");
        expect(updated.providerBindings[0].runtimeId).toBe("claude-acp");
    });

    it("discards a staged provider after the conversation has started", () => {
        const legacy = createLegacySession();
        const state = createConversationBindingsFromLegacySession(legacy);
        state.preferredSelection = {
            runtimeId: "codex-acp",
            modelId: "gpt-5",
            modeId: "default",
            options: {},
        };

        const updated = updateConversationBindingsFromLegacySession({
            ...legacy,
            conversationBindings: state,
        });

        expect(updated.preferredSelection.runtimeId).toBe("claude-acp");
    });

    it("preserves a different model selected for the next turn on the active provider", () => {
        const legacy = createLegacySession();
        const state = createConversationBindingsFromLegacySession(legacy);
        state.preferredSelection = {
            ...state.preferredSelection,
            modelId: "opus",
        };

        const updated = updateConversationBindingsFromLegacySession({
            ...legacy,
            conversationBindings: state,
        });

        expect(updated.preferredSelection).toEqual(state.preferredSelection);
        expect(updated.providerBindings[0].modelId).toBe("sonnet");
    });

    it("normalizes a staged mode removed by the active model catalog", () => {
        const legacy = createLegacySession({
            modelId: "haiku",
            modeId: "default",
            models: [
                {
                    id: "haiku",
                    runtimeId: "claude-acp",
                    name: "Haiku",
                    description: "",
                },
            ],
            modes: [
                {
                    id: "default",
                    runtimeId: "claude-acp",
                    name: "Default",
                    description: "",
                },
            ],
            configOptions: [
                {
                    id: "model",
                    runtimeId: "claude-acp",
                    category: "model",
                    label: "Model",
                    type: "select",
                    value: "haiku",
                    options: [{ value: "haiku", label: "Haiku" }],
                },
                {
                    id: "mode",
                    runtimeId: "claude-acp",
                    category: "mode",
                    label: "Mode",
                    type: "select",
                    value: "default",
                    options: [{ value: "default", label: "Default" }],
                },
            ],
        });
        const state = createConversationBindingsFromLegacySession(legacy);
        state.providerBindings[0].modelId = "sonnet";
        state.providerBindings[0].modeId = "auto";
        state.providerBindings[0].modes = [
            {
                id: "auto",
                runtimeId: "claude-acp",
                name: "Auto",
                description: "",
            },
        ];
        state.preferredSelection = {
            ...state.preferredSelection,
            modelId: "haiku",
            modeId: "auto",
        };

        const updated = updateConversationBindingsFromLegacySession({
            ...legacy,
            conversationBindings: state,
        });

        expect(updated.preferredSelection).toMatchObject({
            modelId: "haiku",
            modeId: "default",
        });
    });

    it("resets each provider cursor when forking a canonical conversation", () => {
        const source = createConversationBindingsFromLegacySession(
            createLegacySession(),
        );
        source.providerBindings[0].contextCursor = "message-1";
        source.providerBindings[0].contextGeneration = 4;

        const forked = forkConversationBindings(source, "fork-history", 30);

        expect(forked).toMatchObject({
            conversationId: "fork-history",
            revision: source.revision + 1,
            activeBindingId: "fork:fork-history:claude-acp",
        });
        expect(forked.providerBindings[0]).toMatchObject({
            bindingId: "fork:fork-history:claude-acp",
            conversationId: "fork-history",
            runtimeSessionId: null,
            continuationStrategy: "new_session_only",
            contextCursor: null,
            contextGeneration: 5,
            createdAt: 30,
            updatedAt: 30,
        });
    });
});
