import { getConversationProviderSelectionBlocker } from "./conversationModel";
import type {
  AcpConversationBinding,
  AIChatSession,
  AIConfigOption,
  AIConversation,
  AIModeOption,
  AIModelOption,
  AIRuntimeDescriptor,
  AIRuntimeSetupStatus,
  ConversationSelection,
} from "./types";
import { CLAUDE_TERMINAL_RUNTIME_ID } from "./utils/runtimeMetadata";

export interface ConversationProviderPickerOption {
  runtimeId: string;
  label: string;
  description: string;
  disabledReason: string | null;
  defaultModelId: string;
  models: ConversationProviderModelOption[];
}

export interface ConversationProviderModelOption {
  modelId: string;
  label: string;
  description?: string;
  agentType?: string;
  disabledReason: string | null;
}

export interface ConversationTurnCatalog {
  models: AIModelOption[];
  modes: AIModeOption[];
  configOptions: AIConfigOption[];
  effortsByModel: Record<string, string[]>;
}

export interface PreparedConversationTurnCatalog
  extends ConversationTurnCatalog {
  runtimeId: string;
  modelId: string;
}

function isRuntimeReady(status?: AIRuntimeSetupStatus | null) {
  return status?.authReady === true && !status.onboardingRequired;
}

function providerSelectionBlockerLabel(
  blocker: ReturnType<typeof getConversationProviderSelectionBlocker>,
) {
  switch (blocker) {
    case "conversation_started":
      return "Start a new chat to use another provider.";
    case "conversation_not_idle":
      return "Finish the current turn before choosing another provider.";
    case "session_transition_pending":
      return "Wait for the current session transition to finish.";
    case "queued_messages_pending":
      return "Send or remove queued messages before choosing another provider.";
    default:
      return null;
  }
}

function canStartRuntime(runtime: AIRuntimeDescriptor) {
  return runtime.runtime.capabilities.includes("create_session");
}

function bindingForRuntime(
  bindings: readonly AcpConversationBinding[],
  runtimeId: string,
) {
  return bindings.find((binding) => binding.runtimeId === runtimeId) ?? null;
}

function providerModelOptions(
  runtime: AIRuntimeDescriptor,
  binding: AcpConversationBinding | null,
  hasTranscript: boolean,
) {
  const modelConfig =
    binding?.configOptions.find((option) => option.category === "model") ??
    runtime.configOptions.find((option) => option.category === "model");
  const models: ConversationProviderModelOption[] = modelConfig
    ? modelConfig.options.map((model) => ({
        modelId: model.value,
        label: model.label,
        description: model.description,
        agentType: model.agentType,
        disabledReason: null,
      }))
    : (binding?.models.length ? binding.models : runtime.models).map(
        (model) => ({
          modelId: model.id,
          label: model.name,
          description: model.description,
          agentType: model.agentType,
          disabledReason: null,
        }),
      );
  const defaultModelId =
    binding?.modelId ?? modelConfig?.value ?? models[0]?.modelId ?? "";
  if (
    defaultModelId &&
    !models.some((model) => model.modelId === defaultModelId)
  ) {
    models.unshift({
      modelId: defaultModelId,
      label: defaultModelId,
      disabledReason: null,
    });
  }

  if (runtime.runtime.id === "grok-acp" && binding && hasTranscript) {
    const activeAgentType = models.find(
      (model) => model.modelId === defaultModelId,
    )?.agentType;
    if (activeAgentType) {
      for (const model of models) {
        if (model.agentType && model.agentType !== activeAgentType) {
          model.disabledReason =
            "Start a new Grok chat to switch to this model.";
        }
      }
    }
  }

  return { defaultModelId, models };
}

export function buildConversationProviderOptions(input: {
  runtimes: readonly AIRuntimeDescriptor[];
  setupStatusByRuntimeId: Readonly<
    Record<string, AIRuntimeSetupStatus | undefined>
  >;
  conversation: AIConversation;
  bindings: readonly AcpConversationBinding[];
  activeRuntimeId: string;
  hasQueuedMessages: boolean;
}) {
  const blocker = getConversationProviderSelectionBlocker(
    input.conversation,
    {
      hasQueuedMessages: input.hasQueuedMessages,
    },
  );
  const blockerDescription = providerSelectionBlockerLabel(blocker);
  const activeBinding = input.conversation.activeBindingId
    ? input.bindings.find(
        (binding) =>
          binding.bindingId === input.conversation.activeBindingId,
      ) ?? null
    : null;

  return input.runtimes
    .filter(
      (runtime) =>
        runtime.runtime.id !== CLAUDE_TERMINAL_RUNTIME_ID &&
        (runtime.runtime.id === input.activeRuntimeId ||
          isRuntimeReady(input.setupStatusByRuntimeId[runtime.runtime.id])),
    )
    .map((runtime): ConversationProviderPickerOption => {
      const runtimeId = runtime.runtime.id;
      const isActive = runtimeId === input.activeRuntimeId;
      const binding =
        isActive && activeBinding?.runtimeId === runtimeId
          ? activeBinding
          : null;
      const modelOptions = providerModelOptions(
        runtime,
        binding,
        Math.max(
          input.conversation.messages.length,
          input.conversation.persistedMessageCount ?? 0,
        ) > 0,
      );
      let disabledReason: string | null = null;
      if (!isActive && blockerDescription) {
        disabledReason = blockerDescription;
      } else if (
        !isActive &&
        !isRuntimeReady(input.setupStatusByRuntimeId[runtimeId])
      ) {
        disabledReason = "Finish provider setup before using it in this chat.";
      } else if (!isActive && !canStartRuntime(runtime)) {
        disabledReason =
          "This provider cannot create or continue an ACP session.";
      }

      return {
        runtimeId,
        label: runtime.runtime.name.replace(/ ACP$/, ""),
        description: runtime.runtime.description,
        disabledReason,
        ...modelOptions,
      };
    });
}

