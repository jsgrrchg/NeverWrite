import {
    getSessionPreview,
    getSessionTitleText,
} from "./sessionPresentation";
import {
    buildAiSessionHierarchyGroups,
    type AiSessionHierarchyGroup,
} from "./sessionHierarchy";
import type { AgentSidebarSessionMetadata } from "./store/agentSidebarStore";
import type { AIChatMessage, AIChatSession } from "./types";

export type AgentSidebarStatus =
    | "review"
    | "approval"
    | "input"
    | "working"
    | "failed"
    | "done"
    | "ready";

export interface AgentSidebarGroup extends AiSessionHierarchyGroup {
    status: AgentSidebarStatus;
    workingStartedAt: number | null;
    latestActivityAt: number;
    lastCompletedAt: number | null;
}

export interface AgentSidebarProjectionInput {
    sessions: readonly AIChatSession[];
    metadataBySessionId: Readonly<
        Record<string, AgentSidebarSessionMetadata | undefined>
    >;
    pinnedOrder?: readonly string[];
    filterText?: string;
    focusedSessionId?: string | null;
    now: number;
}

export interface AgentSidebarProjection {
    rootSessionIds: string[];
    pinnedGroups: AgentSidebarGroup[];
    activeGroups: AgentSidebarGroup[];
    snoozedGroups: AgentSidebarGroup[];
    completedGroups: AgentSidebarGroup[];
    searchResults: AgentSidebarGroup[];
}

const EMPTY_METADATA: AgentSidebarSessionMetadata = {
    pinnedAt: null,
    completedAt: null,
    snoozedAt: null,
    snoozedUntil: null,
    lastVisitedAt: null,
};

const STATUS_PRIORITY: Record<AgentSidebarStatus, number> = {
    review: 0,
    approval: 1,
    input: 2,
    working: 3,
    failed: 4,
    done: 5,
    ready: 6,
};

function transcriptMessages(session: AIChatSession): readonly AIChatMessage[] {
    if (session.messageOrder && session.messagesById) {
        return session.messageOrder.flatMap((id) => {
            const message = session.messagesById?.[id];
            return message ? [message] : [];
        });
    }
    return session.messages;
}

function isTransientRecoveryMessage(message: AIChatMessage) {
    return (
        message.kind === "status" &&
        message.meta?.status_event === "session_recovery"
    );
}

function latestActivityTimestamp(session: AIChatSession) {
    const latestTranscriptTimestamp = transcriptMessages(session).reduce(
        (latest, message) =>
            isTransientRecoveryMessage(message)
                ? latest
                : Math.max(latest, message.timestamp),
        0,
    );
    return Math.max(latestTranscriptTimestamp, session.persistedUpdatedAt ?? 0);
}

function latestAssistantTimestamp(session: AIChatSession) {
    let latest: number | null = null;
    for (const message of transcriptMessages(session)) {
        if (message.role !== "assistant" || !Number.isFinite(message.timestamp)) {
            continue;
        }
        latest = Math.max(latest ?? 0, message.timestamp);
    }
    return latest;
}

export function getAgentSidebarWorkingStartedAt(session: AIChatSession) {
    const isWorking =
        session.status === "streaming" ||
        session.isPendingSessionCreation === true;
    if (!isWorking) return null;

    const activeCycleId = session.activeWorkCycleId?.trim();
    const timestamps = transcriptMessages(session)
        .filter(
            (message) =>
                !activeCycleId || message.workCycleId === activeCycleId,
        )
        .map((message) => message.timestamp)
        .filter((timestamp) => Number.isFinite(timestamp) && timestamp > 0);
    if (timestamps.length > 0) return Math.min(...timestamps);
    return session.persistedCreatedAt ?? null;
}

export function resolveAgentSidebarSessionStatus(
    session: AIChatSession,
    metadata: AgentSidebarSessionMetadata = EMPTY_METADATA,
): AgentSidebarStatus {
    switch (session.status) {
        case "review_required":
            return "review";
        case "waiting_permission":
            return "approval";
        case "waiting_user_input":
            return "input";
        case "streaming":
            return "working";
        case "error":
            return "failed";
        case "idle": {
            if (session.isPendingSessionCreation) {
                return "working";
            }
            const completedAt = latestAssistantTimestamp(session);
            if (
                completedAt !== null &&
                completedAt > (metadata.lastVisitedAt ?? 0)
            ) {
                return "done";
            }
            return "ready";
        }
    }
}

export function agentSidebarStatusNeedsAttention(status: AgentSidebarStatus) {
    return (
        status === "review" ||
        status === "approval" ||
        status === "input" ||
        status === "failed"
    );
}

export function canCompleteAgentSidebarStatus(status: AgentSidebarStatus) {
    return ![
        "review",
        "approval",
        "input",
        "working",
    ].includes(status);
}

function decorateGroup(
    group: AiSessionHierarchyGroup,
    metadataBySessionId: AgentSidebarProjectionInput["metadataBySessionId"],
): AgentSidebarGroup {
    const sessions = [group.root, ...group.children];
    const presentations = sessions.map((session) => ({
        session,
        status: resolveAgentSidebarSessionStatus(
            session,
            metadataBySessionId[group.root.sessionId] ?? EMPTY_METADATA,
        ),
    }));
    const status = presentations.reduce<AgentSidebarStatus>(
        (highest, candidate) =>
            STATUS_PRIORITY[candidate.status] < STATUS_PRIORITY[highest]
                ? candidate.status
                : highest,
        "ready",
    );
    const workingStarts = presentations.flatMap(({ session, status: itemStatus }) => {
        if (itemStatus !== "working") return [];
        const startedAt = getAgentSidebarWorkingStartedAt(session);
        return startedAt === null ? [] : [startedAt];
    });
    const completionTimestamps = sessions.flatMap((session) => {
        const completedAt = latestAssistantTimestamp(session);
        return completedAt === null ? [] : [completedAt];
    });
    return {
        ...group,
        status,
        workingStartedAt:
            workingStarts.length > 0 ? Math.min(...workingStarts) : null,
        latestActivityAt: sessions.reduce(
            (latest, session) =>
                Math.max(latest, latestActivityTimestamp(session)),
            0,
        ),
        lastCompletedAt:
            completionTimestamps.length > 0
                ? Math.max(...completionTimestamps)
                : null,
    };
}

