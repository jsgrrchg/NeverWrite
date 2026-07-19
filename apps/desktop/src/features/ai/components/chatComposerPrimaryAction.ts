export type ComposerPrimaryAction =
    | "send"
    | "queue"
    | "stop"
    | "stopping"
    | "waiting";

export function getComposerPrimaryAction(input: {
    hasDraft: boolean;
    hasPendingSubmitAfterStop: boolean;
    isStopping: boolean;
    isStreaming: boolean;
}): ComposerPrimaryAction {
    if (input.hasPendingSubmitAfterStop) return "waiting";
    if (input.isStopping) return "stopping";
    if (input.isStreaming) return input.hasDraft ? "queue" : "stop";
    return "send";
}
