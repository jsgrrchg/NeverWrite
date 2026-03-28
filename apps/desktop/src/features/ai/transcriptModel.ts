import type { AIChatMessage, AIChatSession } from "./types";

export interface NormalizedTranscriptState {
    messageOrder: string[];
    messagesById: Record<string, AIChatMessage>;
    messageIndexById: Record<string, number>;
    lastAssistantMessageId: string | null;
    lastTurnStartedMessageId: string | null;
    activePlanMessageId: string | null;
}

export function isAssistantTextMessage(message: AIChatMessage) {
    return message.role === "assistant" && message.kind === "text";
}

export function isTurnStartedStatusMessage(message: AIChatMessage) {
    return (
        message.kind === "status" &&
        message.meta?.status_event === "turn_started"
    );
}

export function isIncompletePlanMessage(message: AIChatMessage) {
    if (message.kind !== "plan") {
        return false;
    }

    const entries = message.planEntries ?? [];
    return !(
        entries.length > 0 &&
        entries.every((entry) => entry.status === "completed")
    );
}

export function buildTranscriptState(
    messages: AIChatMessage[],
): NormalizedTranscriptState {
    const messageOrder: string[] = [];
    const messagesById: Record<string, AIChatMessage> = {};
    const messageIndexById: Record<string, number> = {};
    let lastAssistantMessageId: string | null = null;
    let lastTurnStartedMessageId: string | null = null;
    let activePlanMessageId: string | null = null;

    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        messageOrder.push(message.id);
        messagesById[message.id] = message;
        messageIndexById[message.id] = index;

        if (isAssistantTextMessage(message)) {
            lastAssistantMessageId = message.id;
        }

        if (isTurnStartedStatusMessage(message)) {
            lastTurnStartedMessageId = message.id;
        }

        if (isIncompletePlanMessage(message)) {
            activePlanMessageId = message.id;
        }
    }

    return {
        messageOrder,
        messagesById,
        messageIndexById,
        lastAssistantMessageId,
        lastTurnStartedMessageId,
        activePlanMessageId,
    };
}

export function replaceSessionTranscript(
    session: AIChatSession,
    messages: AIChatMessage[],
): AIChatSession {
    return {
        ...session,
        messages,
        ...buildTranscriptState(messages),
    };
}

export function hasNormalizedTranscript(session: AIChatSession) {
    if (
        !session.messageOrder ||
        !session.messagesById ||
        !session.messageIndexById
    ) {
        return false;
    }

    if (session.messageOrder.length !== session.messages.length) {
        return false;
    }

    const lastMessage = session.messages.at(-1);
    const lastOrderedId = session.messageOrder.at(-1) ?? null;

    if ((lastMessage?.id ?? null) !== lastOrderedId) {
        return false;
    }

    if (lastOrderedId == null) {
        return session.messages.length === 0;
    }

    return (
        session.messagesById[lastOrderedId] != null &&
        session.messageIndexById[lastOrderedId] === session.messages.length - 1
    );
}

export function normalizeSessionTranscript(session: AIChatSession) {
    if (hasNormalizedTranscript(session)) {
        return session;
    }

    return replaceSessionTranscript(session, session.messages);
}

export function getSessionTranscriptMessages(session: AIChatSession) {
    return normalizeSessionTranscript(session).messages;
}

export function getSessionTranscriptLength(session: AIChatSession) {
    return normalizeSessionTranscript(session).messageOrder?.length ?? 0;
}

export function getLastTranscriptMessage(session: AIChatSession) {
    const normalized = normalizeSessionTranscript(session);
    const lastMessageId = normalized.messageOrder?.at(-1) ?? null;
    if (!lastMessageId) {
        return null;
    }
    return normalized.messagesById?.[lastMessageId] ?? null;
}

export function getFirstUserTextMessage(session: AIChatSession) {
    const messages = getSessionTranscriptMessages(session);
    return (
        messages.find(
            (message) =>
                message.role === "user" &&
                message.kind === "text" &&
                message.content.trim().length > 0,
        ) ?? null
    );
}

export function getLastMeaningfulTranscriptMessage(session: AIChatSession) {
    const normalized = normalizeSessionTranscript(session);

    for (
        let index = normalized.messageOrder!.length - 1;
        index >= 0;
        index -= 1
    ) {
        const messageId = normalized.messageOrder![index];
        const message = normalized.messagesById![messageId];

        if (
            message &&
            message.kind !== "status" &&
            message.content.trim().length > 0
        ) {
            return message;
        }
    }

    return null;
}
