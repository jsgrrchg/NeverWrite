export const MAX_RETIRED_TERMINAL_SESSION_IDS = 256;

export function allocateTabSessionVersion(
    versionsByTabId: Map<string, number>,
    nextVersionRef: { current: number },
    tabId: string,
) {
    const nextVersion = nextVersionRef.current;
    nextVersionRef.current += 1;
    versionsByTabId.set(tabId, nextVersion);
    return nextVersion;
}

export function deleteTabSessionVersions(
    versionsByTabId: Map<string, number>,
    tabIds: Iterable<string>,
) {
    for (const tabId of tabIds) {
        versionsByTabId.delete(tabId);
    }
}

export function collectSessionIdsToClose(
    sessionIds: string[],
    retiredSessionIds: Map<string, true>,
    pendingOutputBySessionId: Map<string, string>,
    maxTrackedRetiredSessionIds = MAX_RETIRED_TERMINAL_SESSION_IDS,
) {
    const nextSessionIds: string[] = [];

    for (const sessionId of new Set(sessionIds)) {
        if (!sessionId) continue;

        pendingOutputBySessionId.delete(sessionId);

        if (retiredSessionIds.has(sessionId)) {
            continue;
        }

        retiredSessionIds.set(sessionId, true);
        nextSessionIds.push(sessionId);

        while (retiredSessionIds.size > maxTrackedRetiredSessionIds) {
            const oldestSessionId = retiredSessionIds.keys().next().value;
            if (!oldestSessionId) {
                break;
            }
            retiredSessionIds.delete(oldestSessionId);
        }
    }

    return nextSessionIds;
}
