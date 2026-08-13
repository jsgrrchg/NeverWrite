import { describe, expect, it } from "vitest";
import { createConversationBindingsFromLegacySession } from "./conversationModel";
import { planConversationTurnRoute } from "./conversationTurnRouting";
import type { AIChatSession, ConversationSelection } from "./types";

function session(): AIChatSession {
    return {
        sessionId: "local-a",
        historySessionId: "conversation-1",
        runtimeSessionId: "native-a",
        status: "idle",
        runtimeId: "provider-a",
        modelId: "model-a",
        modeId: "default",
        models: [],
        modes: [],
        configOptions: [],
        messages: [],
        attachments: [],
        runtimeState: "live",
        isPersistedSession: false,
    };
}

function selection(runtimeId: string): ConversationSelection {
    return {
        runtimeId,
        modelId: `model-${runtimeId.at(-1)}`,
        modeId: "default",
        options: {},
    };
}

describe("canonical conversation turn routing", () => {
    it("continues the live active binding", () => {
        const current = session();
        const bindings = createConversationBindingsFromLegacySession(current);

        expect(
            planConversationTurnRoute({
                session: current,
                bindings,
                selection: selection("provider-a"),
                runtimeCapabilities: ["create_session", "resume_session"],
                hasTranscript: true,
            }),
        ).toMatchObject({
            strategy: "continue",
            startReason: "normal",
            initialProviderChanged: false,
            targetBinding: { runtimeId: "provider-a" },
        });
    });

    it("creates the selected provider session before the first turn", () => {
        const current = session();
        const bindings = createConversationBindingsFromLegacySession(current);

        expect(
            planConversationTurnRoute({
                session: current,
                bindings,
                selection: selection("provider-b"),
                runtimeCapabilities: ["create_session"],
                hasTranscript: false,
            }),
        ).toMatchObject({
            strategy: "create",
            startReason: "normal",
            initialProviderChanged: true,
            targetBinding: null,
        });
    });

    it("rejects provider changes after the conversation starts", () => {
        const current = session();
        const bindings = createConversationBindingsFromLegacySession(current);

        expect(
            () =>
                planConversationTurnRoute({
                    session: current,
                    bindings,
                    selection: selection("provider-b"),
                    runtimeCapabilities: ["create_session"],
                    hasTranscript: true,
                }),
        ).toThrow("Cannot change the provider after the conversation has started");
    });

    it("creates a fresh same-provider session with transcript handoff", () => {
        const current = session();
        current.runtimeState = "persisted_only";
        const bindings = createConversationBindingsFromLegacySession(current);
        bindings.providerBindings[0].runtimeSessionId = null;

        expect(
            planConversationTurnRoute({
                session: current,
                bindings,
                selection: selection("provider-a"),
                runtimeCapabilities: ["create_session"],
                hasTranscript: true,
            }),
        ).toMatchObject({
            strategy: "create",
            startReason: "transcript_handoff",
            initialProviderChanged: false,
            targetBinding: { runtimeId: "provider-a" },
        });
    });

    it("honors new-session-only before runtime continuation capabilities", () => {
        const current = session();
        current.runtimeState = "persisted_only";
        const bindings = createConversationBindingsFromLegacySession(current);
        bindings.providerBindings[0].continuationStrategy = "new_session_only";

        expect(
            planConversationTurnRoute({
                session: current,
                bindings,
                selection: selection("provider-a"),
                runtimeCapabilities: [
                    "create_session",
                    "load_session",
                    "resume_session",
                ],
                hasTranscript: true,
            }),
        ).toMatchObject({
            strategy: "create",
            startReason: "transcript_handoff",
            initialProviderChanged: false,
        });
    });

    it("uses load to restore the fixed provider binding", () => {
        const current = session();
        current.runtimeState = "persisted_only";
        const bindings = createConversationBindingsFromLegacySession(current);
        bindings.providerBindings[0].continuationStrategy = "load";

        expect(
            planConversationTurnRoute({
                session: current,
                bindings,
                selection: selection("provider-a"),
                runtimeCapabilities: ["create_session"],
                hasTranscript: true,
            }),
        ).toMatchObject({
            strategy: "load",
            startReason: "native_resume",
            initialProviderChanged: false,
        });
    });
});