function cloneConfigOptions(
  options: readonly AIConfigOption[],
  selection: ConversationSelection,
) {
  return options.map((option) => ({
    ...option,
    options: option.options.map((item) => ({ ...item })),
    value:
      option.category === "model"
        ? selection.modelId
        : option.category === "mode"
          ? selection.modeId
          : (selection.options[option.id] ?? option.value),
  }));
}

export function getConversationTurnCatalog(input: {
  selection: ConversationSelection;
  session: AIChatSession;
  runtimes: readonly AIRuntimeDescriptor[];
  bindings: readonly AcpConversationBinding[];
  preparedCatalog?: PreparedConversationTurnCatalog | null;
}): ConversationTurnCatalog {
  const liveModelId =
    input.session.configOptions.find((option) => option.category === "model")
      ?.value ?? input.session.modelId;
  const selectionMatchesLiveSession =
    input.session.runtimeId === input.selection.runtimeId &&
    liveModelId === input.selection.modelId;
  // Prepared catalogs are only a bridge for staged selections. Once the live
  // session reaches that provider/model, its latest ACP catalog wins again.
  const preparedCatalog =
    !selectionMatchesLiveSession &&
    input.preparedCatalog?.runtimeId === input.selection.runtimeId &&
    input.preparedCatalog.modelId === input.selection.modelId
      ? input.preparedCatalog
      : null;
  const runtime = input.runtimes.find(
    (candidate) => candidate.runtime.id === input.selection.runtimeId,
  );
  const binding = bindingForRuntime(
    input.bindings,
    input.selection.runtimeId,
  );
  const sessionMatches = input.session.runtimeId === input.selection.runtimeId;
  // Catalog precedence is deliberately scoped to this conversation: an exact
  // prepared target, then its existing provider binding, and only then the
  // runtime-wide discovery snapshot. This prevents one chat's partial catalog
  // from hiding another chat's model-specific options.
  const models =
    (preparedCatalog?.models.length
      ? preparedCatalog.models
      : sessionMatches && input.session.models.length > 0
      ? input.session.models
      : binding?.models.length
        ? binding.models
        : runtime?.models) ?? [];
  const modes =
    (preparedCatalog?.modes.length
      ? preparedCatalog.modes
      : sessionMatches && input.session.modes.length > 0
      ? input.session.modes
      : binding?.modes.length
        ? binding.modes
        : runtime?.modes) ?? [];
  const configOptions =
    (preparedCatalog?.configOptions.length
      ? preparedCatalog.configOptions
      : sessionMatches && input.session.configOptions.length > 0
      ? input.session.configOptions
      : binding?.configOptions.length
        ? binding.configOptions
        : runtime?.configOptions) ?? [];

  return {
    models,
    modes,
    configOptions: cloneConfigOptions(configOptions, input.selection),
    effortsByModel:
      preparedCatalog?.effortsByModel ??
      (sessionMatches
        ? input.session.effortsByModel
        : binding?.effortsByModel) ?? {},
  };
}

export function getDefaultConversationSelection(input: {
  runtime: AIRuntimeDescriptor;
}): ConversationSelection {
  const modelOption = input.runtime.configOptions.find(
    (option) => option.category === "model",
  );
  const modeOption = input.runtime.configOptions.find(
    (option) => option.category === "mode",
  );
  return {
    runtimeId: input.runtime.runtime.id,
    modelId: modelOption?.value ?? input.runtime.models[0]?.id ?? "",
    modeId:
      modeOption?.value ??
      input.runtime.modes.find((mode) => !mode.disabled)?.id ??
      input.runtime.modes[0]?.id ??
      "",
    options: Object.fromEntries(
      input.runtime.configOptions.map((option) => [option.id, option.value]),
    ),
  };
}

export function updateConversationSelection(
  selection: ConversationSelection,
  configOptions: readonly AIConfigOption[],
  input:
    | { kind: "model"; value: string }
    | { kind: "mode"; value: string }
    | { kind: "option"; optionId: string; value: string },
) {
  const options = { ...selection.options };
  let modelId = selection.modelId;
  let modeId = selection.modeId;
  if (input.kind === "model") {
    modelId = input.value;
    const modelOption = configOptions.find(
      (option) => option.category === "model",
    );
    if (modelOption) options[modelOption.id] = input.value;
  } else if (input.kind === "mode") {
    modeId = input.value;
    const modeOption = configOptions.find(
      (option) => option.category === "mode",
    );
    if (modeOption) options[modeOption.id] = input.value;
  } else {
    options[input.optionId] = input.value;
    const option = configOptions.find(
      (candidate) => candidate.id === input.optionId,
    );
    if (option?.category === "model") modelId = input.value;
    if (option?.category === "mode") modeId = input.value;
  }

  return { ...selection, modelId, modeId, options };
}
