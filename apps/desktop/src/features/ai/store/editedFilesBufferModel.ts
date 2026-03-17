import type { AIChatMessage, AIChatSession } from "../types";
import type { TrackedFile } from "../diff/actionLogTypes";
import {
    getTrackedFilesForWorkCycle,
    setTrackedFilesForWorkCycle,
} from "./actionLogModel";

const EMPTY_TRACKED_FILES: TrackedFile[] = [];

// Cache for Object.values(tracked) to maintain referential stability.
// Zustand immutable updates guarantee that actionLog reference only changes
// when data actually changes, so we can use it as a cache key.
let _cachedTracked: Record<string, TrackedFile> | null = null;
let _cachedFiles: TrackedFile[] = EMPTY_TRACKED_FILES;

function hasDiffBuffer(message: AIChatMessage) {
    return (message.diffs?.length ?? 0) > 0;
}

function isPendingPermissionBuffer(message: AIChatMessage) {
    if (message.kind !== "permission" || !hasDiffBuffer(message)) {
        return false;
    }

    const status = String(message.meta?.status ?? "pending");
    return status === "pending" || status === "responding";
}

function isWorkCycleResolved(session: AIChatSession, workCycleId: string) {
    const cycleMessages = session.messages.filter(
        (message) =>
            message.workCycleId === workCycleId && hasDiffBuffer(message),
    );

    if (cycleMessages.length === 0) {
        return true;
    }

    return !cycleMessages.some(isPendingPermissionBuffer);
}

export function createWorkCycleId() {
    return crypto.randomUUID();
}

export function startNewWorkCycle(session: AIChatSession): AIChatSession {
    const nextWorkCycleId = createWorkCycleId();
    const keepVisibleCycle =
        session.visibleWorkCycleId &&
        !isWorkCycleResolved(session, session.visibleWorkCycleId);

    // Carry forward actionLog tracked files to the new work cycle so
    // they accumulate across prompts until the user explicitly resets.
    let nextActionLog = session.actionLog;
    const oldCycleId = keepVisibleCycle ? null : session.visibleWorkCycleId;

    if (oldCycleId && nextActionLog) {
        const oldFiles = getTrackedFilesForWorkCycle(nextActionLog, oldCycleId);
        if (Object.keys(oldFiles).length > 0) {
            // Move tracked files from old cycle to new cycle
            nextActionLog = setTrackedFilesForWorkCycle(
                nextActionLog,
                oldCycleId,
                {},
            );
            nextActionLog = setTrackedFilesForWorkCycle(
                nextActionLog,
                nextWorkCycleId,
                oldFiles,
            );
        }
    }

    return {
        ...session,
        actionLog: nextActionLog,
        activeWorkCycleId: nextWorkCycleId,
        visibleWorkCycleId: keepVisibleCycle
            ? session.visibleWorkCycleId
            : nextWorkCycleId,
    };
}

export function ensureSessionWorkCycle(session: AIChatSession): AIChatSession {
    if (session.activeWorkCycleId) {
        return session;
    }

    const workCycleId = session.visibleWorkCycleId ?? createWorkCycleId();
    return {
        ...session,
        activeWorkCycleId: workCycleId,
        visibleWorkCycleId: session.visibleWorkCycleId ?? workCycleId,
    };
}

// ---------------------------------------------------------------------------
// Selectors (read from ActionLog, return TrackedFile[])
// ---------------------------------------------------------------------------

export function selectVisibleTrackedFiles(
    state: {
        sessionsById: Record<string, AIChatSession>;
    },
    sessionId: string | null,
): TrackedFile[] {
    if (!sessionId) return EMPTY_TRACKED_FILES;
    const session = state.sessionsById[sessionId];
    if (!session?.actionLog) return EMPTY_TRACKED_FILES;

    const workCycleId = session.visibleWorkCycleId ?? session.activeWorkCycleId;
    const tracked = getTrackedFilesForWorkCycle(session.actionLog, workCycleId);
    if (Object.keys(tracked).length === 0) {
        return EMPTY_TRACKED_FILES;
    }

    // Cache to maintain referential stability — Zustand's immutable
    // updates guarantee `tracked` reference only changes on real mutations.
    if (tracked !== _cachedTracked) {
        _cachedTracked = tracked;
        _cachedFiles = Object.values(tracked);
    }
    return _cachedFiles;
}

export function selectVisibleTrackedFilesCount(
    state: {
        sessionsById: Record<string, AIChatSession>;
    },
    sessionId: string | null,
): number {
    return selectVisibleTrackedFiles(state, sessionId).length;
}

export function selectHasUndoReject(
    state: {
        sessionsById: Record<string, AIChatSession>;
    },
    sessionId: string | null,
): boolean {
    if (!sessionId) return false;
    const session = state.sessionsById[sessionId];
    if (!session?.actionLog?.lastRejectUndo) return false;
    return Object.keys(session.actionLog.lastRejectUndo.snapshots).length > 0;
}
