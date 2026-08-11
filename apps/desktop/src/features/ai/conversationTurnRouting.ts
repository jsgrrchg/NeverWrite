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
    initialProviderChanged: boolean;
}

function selectActiveBinding(bindings: ConversationBindingsState) {
    return (
        bindings.providerBindings.find(
            (binding) => binding.bindingId === bindings.activeBindingId,
        ) ?? null
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
    const activeBinding = selectActiveBinding(input.bindings);
    const initialProviderChanged =
        input.session.runtimeId !== input.selection.runtimeId;
    if (initialProviderChanged && input.hasTranscript) {
        throw new Error(
            "Cannot change the provider after the conversation has started.",
        );
    }
    const targetBinding = initialProviderChanged ? null : activeBinding;
    const strategy = connectionStrategy(
        input.session,
        input.bindings,
        targetBinding,
        input.runtimeCapabilities,
    );
    const startReason: ConversationTurnStartReason =
        strategy === "load" || strategy === "resume"
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
        initialProviderChanged,
    };
}
