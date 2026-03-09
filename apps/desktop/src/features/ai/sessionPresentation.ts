import type { AIChatMessage, AIChatSession, AIRuntimeOption } from "./types";

function truncateText(value: string, maxLength: number) {
    if (value.length <= maxLength) return value;
    return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function getLastMeaningfulMessage(messages: AIChatMessage[]) {
    return [...messages]
        .reverse()
        .find((message) => message.content.trim().length > 0);
}

export function getSessionTitle(session: AIChatSession) {
    const firstUserText = session.messages.find(
        (message) =>
            message.role === "user" &&
            message.kind === "text" &&
            message.content.trim().length > 0,
    );

    if (!firstUserText) return "New chat";
    return truncateText(firstUserText.content, 42);
}

export function getSessionPreview(session: AIChatSession) {
    const lastMessage = getLastMeaningfulMessage(session.messages);
    if (!lastMessage) return "No messages yet";

    if (lastMessage.kind === "tool") {
        return truncateText(lastMessage.content, 72);
    }

    if (lastMessage.kind === "permission") {
        return truncateText(`Permission: ${lastMessage.content}`, 72);
    }

    if (lastMessage.kind === "error") {
        return truncateText(`Error: ${lastMessage.content}`, 72);
    }

    return truncateText(lastMessage.content, 72);
}

export function getSessionRuntimeName(
    session: AIChatSession,
    runtimes: AIRuntimeOption[],
) {
    return (
        runtimes.find((runtime) => runtime.id === session.runtimeId)?.name ??
        session.runtimeId
    );
}

export function getSessionUpdatedAt(session: AIChatSession) {
    return session.messages.at(-1)?.timestamp ?? 0;
}

export function formatSessionTime(timestamp: number) {
    if (!timestamp) return "";

    const now = Date.now();
    const diffMs = now - timestamp;
    const diffMinutes = Math.floor(diffMs / 60000);

    if (diffMinutes < 1) return "Now";
    if (diffMinutes < 60) return `${diffMinutes}m`;

    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return `${diffHours}h`;

    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays}d`;

    return new Intl.DateTimeFormat("en", {
        month: "short",
        day: "numeric",
    }).format(timestamp);
}
