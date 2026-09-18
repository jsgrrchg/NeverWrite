import { isCancellableChatTurnStatus } from "../chatTurnStatus";
import type { AIChatMessage, AIChatSessionStatus } from "../types";
import type { AssistantMessageMetadataMode } from "./AIChatMessageItem";

function workCycleTurnKey(workCycleId: string) {
    return `work-cycle:${workCycleId}`;
}

export function deriveAssistantMessageMetadataModes(
    messages: AIChatMessage[],
    status: AIChatSessionStatus,
): ReadonlyMap<string, AssistantMessageMetadataMode> {
    const lastAssistantMessageByTurn = new Map<string, AIChatMessage>();
    let legacyTurnIndex = 0;
    let currentTurnKey = `legacy:${legacyTurnIndex}`;
    let latestTurnKey = currentTurnKey;

    for (const message of messages) {
        if (message.kind === "text" && message.role === "user") {
            currentTurnKey = message.workCycleId
                ? workCycleTurnKey(message.workCycleId)
                : `legacy:${++legacyTurnIndex}`;
            latestTurnKey = currentTurnKey;
        } else if (message.workCycleId) {
            currentTurnKey = workCycleTurnKey(message.workCycleId);
            latestTurnKey = currentTurnKey;
        }

        if (
            message.kind !== "text" ||
            message.role !== "assistant" ||
            message.content.trim().length === 0
        ) {
            continue;
        }

        const turnKey = message.workCycleId
            ? workCycleTurnKey(message.workCycleId)
            : currentTurnKey;
        lastAssistantMessageByTurn.set(turnKey, message);
        latestTurnKey = turnKey;
    }

    const modes = new Map<string, AssistantMessageMetadataMode>();
    for (const message of lastAssistantMessageByTurn.values()) {
        modes.set(message.id, "available");
    }

    if (isCancellableChatTurnStatus(status)) {
        const activeTurnMessage =
            lastAssistantMessageByTurn.get(latestTurnKey);
        if (activeTurnMessage) {
            modes.set(
                activeTurnMessage.id,
                activeTurnMessage.inProgress === true
                    ? "reserved"
                    : "hidden",
            );
        }
    }

    return modes;
}
