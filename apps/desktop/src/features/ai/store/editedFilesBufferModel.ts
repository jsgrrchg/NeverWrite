import type {
    AIChatMessage,
    AIChatSession,
    AIEditedFileBufferEntry,
    AIFileDiff,
} from "../types";

const EMPTY_EDITED_FILES_BUFFER: AIEditedFileBufferEntry[] = [];

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
    const nextBuffers = {
        ...(session.editedFilesBufferByWorkCycleId ?? {}),
    };

    if (!keepVisibleCycle && session.visibleWorkCycleId) {
        const carryForward = nextBuffers[session.visibleWorkCycleId] ?? [];
        delete nextBuffers[session.visibleWorkCycleId];
        if (carryForward.length > 0) {
            nextBuffers[nextWorkCycleId] = carryForward;
        }
    }

    return syncEditedFilesBufferState({
        ...session,
        activeWorkCycleId: nextWorkCycleId,
        visibleWorkCycleId: keepVisibleCycle
            ? session.visibleWorkCycleId
            : nextWorkCycleId,
        editedFilesBufferByWorkCycleId: nextBuffers,
    });
}

export function ensureSessionWorkCycle(session: AIChatSession): AIChatSession {
    if (session.activeWorkCycleId) {
        return session;
    }

    const workCycleId = session.visibleWorkCycleId ?? createWorkCycleId();
    return syncEditedFilesBufferState({
        ...session,
        activeWorkCycleId: workCycleId,
        visibleWorkCycleId: session.visibleWorkCycleId ?? workCycleId,
    });
}

function splitDiffText(text?: string | null): string[] {
    if (!text) {
        return [];
    }

    return text.split("\n");
}

function computeLcsLength(oldLines: string[], newLines: string[]): number {
    const rows = oldLines.length + 1;
    const cols = newLines.length + 1;
    const table = Array.from({ length: rows }, () =>
        new Array<number>(cols).fill(0),
    );

    for (let row = 1; row < rows; row++) {
        for (let col = 1; col < cols; col++) {
            table[row][col] =
                oldLines[row - 1] === newLines[col - 1]
                    ? table[row - 1][col - 1] + 1
                    : Math.max(table[row - 1][col], table[row][col - 1]);
        }
    }

    return table[oldLines.length][newLines.length];
}

function computeDiffStatsFromPayload(diff: AIFileDiff) {
    const isText = diff.is_text !== false;
    if (!isText) {
        return { additions: 0, deletions: 0 };
    }

    const oldLines = splitDiffText(diff.old_text);
    const newLines = splitDiffText(diff.new_text);

    if (diff.kind === "add") {
        return { additions: newLines.length, deletions: 0 };
    }

    if (diff.kind === "delete") {
        if (diff.reversible === false) {
            return { additions: 0, deletions: 0, approximate: true };
        }
        return { additions: 0, deletions: oldLines.length };
    }

    if ((diff.old_text ?? "") === (diff.new_text ?? "")) {
        return { additions: 0, deletions: 0 };
    }

    const lcsLength = computeLcsLength(oldLines, newLines);
    return {
        additions: newLines.length - lcsLength,
        deletions: oldLines.length - lcsLength,
    };
}

function isDiffSupportedInV1(diff: AIFileDiff) {
    return diff.is_text !== false && diff.reversible !== false;
}

function getAppliedTextFromDiff(diff: AIFileDiff) {
    if (diff.kind === "delete") {
        return null;
    }

    if (diff.kind === "add") {
        return diff.new_text ?? null;
    }

    return diff.new_text ?? diff.old_text ?? null;
}

function getBaseTextFromDiff(diff: AIFileDiff) {
    if (diff.kind === "add") {
        return null;
    }

    return diff.old_text ?? null;
}

function getDiffLookupKey(diff: AIFileDiff) {
    return diff.kind === "move" && diff.previous_path
        ? diff.previous_path
        : diff.path;
}

function findEditedFileBufferEntryIndex(
    entries: AIEditedFileBufferEntry[],
    diff: AIFileDiff,
) {
    const lookupKey = getDiffLookupKey(diff);
    let index = entries.findIndex((entry) => entry.identityKey === lookupKey);

    if (index === -1 && diff.kind === "move" && diff.previous_path) {
        index = entries.findIndex(
            (entry) =>
                entry.path === diff.previous_path ||
                entry.originPath === diff.previous_path,
        );
    }

    return index;
}

function isEditedFileEntryReverted(entry: AIEditedFileBufferEntry) {
    if (!entry.supported) {
        return false;
    }

    return (
        entry.path === entry.originPath &&
        (entry.baseText ?? null) === (entry.appliedText ?? null)
    );
}

