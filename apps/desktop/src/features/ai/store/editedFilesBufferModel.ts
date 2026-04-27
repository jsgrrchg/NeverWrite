import type { AIChatMessage, AIChatSession } from "../types";
import type { TrackedFile } from "../diff/actionLogTypes";
import {
    getTrackedFilesForSession,
    setTrackedFilesForWorkCycle,
} from "./actionLogModel";
import { getSessionTranscriptMessages } from "../transcriptModel";

const EMPTY_TRACKED_FILES: TrackedFile[] = [];

// Cache Object.values(tracked) per tracked-files snapshot so different
// sessions do not clobber each other's selector results.
const _trackedFilesCache = new WeakMap<
    Record<string, TrackedFile>,
    TrackedFile[]
>();

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
    const cycleMessages = getSessionTranscriptMessages(session).filter(
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
    if (nextActionLog) {
        const accumulatedFiles = getTrackedFilesForSession(nextActionLog);
        nextActionLog = {
            ...nextActionLog,
            trackedFilesByIdentityKey: {},
            trackedFileIdsByWorkCycleId: {},
            trackedFilesByWorkCycleId: {},
        };
        if (Object.keys(accumulatedFiles).length > 0) {
            nextActionLog = setTrackedFilesForWorkCycle(
                nextActionLog,
                nextWorkCycleId,
                accumulatedFiles,
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

    const tracked = getTrackedFilesForSession(session.actionLog);

    if (Object.keys(tracked).length === 0) {
        return EMPTY_TRACKED_FILES;
    }

    const cachedFiles = _trackedFilesCache.get(tracked);
    if (cachedFiles) {
        return cachedFiles;
    }

    const nextFiles = Object.values(tracked);
    _trackedFilesCache.set(tracked, nextFiles);
    return nextFiles;
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
