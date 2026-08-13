import type {
    AcpConversationBinding,
    AIChatSession,
    AIConfigOption,
    AIConversation,
    ConversationBindingsState,
    ConversationSelection,
    PersistedConversationBindings,
} from "./types";

export interface CanonicalConversationProjection {
    conversation: AIConversation;
    bindings: AcpConversationBinding[];
}

export type ConversationInvariantViolation =
    | "missing_conversation_id"
    | "multiple_provider_bindings"
    | "duplicate_binding_id"
    | "binding_conversation_mismatch"
    | "binding_runtime_mismatch"
    | "missing_active_binding";

export type ConversationProviderSelectionBlocker =
    | "conversation_started"
    | "conversation_not_idle"
    | "session_transition_pending"
    | "queued_messages_pending";

export interface ConversationProviderSelectionContext {
    hasQueuedMessages?: boolean;
}

export function hasConversationHistory(
    conversation: Pick<AIConversation, "messages" | "persistedMessageCount">,
) {
    return (
        Math.max(
            conversation.messages.length,
            conversation.persistedMessageCount ?? 0,
        ) > 0
    );
}

function nonEmpty(value: string | null | undefined) {
    const normalized = value?.trim();
    return normalized ? normalized : null;
}

function selectionOptions(configOptions: readonly AIConfigOption[]) {
    return Object.fromEntries(
        configOptions.map((option) => [option.id, option.value]),
    );
}

function selectionMatchesBinding(
    selection: ConversationSelection,
    binding: AcpConversationBinding,
) {
    if (
        selection.runtimeId !== binding.runtimeId ||
        selection.modelId !== binding.modelId ||
        selection.modeId !== binding.modeId
    ) {
        return false;
    }

    const optionIds = new Set([
        ...Object.keys(selection.options),
        ...Object.keys(binding.options),
    ]);
    return [...optionIds].every(
        (optionId) => selection.options[optionId] === binding.options[optionId],
    );
}

/**
 * The existing durable history id becomes the canonical identity. New code
 * should use this helper instead of treating a native runtime id as durable.
 */
export function getLegacyConversationId(
    session: Pick<AIChatSession, "historySessionId" | "sessionId">,
) {
    return nonEmpty(session.historySessionId) ?? session.sessionId;
}

export function createLegacyBindingId(conversationId: string, runtimeId: string) {
    return `legacy:${encodeURIComponent(conversationId)}:${encodeURIComponent(runtimeId)}`;
}

export function getConversationSelection(
    session: Pick<
        AIChatSession,
        "runtimeId" | "modelId" | "modeId" | "configOptions"
    >,
): ConversationSelection {
    return {
        runtimeId: session.runtimeId,
        modelId: session.modelId,
        modeId: session.modeId,
        options: selectionOptions(session.configOptions),
    };
}

/**
 * Read adapter for phase A1. It is intentionally side-effect free: loading a
 * legacy session does not write or migrate persistence.
 */
export function projectLegacySessionToCanonical(
    session: AIChatSession,
): CanonicalConversationProjection {
    const conversationId = getLegacyConversationId(session);
    const bindingId = createLegacyBindingId(conversationId, session.runtimeId);
    const selection = getConversationSelection(session);
    const binding: AcpConversationBinding = {
        bindingId,
        conversationId,
        runtimeId: session.runtimeId,
        runtimeDisplayName: session.runtimeDisplayName ?? null,
        runtimeRevision: session.runtimeRevision ?? null,
        runtimeLaunchFingerprint: session.runtimeLaunchFingerprint ?? null,
        runtimeSessionId: session.runtimeSessionId ?? null,
        continuationStrategy: session.continuationStrategy ?? null,
        capabilities: [],
        modelId: session.modelId,
        modeId: session.modeId,
        options: { ...selection.options },
        models: session.models,
        modes: session.modes,
        configOptions: session.configOptions,
        availableCommands: session.availableCommands,
        effortsByModel: session.effortsByModel ?? {},
        runtimeState: session.runtimeState ?? "live",
        contextCursor: null,
        contextGeneration: 0,
        createdAt: session.persistedCreatedAt ?? null,
        updatedAt: session.persistedUpdatedAt ?? null,
    };

    return {
        conversation: {
            conversationId,
            parentConversationId: session.parentSessionId ?? null,
            vaultPath: session.vaultPath ?? null,
            closedAt: session.closedAt ?? null,
            status: session.status,
            activeWorkCycleId: session.activeWorkCycleId ?? null,
            visibleWorkCycleId: session.visibleWorkCycleId ?? null,
            actionLog: session.actionLog,
            messages: session.messages,
            attachments: session.attachments,
            preferredSelection: selection,
            activeBindingId: bindingId,
            persistedCreatedAt: session.persistedCreatedAt ?? null,
            persistedUpdatedAt: session.persistedUpdatedAt ?? null,
            persistedTitle: session.persistedTitle ?? null,
            customTitle: session.customTitle ?? null,
            persistedPreview: session.persistedPreview ?? null,
            persistedMessageCount: session.persistedMessageCount,
            loadedPersistedMessageStart:
                session.loadedPersistedMessageStart ?? null,
            isLoadingPersistedMessages: session.isLoadingPersistedMessages,
            isPersistedSession: session.isPersistedSession ?? false,
            isPendingSessionCreation:
                session.isPendingSessionCreation ?? false,
            isResumingSession: session.isResumingSession ?? false,
        },
        bindings: [binding],
    };
}

