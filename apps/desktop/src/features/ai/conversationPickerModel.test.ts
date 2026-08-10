import { describe, expect, it } from "vitest";
import { createConversationBindingsFromLegacySession } from "./conversationModel";
import {
    buildConversationProviderOptions,
    getConversationTurnCatalog,
    requiresFirstProviderHandoffConfirmation,
    updateConversationSelection,
} from "./conversationPickerModel";
import type {
    AIChatSession,
    AIRuntimeDescriptor,
    AIRuntimeSetupStatus,
} from "./types";

function session(): AIChatSession {
    return {
        sessionId: "local-a",
        historySessionId: "conversation-1",
        status: "idle",
        activeWorkCycleId: null,
        runtimeId: "provider-a",
        modelId: "model-a",
        modeId: "default",
        models: [],
        modes: [],
        configOptions: [],
        messages: [],
        attachments: [],
        runtimeState: "live",
    };
}

function runtime(id: string): AIRuntimeDescriptor {
    return {
        runtime: {
            id,
            name: `${id} ACP`,
            description: `${id} description`,
            capabilities: ["create_session"],
        },
        models: [
            {
                id: `model-${id}`,
                runtimeId: id,
                name: `Model ${id}`,
                description: "Model description",
            },
        ],
        modes: [],
        configOptions: [],
    };
}

function ready(runtimeId: string): AIRuntimeSetupStatus {
    return {
        runtimeId,
        binaryReady: true,
        binarySource: "bundled",
        authReady: true,
        authMethods: [],
        onboardingRequired: false,
    };
}

describe("conversation provider picker model", () => {
    it("excludes terminal and unready providers", () => {
        const current = session();
        const bindings = createConversationBindingsFromLegacySession(current);
        const conversation = {
            ...current,
            conversationId: bindings.conversationId,
            parentConversationId: null,
            vaultPath: null,
            closedAt: null,
            activeWorkCycleId: null,
            visibleWorkCycleId: null,
            preferredSelection: bindings.preferredSelection,
            activeBindingId: bindings.activeBindingId,
            persistedCreatedAt: null,
            persistedUpdatedAt: null,
            persistedTitle: null,
            customTitle: null,
            persistedPreview: null,
            isPersistedSession: false,
            isPendingSessionCreation: false,
            isResumingSession: false,
        };

        const options = buildConversationProviderOptions({
            runtimes: [
                runtime("provider-a"),
                runtime("provider-b"),
                runtime("provider-c"),
                runtime("claude-code-terminal"),
            ],
            setupStatusByRuntimeId: {
                "provider-a": ready("provider-a"),
                "provider-b": ready("provider-b"),
            },
            conversation,
            bindings: bindings.providerBindings,
            activeRuntimeId: "provider-a",
            hasQueuedMessages: false,
        });

        expect(options.map((option) => option.runtimeId)).toEqual([
            "provider-a",
            "provider-b",
        ]);
    });

    it("explains why another provider is disabled during active work", () => {
        const current = session();
        const bindings = createConversationBindingsFromLegacySession(current);
        const conversation = {
            ...current,
            conversationId: bindings.conversationId,
            parentConversationId: null,
            vaultPath: null,
            closedAt: null,
            activeWorkCycleId: "work-1",
            visibleWorkCycleId: null,
            preferredSelection: bindings.preferredSelection,
            activeBindingId: bindings.activeBindingId,
            persistedCreatedAt: null,
            persistedUpdatedAt: null,
            persistedTitle: null,
            customTitle: null,
            persistedPreview: null,
            isPersistedSession: false,
            isPendingSessionCreation: false,
            isResumingSession: false,
        };

        const options = buildConversationProviderOptions({
            runtimes: [runtime("provider-a"), runtime("provider-b")],
            setupStatusByRuntimeId: {
                "provider-a": ready("provider-a"),
                "provider-b": ready("provider-b"),
            },
            conversation,
            bindings: bindings.providerBindings,
            activeRuntimeId: "provider-a",
            hasQueuedMessages: false,
        });

        expect(options[0].disabledReason).toBeNull();
        expect(options[1].disabledReason).toContain("work cycle");
    });

    it("projects the selected provider catalog and updates its model option", () => {
        const current = session();
        const providerB = runtime("provider-b");
        providerB.configOptions = [
            {
                id: "model",
                runtimeId: "provider-b",
                category: "model",
                label: "Model",
                type: "select",
                value: "model-provider-b",
                options: [
                    {
                        value: "model-provider-b",
                        label: "Model B",
                    },
                    { value: "model-b-2", label: "Model B 2" },
                ],
            },
        ];
        const selection = {
            runtimeId: "provider-b",
            modelId: "model-b-2",
            modeId: "default",
            options: { model: "model-b-2" },
        };
        const catalog = getConversationTurnCatalog({
            selection,
            session: current,
            runtimes: [providerB],
            bindings: [],
        });

        expect(catalog.configOptions[0].value).toBe("model-b-2");
        expect(
            updateConversationSelection(selection, catalog.configOptions, {
                kind: "model",
                value: "model-provider-b",
            }),
        ).toMatchObject({
            modelId: "model-provider-b",
            options: { model: "model-provider-b" },
        });
    });

    it("confirms only the first transcript handoff to a provider", () => {
        const current = session();
        const bindings = createConversationBindingsFromLegacySession(current);
        expect(
            requiresFirstProviderHandoffConfirmation({
                activeRuntimeId: "provider-a",
                targetRuntimeId: "provider-b",
                bindings: bindings.providerBindings,
                messageCount: 2,
            }),
        ).toBe(true);

        bindings.providerBindings.push({
            ...bindings.providerBindings[0],
            bindingId: "binding-b",
            runtimeId: "provider-b",
        });
        expect(
            requiresFirstProviderHandoffConfirmation({
                activeRuntimeId: "provider-a",
                targetRuntimeId: "provider-b",
                bindings: bindings.providerBindings,
                messageCount: 2,
            }),
        ).toBe(false);
    });
});
