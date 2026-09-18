import type {
    AIChatSession,
    AIConfigOption,
    ConversationSelection,
} from "./types";

/**
 * Restore preferences against the target model's authoritative ACP catalog.
 * Only values advertised by an earlier catalog are eligible for fallback;
 * unknown requests and provider/model/mode validation remain strict.
 */
export function reconcileInheritedAcpOptions(
    session: Pick<AIChatSession, "runtimeId" | "modelId" | "configOptions">,
    selection: ConversationSelection,
    previousOptions: readonly AIConfigOption[],
): ConversationSelection {
    const modelValue = session.configOptions.find(
        (option) => option.category === "model",
    )?.value;
    if (
        selection.runtimeId !== session.runtimeId ||
        (selection.modelId !== session.modelId &&
            selection.modelId !== modelValue)
    ) {
        return selection;
    }

    const options = { ...selection.options };
    for (const [id, value] of Object.entries(options)) {
        const current = session.configOptions.find(
            (option) => option.id === id,
        );
        const previous = previousOptions.filter(
            (option) =>
                option.runtimeId === selection.runtimeId && option.id === id,
        );
        if (
            id === "model" ||
            id === "mode" ||
            [current, ...previous].some(
                (option) =>
                    option?.category === "model" || option?.category === "mode",
            ) ||
            !previous.some(
                (option) =>
                    option.value === value ||
                    option.options.some(
                        (candidate) => candidate.value === value,
                    ),
            )
        ) {
            continue;
        }
        if (!current) {
            delete options[id];
        } else if (
            current.value !== value &&
            !current.options.some((candidate) => candidate.value === value)
        ) {
            options[id] = current.value;
        }
    }
    return { ...selection, options };
}