export function createConversationBindingsFromLegacySession(
    session: AIChatSession,
): ConversationBindingsState {
    const { conversation, bindings } = projectLegacySessionToCanonical(session);
    return {
        version: 1,
        revision: 0,
        conversationId: conversation.conversationId,
        preferredSelection: conversation.preferredSelection,
        activeBindingId: conversation.activeBindingId,
        providerBindings: bindings,
        contextSummary: null,
        transcriptObservation: {
            messageCount: session.persistedMessageCount ?? session.messages.length,
            updatedAt: session.persistedUpdatedAt ?? 0,
            transcriptFingerprint: null,
        },
    };
}

export function updateConversationBindingsFromLegacySession(
    session: AIChatSession,
): ConversationBindingsState {
    const projected = projectLegacySessionToCanonical(session);
    const current =
        session.conversationBindings ??
        createConversationBindingsFromLegacySession(session);
    const projectedBinding = projected.bindings[0];
    const activeBinding = current.providerBindings.find(
        (binding) =>
            binding.bindingId === current.activeBindingId &&
            binding.runtimeId === projectedBinding.runtimeId,
    );
    const nextBinding: AcpConversationBinding = activeBinding
        ? {
              ...activeBinding,
              runtimeId: projectedBinding.runtimeId,
              runtimeDisplayName: projectedBinding.runtimeDisplayName,
              runtimeRevision: projectedBinding.runtimeRevision,
              runtimeLaunchFingerprint:
                  projectedBinding.runtimeLaunchFingerprint,
              runtimeSessionId: projectedBinding.runtimeSessionId,
              continuationStrategy: projectedBinding.continuationStrategy,
              modelId: projectedBinding.modelId,
              modeId: projectedBinding.modeId,
              options: projectedBinding.options,
              models: projectedBinding.models,
              modes: projectedBinding.modes,
              configOptions: projectedBinding.configOptions,
              availableCommands: projectedBinding.availableCommands,
              effortsByModel: projectedBinding.effortsByModel,
              runtimeState: projectedBinding.runtimeState,
              updatedAt: projectedBinding.updatedAt,
          }
        : projectedBinding;
    // A conversation is bound to exactly one provider after its first turn.
    // Drop stale bindings created by the former mid-conversation switching flow.
    const providerBindings = [nextBinding];
    const preferredSelectionTracksActiveBinding =
        activeBinding != null &&
        selectionMatchesBinding(current.preferredSelection, activeBinding);
    const preferredProviderMatchesActiveBinding =
        current.preferredSelection.runtimeId === projectedBinding.runtimeId;

    return {
        ...current,
        conversationId: projected.conversation.conversationId,
        // A different model/mode for the active provider is still a staged
        // next-turn selection. Preserve it until that turn is accepted. Only
        // follow the live legacy session when the preference still describes
        // the binding we are replacing.
        preferredSelection:
            (hasConversationHistory(session) &&
                !preferredProviderMatchesActiveBinding) ||
            preferredSelectionTracksActiveBinding
                ? projected.conversation.preferredSelection
                : current.preferredSelection,
        activeBindingId: nextBinding.bindingId,
        providerBindings,
    };
}

/**
 * A transcript fork owns a fresh binding identity and must replay context to
 * its fixed provider from the beginning of the copied transcript.
 */
