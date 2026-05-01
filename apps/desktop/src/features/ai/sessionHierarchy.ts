import {
    getSessionPreview,
    getSessionTitleText,
    getSessionUpdatedAt,
} from "./sessionPresentation";
import type { AIChatSession } from "./types";

export interface AiSessionHierarchyGroup {
    root: AIChatSession;
    children: AIChatSession[];
    visibleChildren: AIChatSession[];
    isDetachedAgent: boolean;
    isPinnedRoot: boolean;
    hasOpenSession: boolean;
    latestUpdatedAt: number;
    sessionIds: string[];
}

export interface AiSessionHierarchyResult {
    groups: AiSessionHierarchyGroup[];
    rootSessionIds: string[];
}

interface BuildAiSessionHierarchyGroupsOptions {
    sessions: AIChatSession[];
    normalizedFilter?: string;
    openSessionIds?: ReadonlySet<string>;
    pinnedSessionIds?: ReadonlySet<string>;
}

function normalizeSessionRef(value: string | null | undefined) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}

function sessionLookupKeys(session: AIChatSession) {
    return [
        normalizeSessionRef(session.sessionId),
        normalizeSessionRef(session.historySessionId),
        normalizeSessionRef(session.runtimeSessionId),
    ].filter((key): key is string => Boolean(key));
}

function sessionMatchesFilter(session: AIChatSession, normalizedFilter: string) {
    if (!normalizedFilter) return true;
    const title = getSessionTitleText(session).toLowerCase();
    if (title.includes(normalizedFilter)) return true;
    return getSessionPreview(session).toLowerCase().includes(normalizedFilter);
}

function compareSessionsByUpdatedAtDesc(
    left: AIChatSession,
    right: AIChatSession,
) {
    return getSessionUpdatedAt(right) - getSessionUpdatedAt(left);
}

export function compareHierarchyGroupsByUpdatedAtDesc(
    left: AiSessionHierarchyGroup,
    right: AiSessionHierarchyGroup,
) {
    return right.latestUpdatedAt - left.latestUpdatedAt;
}

export function buildAiSessionHierarchyGroups({
    sessions,
    normalizedFilter = "",
    openSessionIds = new Set<string>(),
    pinnedSessionIds = new Set<string>(),
}: BuildAiSessionHierarchyGroupsOptions): AiSessionHierarchyResult {
    const lookup = new Map<string, AIChatSession>();
    for (const session of sessions) {
        for (const key of sessionLookupKeys(session)) {
            if (!lookup.has(key)) {
                lookup.set(key, session);
            }
        }
    }

    const childrenByParentId = new Map<string, AIChatSession[]>();
    const roots: Array<{ session: AIChatSession; isDetachedAgent: boolean }> =
        [];

    for (const session of sessions) {
        const parentRef = normalizeSessionRef(session.parentSessionId);
        const parent = parentRef ? lookup.get(parentRef) : null;
        if (parent && parent.sessionId !== session.sessionId) {
            const children = childrenByParentId.get(parent.sessionId) ?? [];
            children.push(session);
            childrenByParentId.set(parent.sessionId, children);
            continue;
        }

        roots.push({
            session,
            isDetachedAgent: Boolean(parentRef),
        });
    }

    const groups: AiSessionHierarchyGroup[] = [];
    const rootSessionIds: string[] = [];

    for (const { session: root, isDetachedAgent } of roots) {
        rootSessionIds.push(root.sessionId);
        const children = [
            ...(childrenByParentId.get(root.sessionId) ?? []),
        ].sort(compareSessionsByUpdatedAtDesc);
        const rootMatches = sessionMatchesFilter(root, normalizedFilter);
        const matchingChildren = normalizedFilter
            ? children.filter((child) =>
                  sessionMatchesFilter(child, normalizedFilter),
              )
            : children;

        if (normalizedFilter && !rootMatches && matchingChildren.length === 0) {
            continue;
        }

        const visibleChildren =
            normalizedFilter && !rootMatches ? matchingChildren : children;
        const sessionIds = [
            root.sessionId,
            ...children.map((child) => child.sessionId),
        ];
        const latestUpdatedAt = [root, ...children].reduce(
            (latest, candidate) =>
                Math.max(latest, getSessionUpdatedAt(candidate)),
            0,
        );

        groups.push({
            root,
            children,
            visibleChildren,
            isDetachedAgent,
            isPinnedRoot: pinnedSessionIds.has(root.sessionId),
            hasOpenSession: sessionIds.some((sessionId) =>
                openSessionIds.has(sessionId),
            ),
            latestUpdatedAt,
            sessionIds,
        });
    }

    return { groups, rootSessionIds };
}
