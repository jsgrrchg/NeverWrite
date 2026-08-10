import type {
    AcpConversationBinding,
    AIChatSession,
    AIConfigOption,
    AIConversation,
    ConversationSelection,
} from "./types";

export interface CanonicalConversationProjection {
    conversation: AIConversation;
    bindings: AcpConversationBinding[];
}

export type ConversationInvariantViolation =
    | "missing_conversation_id"
    | "duplicate_binding_id"
    | "binding_conversation_mismatch"
    | "binding_runtime_mismatch"
    | "missing_active_binding";

export type ConversationSwitchBlocker =
    | "conversation_not_idle"
    | "work_cycle_active"
    | "session_transition_pending"
    | "queued_messages_pending";

export interface ConversationSwitchContext {
    hasQueuedMessages?: boolean;
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

function applySelectionOptions(
    configOptions: readonly AIConfigOption[],
    options: Readonly<Record<string, string>>,
) {
    return configOptions.map((option) => ({
        ...option,
        value: options[option.id] ?? option.value,
    }));
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

/**
 * Compatibility adapter for legacy consumers. The active binding, not the
 * preferred next-turn selection, remains the projected runtime until routing
 * moves to canonical conversations in a later commit.
 */
export function projectCanonicalConversationToLegacy(
    conversation: AIConversation,
    binding: AcpConversationBinding,
    template: AIChatSession,
): AIChatSession {
    if (binding.conversationId !== conversation.conversationId) {
        throw new Error("Cannot project a binding owned by another conversation");
    }
    if (conversation.activeBindingId !== binding.bindingId) {
        throw new Error("Cannot project a binding that is not active");
    }

    return {
        ...template,
        historySessionId: conversation.conversationId,
        parentSessionId: conversation.parentConversationId,
        vaultPath: conversation.vaultPath,
        closedAt: conversation.closedAt,
        status: conversation.status,
        activeWorkCycleId: conversation.activeWorkCycleId,
        visibleWorkCycleId: conversation.visibleWorkCycleId,
        actionLog: conversation.actionLog,
        messages: conversation.messages,
        attachments: conversation.attachments,
        persistedCreatedAt: conversation.persistedCreatedAt,
        persistedUpdatedAt: conversation.persistedUpdatedAt,
        persistedTitle: conversation.persistedTitle,
        customTitle: conversation.customTitle,
        persistedPreview: conversation.persistedPreview,
        persistedMessageCount: conversation.persistedMessageCount,
        loadedPersistedMessageStart:
            conversation.loadedPersistedMessageStart,
        isLoadingPersistedMessages: conversation.isLoadingPersistedMessages,
        isPersistedSession: conversation.isPersistedSession,
        isPendingSessionCreation: conversation.isPendingSessionCreation,
        isResumingSession: conversation.isResumingSession,
        runtimeId: binding.runtimeId,
        runtimeDisplayName: binding.runtimeDisplayName,
        runtimeRevision: binding.runtimeRevision,
        runtimeLaunchFingerprint: binding.runtimeLaunchFingerprint,
        runtimeSessionId: binding.runtimeSessionId,
        continuationStrategy: binding.continuationStrategy,
        modelId: binding.modelId,
        modeId: binding.modeId,
        models: binding.models,
        modes: binding.modes,
        configOptions: applySelectionOptions(
            binding.configOptions,
            binding.options,
        ),
        availableCommands: binding.availableCommands,
        effortsByModel: binding.effortsByModel,
        runtimeState: binding.runtimeState,
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

/** Provider changes are only valid between turns and without queued work. */
export function getConversationSwitchBlocker(
    conversation: Pick<
        AIConversation,
        | "status"
        | "activeWorkCycleId"
        | "isPendingSessionCreation"
        | "isResumingSession"
    >,
    context: ConversationSwitchContext = {},
): ConversationSwitchBlocker | null {
    if (conversation.status !== "idle") return "conversation_not_idle";
    if (conversation.activeWorkCycleId) return "work_cycle_active";
    if (
        conversation.isPendingSessionCreation ||
        conversation.isResumingSession
    ) {
        return "session_transition_pending";
    }
    if (context.hasQueuedMessages) return "queued_messages_pending";
    return null;
}

export function canSwitchConversationProvider(
    conversation: Parameters<typeof getConversationSwitchBlocker>[0],
    context?: ConversationSwitchContext,
) {
    return getConversationSwitchBlocker(conversation, context) === null;
}