export function forkConversationBindings(
    source: ConversationBindingsState,
    conversationId: string,
    now: number,
): ConversationBindingsState {
    const sourceBinding =
        source.providerBindings.find(
            (binding) => binding.bindingId === source.activeBindingId,
        ) ?? source.providerBindings[0];
    const providerBindings: AcpConversationBinding[] = sourceBinding
        ? [
              {
                  ...sourceBinding,
                  bindingId: `fork:${conversationId}:${sourceBinding.runtimeId}`,
                  conversationId,
                  runtimeSessionId: null,
                  continuationStrategy: "new_session_only",
                  contextCursor: null,
                  contextGeneration: sourceBinding.contextGeneration + 1,
                  createdAt: now,
                  updatedAt: now,
              },
          ]
        : [];
    const activeBindingId = providerBindings[0]?.bindingId ?? null;

    return {
        ...source,
        revision: source.revision + 1,
        conversationId,
        activeBindingId,
        providerBindings,
        transcriptObservation: {
            ...source.transcriptObservation,
            updatedAt: now,
        },
    };
}

export function serializeConversationBindings(
    state: ConversationBindingsState,
): PersistedConversationBindings {
    const activeBinding =
        state.providerBindings.find(
            (binding) => binding.bindingId === state.activeBindingId,
        ) ?? state.providerBindings[0];
    return {
        version: state.version,
        revision: state.revision,
        conversation_id: state.conversationId,
        preferred_selection: {
            runtime_id: state.preferredSelection.runtimeId,
            model_id: state.preferredSelection.modelId,
            mode_id: state.preferredSelection.modeId,
            options: state.preferredSelection.options,
        },
        active_binding_id: activeBinding?.bindingId ?? null,
        provider_bindings: (activeBinding ? [activeBinding] : []).map(
            (binding) => ({
                binding_id: binding.bindingId,
                conversation_id: binding.conversationId,
                runtime_id: binding.runtimeId,
                runtime_display_name: binding.runtimeDisplayName,
                runtime_revision: binding.runtimeRevision,
                runtime_launch_fingerprint: binding.runtimeLaunchFingerprint,
                runtime_session_id: binding.runtimeSessionId,
                continuation_strategy: binding.continuationStrategy,
                capabilities: binding.capabilities,
                model_id: binding.modelId,
                mode_id: binding.modeId,
                options: binding.options,
                models: binding.models.map((model) => ({
                    id: model.id,
                    runtime_id: model.runtimeId,
                    name: model.name,
                    description: model.description,
                    agent_type: model.agentType,
                })),
                modes: binding.modes.map((mode) => ({
                    id: mode.id,
                    runtime_id: mode.runtimeId,
                    name: mode.name,
                    description: mode.description,
                    disabled: mode.disabled ?? false,
                })),
                config_options: binding.configOptions.map((option) => ({
                    id: option.id,
                    runtime_id: option.runtimeId,
                    category: option.category,
                    label: option.label,
                    description: option.description,
                    type: option.type,
                    value: option.value,
                    options: option.options.map((item) => ({
                        value: item.value,
                        label: item.label,
                        description: item.description,
                        agent_type: item.agentType,
                    })),
                })),
                efforts_by_model: binding.effortsByModel,
                runtime_state: binding.runtimeState,
                context_cursor: binding.contextCursor,
                context_generation: binding.contextGeneration,
                created_at: binding.createdAt,
                updated_at: binding.updatedAt,
            }),
        ),
        context_summary: state.contextSummary,
        transcript_observation: {
            message_count: state.transcriptObservation.messageCount,
            updated_at: state.transcriptObservation.updatedAt,
            transcript_fingerprint:
                state.transcriptObservation.transcriptFingerprint,
        },
    };
}