function hashTextContent(text: string | null | undefined) {
    if (text == null) {
        return null;
    }

    const bytes = new TextEncoder().encode(text);
    let hash = 0xcbf29ce484222325n;
    for (const byte of bytes) {
        hash ^= BigInt(byte);
        hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }

    return hash.toString(16).padStart(16, "0");
}

export function consolidateEditedFilesBuffer(
    entries: AIEditedFileBufferEntry[],
    diffs: AIFileDiff[],
    updatedAt: number,
) {
    let nextEntries = entries.slice();

    for (const diff of diffs) {
        const supported = isDiffSupportedInV1(diff);
        const stats = computeDiffStatsFromPayload(diff);
        const existingIndex = findEditedFileBufferEntryIndex(nextEntries, diff);
        const existingEntry =
            existingIndex >= 0 ? nextEntries[existingIndex] : null;
        const baseText = existingEntry?.baseText ?? getBaseTextFromDiff(diff);
        const appliedText = getAppliedTextFromDiff(diff);
        const nextEntry: AIEditedFileBufferEntry = {
            identityKey: diff.path,
            originPath:
                existingEntry?.originPath ?? diff.previous_path ?? diff.path,
            path: diff.path,
            previousPath: diff.previous_path ?? null,
            operation: diff.kind,
            baseText,
            appliedText,
            reversible: diff.reversible !== false,
            isText: diff.is_text !== false,
            supported,
            status: "pending",
            appliedHash: hashTextContent(appliedText),
            currentHash: null,
            additions: stats.additions,
            deletions: stats.deletions,
            approximate: stats.approximate,
            updatedAt,
            ...(diff.hunks && diff.hunks.length > 0
                ? { hunks: diff.hunks }
                : {}),
        };

        if (existingIndex === -1) {
            if (!isEditedFileEntryReverted(nextEntry)) {
                nextEntries.push(nextEntry);
            }
            continue;
        }

        if (isEditedFileEntryReverted(nextEntry)) {
            nextEntries = nextEntries.filter(
                (_, index) => index !== existingIndex,
            );
            continue;
        }

        nextEntries[existingIndex] = nextEntry;
    }

    return nextEntries;
}

export function deriveEditedFilesBufferFromLegacy(
    session: Pick<
        AIChatSession,
        | "activeWorkCycleId"
        | "visibleWorkCycleId"
        | "editedFilesBufferByWorkCycleId"
    >,
) {
    const buffers = session.editedFilesBufferByWorkCycleId;
    if (!buffers) {
        return [];
    }

    for (const workCycleId of [
        session.visibleWorkCycleId,
        session.activeWorkCycleId,
    ]) {
        if (!workCycleId) {
            continue;
        }

        const entries = buffers[workCycleId];
        if (entries?.length) {
            return entries;
        }
    }

    return Object.values(buffers).find((entries) => entries.length > 0) ?? [];
}

export function getEditedFilesBufferByWorkCycle(
    session: Pick<AIChatSession, "editedFilesBufferByWorkCycleId">,
    workCycleId?: string | null,
) {
    if (!workCycleId) {
        return [];
    }

    return session.editedFilesBufferByWorkCycleId?.[workCycleId] ?? [];
}

export function getVisibleEditedFilesBuffer(session: AIChatSession) {
    if (session.visibleWorkCycleId) {
        return getEditedFilesBufferByWorkCycle(
            session,
            session.visibleWorkCycleId,
        );
    }

    return (
        session.editedFilesBuffer ?? deriveEditedFilesBufferFromLegacy(session)
    );
}

export function getActiveEditedFilesBuffer(session: AIChatSession) {
    if (session.activeWorkCycleId) {
        return getEditedFilesBufferByWorkCycle(
            session,
            session.activeWorkCycleId,
        );
    }

    return getVisibleEditedFilesBuffer(session);
}

export function getSessionEditedFilesBuffer(session: AIChatSession) {
    return getVisibleEditedFilesBuffer(session);
}

function getFirstNonEmptyEditedFilesBufferWorkCycle(
    buffers: Record<string, AIEditedFileBufferEntry[]>,
) {
    for (const [workCycleId, entries] of Object.entries(buffers)) {
        if (entries.length > 0) {
            return workCycleId;
        }
    }

    return null;
}

export function syncEditedFilesBufferState(
    session: AIChatSession,
): AIChatSession {
    const nextBuffers: Record<string, AIEditedFileBufferEntry[]> =
        Object.fromEntries(
            Object.entries(session.editedFilesBufferByWorkCycleId ?? {}).filter(
                ([, entries]) => entries.length > 0,
            ),
        );
    if (Object.keys(nextBuffers).length === 0) {
        return {
            ...session,
            editedFilesBuffer: [],
            editedFilesBufferByWorkCycleId: {},
        };
    }

    let visibleWorkCycleId =
        session.visibleWorkCycleId &&
        nextBuffers[session.visibleWorkCycleId]?.length > 0
            ? session.visibleWorkCycleId
            : null;

    if (!visibleWorkCycleId) {
        visibleWorkCycleId =
            (session.activeWorkCycleId &&
            nextBuffers[session.activeWorkCycleId]?.length > 0
                ? session.activeWorkCycleId
                : null) ??
            getFirstNonEmptyEditedFilesBufferWorkCycle(nextBuffers);
    }

    const editedFilesBuffer = visibleWorkCycleId
        ? (nextBuffers[visibleWorkCycleId] ?? [])
        : [];

    return {
        ...session,
        visibleWorkCycleId,
        editedFilesBuffer,
        editedFilesBufferByWorkCycleId: nextBuffers,
    };
}

