import { cleanPillMarkers } from "./composerParts";
import type {
    AIChatSession,
    AIRuntimeDescriptor,
    AIRuntimeOption,
} from "./types";
import {
    getFirstUserTextMessage,
    getLastMeaningfulTranscriptMessage,
    getLastTranscriptMessage,
} from "./transcriptModel";

function truncateText(value: string, maxLength: number) {
    if (value.length <= maxLength) return value;
    return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

export function getSessionTitle(session: AIChatSession) {
    const custom = session.customTitle?.trim();
    if (custom) return truncateText(custom, 42);

    const firstUserText = getFirstUserTextMessage(session);
    const fallbackTitle = session.persistedTitle?.trim();

    if (!firstUserText) {
        return fallbackTitle || "New chat";
    }
    return truncateText(cleanPillMarkers(firstUserText.content), 42);
}

export function hasCustomTitle(session: AIChatSession) {
    return !!session.customTitle?.trim();
}

export function getSessionPreview(session: AIChatSession) {
    const lastMessage = getLastMeaningfulTranscriptMessage(session);
    if (!lastMessage) {
        return session.persistedPreview?.trim() || "No messages yet";
    }

    if (lastMessage.kind === "tool") {
        return truncateText(lastMessage.content, 72);
    }

    if (lastMessage.kind === "plan") {
        return truncateText(`Plan: ${lastMessage.content}`, 72);
    }

    if (lastMessage.kind === "permission") {
        return truncateText(`Permission: ${lastMessage.content}`, 72);
    }

    if (lastMessage.kind === "user_input_request") {
        return truncateText(`Input: ${lastMessage.content}`, 72);
    }

    if (lastMessage.kind === "error") {
        return truncateText(`Error: ${lastMessage.content}`, 72);
    }

    return truncateText(lastMessage.content, 72);
}

export function getRuntimeName(
    runtimeId: string | null | undefined,
    runtimes: AIRuntimeOption[],
) {
    if (!runtimeId) return "Chat";
    return (
        runtimes.find((runtime) => runtime.id === runtimeId)?.name ?? runtimeId
    );
}

export function getSessionRuntimeName(
    session: AIChatSession,
    runtimes: AIRuntimeOption[],
) {
    return getRuntimeName(session.runtimeId, runtimes);
}

export function getSessionUpdatedAt(session: AIChatSession) {
    return (
        getLastTranscriptMessage(session)?.timestamp ??
        session.persistedUpdatedAt ??
        0
    );
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

// ---------------------------------------------------------------------------
// Session stats (for history cards)
// ---------------------------------------------------------------------------

export interface SessionStats {
    messageCount: number;
    modelUsed: string;
    durationMs: number;
}

export function computeSessionStats(session: AIChatSession): SessionStats {
    return {
        messageCount: session.persistedMessageCount ?? session.messages.length,
        modelUsed: session.modelId || "",
        durationMs: computeDuration(session),
    };
}

function computeDuration(session: AIChatSession): number {
    const created = session.persistedCreatedAt ?? 0;
    const updated = session.persistedUpdatedAt ?? 0;
    return created > 0 && updated > created ? updated - created : 0;
}

export function formatDuration(ms: number): string {
    if (ms <= 0) return "";
    const minutes = Math.floor(ms / 60000);
    if (minutes < 1) return "<1m";
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const rem = minutes % 60;
    if (hours < 24) return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
}

// ---------------------------------------------------------------------------
// Date grouping (for history list)
// ---------------------------------------------------------------------------

export type DateGroup =
    | "Today"
    | "Yesterday"
    | "This week"
    | "This month"
    | "Older";

export const DATE_GROUP_ORDER: DateGroup[] = [
    "Today",
    "Yesterday",
    "This week",
    "This month",
    "Older",
];

export function getDateGroup(timestamp: number): DateGroup {
    if (!timestamp) return "Older";
    const now = new Date();
    const date = new Date(timestamp);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dateDay = new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
    );
    const diffDays = Math.floor(
        (today.getTime() - dateDay.getTime()) / 86400000,
    );
    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return "This week";
    if (
        date.getMonth() === now.getMonth() &&
        date.getFullYear() === now.getFullYear()
    )
        return "This month";
    return "Older";
}