function creationTimestamp(group: AgentSidebarGroup) {
    const timestamps = [group.root, ...group.children].flatMap((session) => {
        const persisted = session.persistedCreatedAt;
        if (persisted && Number.isFinite(persisted)) return [persisted];
        const first = transcriptMessages(session)
            .map((message) => message.timestamp)
            .filter((timestamp) => Number.isFinite(timestamp) && timestamp > 0)
            .sort((left, right) => left - right)[0];
        return first ? [first] : [];
    });
    return timestamps.length > 0 ? Math.min(...timestamps) : 0;
}

function fallbackComparison(left: AgentSidebarGroup, right: AgentSidebarGroup) {
    return (
        creationTimestamp(right) - creationTimestamp(left) ||
        left.root.sessionId.localeCompare(right.root.sessionId)
    );
}

function activityComparison(left: AgentSidebarGroup, right: AgentSidebarGroup) {
    return (
        right.latestActivityAt - left.latestActivityAt ||
        fallbackComparison(left, right)
    );
}

export function applyPreferredAgentOrder(
    groups: readonly AgentSidebarGroup[],
    preferredIds: readonly string[],
) {
    const byId = new Map(
        groups.map((group) => [group.root.sessionId, group] as const),
    );
    const preferred = preferredIds.flatMap((id) => {
        const group = byId.get(id);
        if (!group) return [];
        byId.delete(id);
        return [group];
    });
    return [
        ...preferred,
        ...Array.from(byId.values()).sort(fallbackComparison),
    ];
}

export function isEffectivelySnoozed(
    group: AgentSidebarGroup,
    metadata: AgentSidebarSessionMetadata,
    now: number,
) {
    return (
        metadata.snoozedUntil !== null &&
        metadata.snoozedUntil > now &&
        !agentSidebarStatusNeedsAttention(group.status)
    );
}

export function isEffectivelyCompleted(
    group: AgentSidebarGroup,
    metadata: AgentSidebarSessionMetadata,
) {
    return (
        metadata.completedAt !== null &&
        group.latestActivityAt <= metadata.completedAt &&
        !agentSidebarStatusNeedsAttention(group.status)
    );
}

function groupMatchesFilter(group: AgentSidebarGroup, normalizedFilter: string) {
    return [group.root, ...group.children].some(
        (session) =>
            getSessionTitleText(session).toLowerCase().includes(normalizedFilter) ||
            getSessionPreview(session).toLowerCase().includes(normalizedFilter),
    );
}

export function buildAgentSidebarProjection({
    sessions,
    metadataBySessionId,
    pinnedOrder = [],
    filterText = "",
    now,
}: AgentSidebarProjectionInput): AgentSidebarProjection {
    const hierarchy = buildAiSessionHierarchyGroups({ sessions: [...sessions] });
    const groups = hierarchy.groups.map((group) =>
        decorateGroup(group, metadataBySessionId),
    );
    const normalizedFilter = filterText.trim().toLowerCase();
    if (normalizedFilter) {
        const filteredHierarchy = buildAiSessionHierarchyGroups({
            sessions: [...sessions],
            normalizedFilter,
        });
        return {
            rootSessionIds: hierarchy.rootSessionIds,
            pinnedGroups: [],
            activeGroups: [],
            snoozedGroups: [],
            completedGroups: [],
            searchResults: filteredHierarchy.groups
                .map((group) => decorateGroup(group, metadataBySessionId))
                .filter((group) => groupMatchesFilter(group, normalizedFilter))
                .sort(fallbackComparison),
        };
    }

    const pinned: AgentSidebarGroup[] = [];
    const active: AgentSidebarGroup[] = [];
    const snoozed: AgentSidebarGroup[] = [];
    const completed: AgentSidebarGroup[] = [];
    for (const group of groups) {
        const metadata =
            metadataBySessionId[group.root.sessionId] ?? EMPTY_METADATA;
        if (isEffectivelySnoozed(group, metadata, now)) {
            snoozed.push(group);
        } else if (isEffectivelyCompleted(group, metadata)) {
            completed.push(group);
        } else if (metadata.pinnedAt !== null) {
            pinned.push(group);
        } else {
            active.push(group);
        }
    }

    return {
        rootSessionIds: hierarchy.rootSessionIds,
        pinnedGroups: applyPreferredAgentOrder(pinned, pinnedOrder),
        activeGroups: active.sort(activityComparison),
        snoozedGroups: snoozed.sort((left, right) => {
            const leftWake =
                metadataBySessionId[left.root.sessionId]?.snoozedUntil ?? Infinity;
            const rightWake =
                metadataBySessionId[right.root.sessionId]?.snoozedUntil ?? Infinity;
            return leftWake - rightWake || fallbackComparison(left, right);
        }),
        completedGroups: completed.sort((left, right) => {
            const leftCompleted =
                metadataBySessionId[left.root.sessionId]?.completedAt ?? 0;
            const rightCompleted =
                metadataBySessionId[right.root.sessionId]?.completedAt ?? 0;
            return rightCompleted - leftCompleted || fallbackComparison(left, right);
        }),
        searchResults: [],
    };
}
