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
            providerChanged: false,
            targetBinding: { runtimeId: "provider-a" },
        });
    });

    it("resumes a prior provider binding when switching back", () => {
        const current = session();
        const bindings = createConversationBindingsFromLegacySession(current);
        bindings.providerBindings.push({
            ...bindings.providerBindings[0],
            bindingId: "binding-b",
            runtimeId: "provider-b",
            runtimeSessionId: "native-b",
            continuationStrategy: "resume",
            updatedAt: 20,
        });

        expect(
            planConversationTurnRoute({
                session: current,
                bindings,
                selection: selection("provider-b"),
                runtimeCapabilities: ["create_session", "resume_session"],
                hasTranscript: true,
            }),
        ).toMatchObject({
            strategy: "resume",
            startReason: "provider_switch",
            providerChanged: true,
            targetBinding: { bindingId: "binding-b" },
        });
    });

    it("creates an isolated binding when the provider cannot continue", () => {
        const current = session();
        const bindings = createConversationBindingsFromLegacySession(current);

        expect(
            planConversationTurnRoute({
                session: current,
                bindings,
                selection: selection("provider-b"),
                runtimeCapabilities: ["create_session"],
                hasTranscript: true,
            }),
        ).toMatchObject({
            strategy: "create",
            startReason: "provider_switch",
            providerChanged: true,
            targetBinding: null,
        });
    });

    it("creates a fresh session when a prior binding is not resumable", () => {
        const current = session();
        const bindings = createConversationBindingsFromLegacySession(current);
        bindings.providerBindings.push({
            ...bindings.providerBindings[0],
            bindingId: "binding-b",
            runtimeId: "provider-b",
            runtimeSessionId: "native-b",
            continuationStrategy: "new_session_only",
        });

        expect(
            planConversationTurnRoute({
                session: current,
                bindings,
                selection: selection("provider-b"),
                runtimeCapabilities: ["create_session"],
                hasTranscript: true,
            }),
        ).toMatchObject({
            strategy: "create",
            startReason: "provider_switch",
            providerChanged: true,
            targetBinding: { bindingId: "binding-b" },
        });
    });

    it("uses load for bindings that explicitly require it", () => {
        const current = session();
        const bindings = createConversationBindingsFromLegacySession(current);
        bindings.providerBindings.push({
            ...bindings.providerBindings[0],
            bindingId: "binding-b",
            runtimeId: "provider-b",
            runtimeSessionId: "native-b",
            continuationStrategy: "load",
        });

        expect(
            planConversationTurnRoute({
                session: current,
                bindings,
                selection: selection("provider-b"),
                runtimeCapabilities: ["create_session"],
                hasTranscript: true,
            }).strategy,
        ).toBe("load");
    });
});
