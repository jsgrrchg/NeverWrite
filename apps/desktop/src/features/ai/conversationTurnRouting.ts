import type {
    AcpConversationBinding,
    AIChatSession,
    ConversationBindingsState,
    ConversationSelection,
    ConversationTurnStartReason,
} from "./types";

export type ConversationTurnConnectionStrategy =
    | "continue"
    | "load"
    | "resume"
    | "create";

export interface ConversationTurnRoute {
    selection: ConversationSelection;
    targetBinding: AcpConversationBinding | null;
    strategy: ConversationTurnConnectionStrategy;
    startReason: ConversationTurnStartReason;
    providerChanged: boolean;
}

function selectReusableBinding(
    bindings: ConversationBindingsState,
    runtimeId: string,
) {
    const candidates = bindings.providerBindings.filter(
        (binding) => binding.runtimeId === runtimeId,
    );
    return (
        candidates.find(
            (binding) => binding.bindingId === bindings.activeBindingId,
        ) ??
        candidates.sort(
            (left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0),
        )[0] ??
        null
    );
}

function connectionStrategy(
    session: AIChatSession,
    bindings: ConversationBindingsState,
    targetBinding: AcpConversationBinding | null,
    capabilities: readonly string[],
): ConversationTurnConnectionStrategy {
    if (
        targetBinding?.bindingId === bindings.activeBindingId &&
        targetBinding.runtimeId === session.runtimeId &&
        session.runtimeState === "live" &&
        !session.isPersistedSession
    ) {
        return "continue";
    }
    if (!targetBinding?.runtimeSessionId) return "create";
    if (
        targetBinding.continuationStrategy === "load" ||
        capabilities.includes("load_session")
    ) {
        return "load";
    }
    if (
        targetBinding.continuationStrategy === "resume" ||
        capabilities.includes("resume_session")
    ) {
        return "resume";
    }
    return "create";
}

export function planConversationTurnRoute(input: {
    session: AIChatSession;
    bindings: ConversationBindingsState;
    selection: ConversationSelection;
    runtimeCapabilities: readonly string[];
    hasTranscript: boolean;
}): ConversationTurnRoute {
    const activeBinding = input.bindings.providerBindings.find(
        (binding) => binding.bindingId === input.bindings.activeBindingId,
    );
    const targetBinding = selectReusableBinding(
        input.bindings,
        input.selection.runtimeId,
    );
    const providerChanged =
        activeBinding != null &&
        activeBinding.runtimeId !== input.selection.runtimeId;
    const strategy = connectionStrategy(
        input.session,
        input.bindings,
        targetBinding,
        input.runtimeCapabilities,
    );
    const startReason: ConversationTurnStartReason = providerChanged
        ? "provider_switch"
        : strategy === "load" || strategy === "resume"
          ? "native_resume"
          : strategy === "create" && input.hasTranscript
            ? "transcript_handoff"
            : "normal";

    return {
        selection: {
            ...input.selection,
            options: { ...input.selection.options },
        },
        targetBinding,
        strategy,
        startReason,
        providerChanged,
    };
}
