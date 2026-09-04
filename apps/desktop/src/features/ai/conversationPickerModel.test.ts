import { describe, expect, it } from "vitest";
import { createConversationBindingsFromLegacySession } from "./conversationModel";
import {
  buildConversationProviderOptions,
  getConversationTurnCatalog,
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
    expect(options.every((option) => !option.allowsExplicitModelId)).toBe(true);
  });

  it("enables explicit model IDs only for the Codex provider", () => {
    const current = session();
    current.runtimeId = "codex-acp";
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
      runtimes: [runtime("codex-acp"), runtime("provider-b")],
      setupStatusByRuntimeId: {
        "codex-acp": ready("codex-acp"),
        "provider-b": ready("provider-b"),
      },
      conversation,
      bindings: bindings.providerBindings,
      activeRuntimeId: "codex-acp",
      hasQueuedMessages: false,
    });

    expect(
      options.find((option) => option.runtimeId === "codex-acp"),
    ).toMatchObject({ allowsExplicitModelId: true });
    expect(
      options.find((option) => option.runtimeId === "provider-b"),
    ).toMatchObject({ allowsExplicitModelId: false });
  });

  it("blocks another provider during a running turn", () => {
    const current = session();
    const bindings = createConversationBindingsFromLegacySession(current);
    const conversation = {
      ...current,
      conversationId: bindings.conversationId,
      parentConversationId: null,
      vaultPath: null,
      closedAt: null,
      status: "streaming" as const,
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
    expect(options[1].disabledReason).toContain("current turn");
  });

  it("allows another provider when an idle chat has a stale work cycle", () => {
    const current = session();
    const bindings = createConversationBindingsFromLegacySession(current);
    const conversation = {
      ...current,
      conversationId: bindings.conversationId,
      parentConversationId: null,
      vaultPath: null,
      closedAt: null,
      activeWorkCycleId: "stale-work-1",
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
    expect(options[1].disabledReason).toBeNull();
  });

  it("locks the provider after the first conversation message", () => {
    const current = session();
    current.messages = [
      {
        id: "user-1",
        role: "user",
        kind: "text",
        content: "Start",
        timestamp: 1,
      },
    ];
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
    expect(options[1].disabledReason).toBe(
      "Start a new chat to use another provider.",
    );
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

  it("uses the prepared catalog for a staged provider and model", () => {
    const current = session();
    const bindings = createConversationBindingsFromLegacySession(current);
    const codex = runtime("codex-acp");

    const catalog = getConversationTurnCatalog({
      selection: {
        runtimeId: "codex-acp",
        modelId: "gpt-5.6-sol",
        modeId: "default",
        options: { service_tier: "off" },
      },
      session: current,
      runtimes: [codex],
      bindings: bindings.providerBindings,
      preparedCatalog: {
        runtimeId: "codex-acp",
        modelId: "gpt-5.6-sol",
        models: [],
        modes: [],
        configOptions: [
          {
            id: "reasoning_effort",
            runtimeId: "codex-acp",
            category: "reasoning",
            label: "Reasoning Effort",
            type: "select",
            value: "medium",
            options: [
              { value: "low", label: "Low" },
              { value: "medium", label: "Medium" },
              { value: "high", label: "High" },
            ],
          },
        ],
        effortsByModel: {},
      },
    });

    expect(catalog.configOptions.map((option) => option.id)).toEqual([
      "reasoning_effort",
    ]);
  });

});
