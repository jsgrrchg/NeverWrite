import type { AIChatSessionStatus } from "./types";

export function isCancellableChatTurnStatus(
    status: AIChatSessionStatus | null | undefined,
): boolean {
    return (
        status === "streaming" ||
        status === "waiting_permission" ||
        status === "waiting_user_input"
    );
}
