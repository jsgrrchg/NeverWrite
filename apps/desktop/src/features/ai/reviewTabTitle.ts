import type { AIChatSession, AIRuntimeDescriptor } from "./types";

function normalizeReviewAgentName(name?: string | null) {
    const trimmed = name?.trim();
    if (!trimmed) {
        return "Assistant";
    }

    return trimmed.replace(/ ACP$/, "");
}

export function getReviewTabTitle(
    session: Pick<AIChatSession, "runtimeId"> | null | undefined,
    runtimes: AIRuntimeDescriptor[],
) {
    const runtimeName = runtimes.find(
        (descriptor) => descriptor.runtime.id === session?.runtimeId,
    )?.runtime.name;

    return `Review ${normalizeReviewAgentName(runtimeName)}`;
}
