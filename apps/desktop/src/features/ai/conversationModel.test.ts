import { describe, expect, it } from "vitest";
import {
    canSwitchConversationProvider,
    createConversationBindingsFromLegacySession,
    createLegacyBindingId,
    deserializeConversationBindings,
    forkConversationBindings,
    getConversationSwitchBlocker,
    getLegacyConversationId,
    projectCanonicalConversationToLegacy,
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

    it("projects the active binding back for legacy consumers", () => {
        const legacy = createLegacySession();
        const { conversation, bindings } =
            projectLegacySessionToCanonical(legacy);
        const binding = {
            ...bindings[0],
            runtimeId: "codex-acp",
            runtimeDisplayName: "Codex",
            runtimeSessionId: "codex-native",
            modelId: "gpt-5",
            modeId: "agent",
            options: { reasoning: "medium" },
            models: [],
            modes: [],
            configOptions: legacy.configOptions.map((option) => ({
                ...option,
                runtimeId: "codex-acp",
            })),
        };
        const changedConversation = {
            ...conversation,
            preferredSelection: {
                runtimeId: "future-provider",
                modelId: "future-model",
                modeId: "default",
                options: {},
            },
        };

        const projected = projectCanonicalConversationToLegacy(
            changedConversation,
            binding,
            legacy,
        );

        expect(projected.sessionId).toBe("local-session");
        expect(projected.historySessionId).toBe("history-session");
        expect(projected.runtimeId).toBe("codex-acp");
        expect(projected.runtimeSessionId).toBe("codex-native");
        expect(projected.modelId).toBe("gpt-5");
        expect(projected.configOptions[0]?.value).toBe("medium");
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
            "binding_conversation_mismatch",
            "duplicate_binding_id",
            "missing_active_binding",
        ]);
    });

    it("allows provider switches only between turns without pending work", () => {
        const { conversation } = projectLegacySessionToCanonical(
            createLegacySession(),
        );

        expect(canSwitchConversationProvider(conversation)).toBe(true);
        expect(
            getConversationSwitchBlocker({
                ...conversation,
                status: "streaming",
            }),
        ).toBe("conversation_not_idle");
        expect(
            getConversationSwitchBlocker({
                ...conversation,
                isResumingSession: true,
            }),
        ).toBe("session_transition_pending");
        expect(
            getConversationSwitchBlocker(conversation, {
                hasQueuedMessages: true,
            }),
        ).toBe("queued_messages_pending");
    });

    it("roundtrips the versioned provider bindings sidecar", () => {
        const state = createConversationBindingsFromLegacySession(
            createLegacySession(),
        );
        state.contextSummary = "Earlier decisions";
        state.providerBindings[0].contextCursor = "message-1";
        state.providerBindings[0].contextGeneration = 2;

        const serialized = serializeConversationBindings(state);
        const restored = deserializeConversationBindings(serialized);

        expect(serializeConversationBindings(restored)).toEqual(serialized);
        expect(restored.contextSummary).toBe("Earlier decisions");
        expect(restored.providerBindings[0].contextCursor).toBe("message-1");
    });

    it("updates the active legacy projection without dropping prior bindings", () => {
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

        expect(updated.providerBindings).toHaveLength(2);
        expect(updated.providerBindings[0].modelId).toBe("opus");
        expect(updated.providerBindings[1].runtimeSessionId).toBe(
            "codex-native",
        );
    });

    it("preserves a different provider selected for the next turn", () => {
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

        expect(updated.preferredSelection).toEqual(state.preferredSelection);
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
            activeBindingId: "fork:fork-history:claude-acp:0",
        });
        expect(forked.providerBindings[0]).toMatchObject({
            bindingId: "fork:fork-history:claude-acp:0",
            conversationId: "fork-history",
            contextCursor: null,
            contextGeneration: 5,
            createdAt: 30,
            updatedAt: 30,
        });
    });
});