export function deserializeConversationBindings(
    persisted: PersistedConversationBindings,
): ConversationBindingsState {
    const deserializedBindings = persisted.provider_bindings.map((binding) => ({
        bindingId: binding.binding_id,
        conversationId: binding.conversation_id,
        runtimeId: binding.runtime_id,
        runtimeDisplayName: binding.runtime_display_name,
        runtimeRevision: binding.runtime_revision,
        runtimeLaunchFingerprint: binding.runtime_launch_fingerprint,
        runtimeSessionId: binding.runtime_session_id,
        continuationStrategy: binding.continuation_strategy,
        capabilities: binding.capabilities,
        modelId: binding.model_id,
        modeId: binding.mode_id,
        options: binding.options,
        models: (binding.models ?? []).map((model) => ({
            id: model.id,
            runtimeId: model.runtime_id,
            name: model.name,
            description: model.description,
            agentType: model.agent_type ?? undefined,
        })),
        modes: (binding.modes ?? []).map((mode) => ({
            id: mode.id,
            runtimeId: mode.runtime_id,
            name: mode.name,
            description: mode.description,
            disabled: mode.disabled,
        })),
        configOptions: (binding.config_options ?? []).map((option) => ({
            id: option.id,
            runtimeId: option.runtime_id,
            category: option.category,
            label: option.label,
            description: option.description ?? undefined,
            type: option.type,
            value: option.value,
            options: option.options.map((item) => ({
                value: item.value,
                label: item.label,
                description: item.description ?? undefined,
                agentType: item.agent_type ?? undefined,
            })),
        })),
        effortsByModel: binding.efforts_by_model ?? {},
        runtimeState: binding.runtime_state,
        contextCursor: binding.context_cursor,
        contextGeneration: binding.context_generation,
        createdAt: binding.created_at,
        updatedAt: binding.updated_at,
    }));
    const activeBinding =
        deserializedBindings.find(
            (binding) => binding.bindingId === persisted.active_binding_id,
        ) ?? deserializedBindings[0];
    const preferredSelection =
        persisted.transcript_observation.message_count > 0 && activeBinding
            ? {
                  runtimeId: activeBinding.runtimeId,
                  modelId: activeBinding.modelId,
                  modeId: activeBinding.modeId,
                  options: { ...activeBinding.options },
              }
            : {
                  runtimeId: persisted.preferred_selection.runtime_id,
                  modelId: persisted.preferred_selection.model_id,
                  modeId: persisted.preferred_selection.mode_id,
                  options: persisted.preferred_selection.options,
              };
    return {
        version: persisted.version,
        revision: persisted.revision,
        conversationId: persisted.conversation_id,
        preferredSelection,
        activeBindingId: activeBinding?.bindingId ?? null,
        providerBindings: activeBinding ? [activeBinding] : [],
        contextSummary: persisted.context_summary,
        transcriptObservation: {
            messageCount: persisted.transcript_observation.message_count,
            updatedAt: persisted.transcript_observation.updated_at,
            transcriptFingerprint:
                persisted.transcript_observation.transcript_fingerprint,
        },
    };
}

export function validateCanonicalConversation(
    conversation: AIConversation,
    bindings: readonly AcpConversationBinding[],
): ConversationInvariantViolation[] {
    const violations = new Set<ConversationInvariantViolation>();
    if (!nonEmpty(conversation.conversationId)) {
        violations.add("missing_conversation_id");
    }

    const seenBindingIds = new Set<string>();
    if (bindings.length > 1) {
        violations.add("multiple_provider_bindings");
    }
    for (const binding of bindings) {
        if (seenBindingIds.has(binding.bindingId)) {
            violations.add("duplicate_binding_id");
        }
        seenBindingIds.add(binding.bindingId);
        if (binding.conversationId !== conversation.conversationId) {
            violations.add("binding_conversation_mismatch");
        }
        if (
            binding.configOptions.some(
                (option) => option.runtimeId !== binding.runtimeId,
            )
        ) {
            violations.add("binding_runtime_mismatch");
        }
        if (
            binding.models.some((model) => model.runtimeId !== binding.runtimeId) ||
            binding.modes.some((mode) => mode.runtimeId !== binding.runtimeId)
        ) {
            violations.add("binding_runtime_mismatch");
        }
    }

    if (
        conversation.activeBindingId !== null &&
        !seenBindingIds.has(conversation.activeBindingId)
    ) {
        violations.add("missing_active_binding");
    }

    return [...violations];
}

/** A provider can be chosen only before the conversation has any history. */
export function getConversationProviderSelectionBlocker(
    conversation: Pick<
        AIConversation,
        | "status"
        | "messages"
        | "persistedMessageCount"
        | "isPendingSessionCreation"
        | "isResumingSession"
    >,
    context: ConversationProviderSelectionContext = {},
): ConversationProviderSelectionBlocker | null {
    if (hasConversationHistory(conversation)) return "conversation_started";
    if (conversation.status !== "idle") return "conversation_not_idle";
    if (
        conversation.isPendingSessionCreation ||
        conversation.isResumingSession
    ) {
        return "session_transition_pending";
    }
    if (context.hasQueuedMessages) return "queued_messages_pending";
    return null;
}
