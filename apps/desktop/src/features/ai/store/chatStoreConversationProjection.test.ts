import { describe, expect, it } from "vitest";
import { createConversationBindingsFromLegacySession } from "../conversationModel";
import type { AIChatSession } from "../types";
import {
    projectChatStoreToCanonical,
    projectSessionMapToConversations,
    resolveConversationId,
    resolveLegacySessionId,
    selectLegacySessionForConversation,
} from "./chatStoreConversationProjection";

function createSession(overrides: Partial<AIChatSession> = {}): AIChatSession {
    return {
        sessionId: "local-session",
        historySessionId: "conversation-1",
        runtimeSessionId: "native-session",
        vaultPath: "/vault",
        status: "idle",
        runtimeId: "claude-acp",
        runtimeDisplayName: "Claude",
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
        configOptions: [],
        messages: [],
        attachments: [],
        runtimeState: "live",
        ...overrides,
    };
}

describe("canonical chat store projection", () => {
    it("deduplicates local and native session replacements by conversation", () => {
        const stale = createSession({
            sessionId: "persisted:conversation-1",
            runtimeSessionId: "native-old",
            runtimeState: "persisted_only",
        });
        const live = createSession({
            sessionId: "local-live",
            runtimeSessionId: "native-live",
        });
        const projection = projectChatStoreToCanonical({
            sessionsById: {
                [stale.sessionId]: stale,
                [live.sessionId]: live,
            },
            sessionOrder: [stale.sessionId, live.sessionId],
            activeSessionId: live.sessionId,
        });

        expect(projection.conversationOrder).toEqual(["conversation-1"]);
        expect(projection.activeConversationId).toBe("conversation-1");
        expect(projection.sessionIdByConversationId["conversation-1"]).toBe(
            "local-live",
        );
        expect(
            resolveConversationId(projection, "native-live"),
        ).toBe("conversation-1");
        expect(
            resolveLegacySessionId(projection, "native-old"),
        ).toBe("local-live");

        expect(
            projectSessionMapToConversations(
                {
                    [stale.sessionId]: "stale draft",
                    [live.sessionId]: "live draft",
                },
                projection,
            ),
        ).toEqual({ "conversation-1": "live draft" });
    });

    it("indexes every persisted binding and projects the active one for legacy UI", () => {
        const session = createSession();
        const bindingState = createConversationBindingsFromLegacySession(session);
        const activeBinding = bindingState.providerBindings[0];
        const previousBinding = {
            ...activeBinding,
            bindingId: "binding:codex",
            runtimeId: "codex-acp",
            runtimeSessionId: "codex-native",
            modelId: "gpt-5",
            models: [],
            modes: [],
            configOptions: [],
        };
        const withBindings: AIChatSession = {
            ...session,
            conversationBindings: {
                ...bindingState,
                revision: 2,
                providerBindings: [previousBinding, activeBinding],
            },
        };
        const projection = projectChatStoreToCanonical({
            sessionsById: { [session.sessionId]: withBindings },
            sessionOrder: [session.sessionId],
            activeSessionId: session.sessionId,
        });

        expect(projection.bindingsById["binding:codex"]).toMatchObject({
            runtimeId: "codex-acp",
            runtimeSessionId: "codex-native",
        });
        expect(resolveConversationId(projection, "binding:codex")).toBe(
            "conversation-1",
        );
        expect(resolveConversationId(projection, "codex-native")).toBe(
            "conversation-1",
        );

        const legacy = selectLegacySessionForConversation(
            {
                ...projection,
                sessionsById: { [session.sessionId]: withBindings },
            },
            "conversation-1",
        );
        expect(legacy).toMatchObject({
            sessionId: "local-session",
            historySessionId: "conversation-1",
            runtimeId: "claude-acp",
            runtimeSessionId: "native-session",
        });
    });
});