function replaceEditedFilesBufferForWorkCycle(
    session: AIChatSession,
    workCycleId: string | null | undefined,
    entries: AIEditedFileBufferEntry[],
) {
    const nextBuffers = {
        ...(session.editedFilesBufferByWorkCycleId ?? {}),
    };

    if (workCycleId) {
        if (entries.length > 0) {
            nextBuffers[workCycleId] = entries;
        } else {
            delete nextBuffers[workCycleId];
        }
    }

    const nextSession: AIChatSession = {
        ...session,
        editedFilesBufferByWorkCycleId: nextBuffers,
    };

    if (
        workCycleId &&
        session.visibleWorkCycleId === workCycleId &&
        entries.length === 0
    ) {
        nextSession.visibleWorkCycleId = null;
    }

    if (
        workCycleId &&
        session.activeWorkCycleId === workCycleId &&
        entries.length === 0 &&
        session.visibleWorkCycleId === workCycleId
    ) {
        nextSession.activeWorkCycleId = null;
    }

    return syncEditedFilesBufferState(nextSession);
}

export function setVisibleEditedFilesBuffer(
    session: AIChatSession,
    entries: AIEditedFileBufferEntry[],
) {
    const workCycleId = session.visibleWorkCycleId ?? session.activeWorkCycleId;
    if (!workCycleId) {
        return syncEditedFilesBufferState({
            ...session,
            editedFilesBufferByWorkCycleId: {},
        });
    }

    return replaceEditedFilesBufferForWorkCycle(session, workCycleId, entries);
}

export function setActiveEditedFilesBuffer(
    session: AIChatSession,
    entries: AIEditedFileBufferEntry[],
) {
    const workCycleId = session.activeWorkCycleId ?? session.visibleWorkCycleId;
    if (!workCycleId) {
        return syncEditedFilesBufferState(session);
    }

    return replaceEditedFilesBufferForWorkCycle(session, workCycleId, entries);
}

function updateVisibleEditedFilesBufferEntry(
    session: AIChatSession,
    identityKey: string,
    updater: (entry: AIEditedFileBufferEntry) => AIEditedFileBufferEntry,
) {
    const nextEntries = getSessionEditedFilesBuffer(session).map((entry) =>
        entry.identityKey === identityKey ? updater(entry) : entry,
    );

    return setVisibleEditedFilesBuffer(session, nextEntries);
}

export function markEditedFileEntryConflict(
    session: AIChatSession,
    identityKey: string,
    currentHash: string | null,
) {
    return updateVisibleEditedFilesBufferEntry(
        session,
        identityKey,
        (currentEntry) => ({
            ...currentEntry,
            status: "conflict",
            currentHash,
        }),
    );
}

export function removeEditedFilesBufferEntry(
    session: AIChatSession,
    identityKey: string,
) {
    const nextEntries = getSessionEditedFilesBuffer(session).filter(
        (entry) => entry.identityKey !== identityKey,
    );

    return setVisibleEditedFilesBuffer(session, nextEntries);
}

export function clearVisibleEditedFilesBuffer(session: AIChatSession) {
    if (getSessionEditedFilesBuffer(session).length === 0) {
        return session;
    }

    return setVisibleEditedFilesBuffer(session, []);
}

export function selectVisibleEditedFilesBuffer(
    state: {
        sessionsById: Record<string, AIChatSession>;
    },
    sessionId: string | null,
): AIEditedFileBufferEntry[] {
    if (!sessionId) return EMPTY_EDITED_FILES_BUFFER;
    const session = state.sessionsById[sessionId];
    if (!session) return EMPTY_EDITED_FILES_BUFFER;
    if (session.visibleWorkCycleId) {
        return (
            session.editedFilesBufferByWorkCycleId?.[
                session.visibleWorkCycleId
            ] ?? EMPTY_EDITED_FILES_BUFFER
        );
    }
    return session.editedFilesBuffer ?? EMPTY_EDITED_FILES_BUFFER;
}

export function selectVisibleEditedFilesBufferCount(
    state: {
        sessionsById: Record<string, AIChatSession>;
    },
    sessionId: string | null,
): number {
    return selectVisibleEditedFilesBuffer(state, sessionId).length;
}
