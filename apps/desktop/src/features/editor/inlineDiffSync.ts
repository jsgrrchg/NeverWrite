import type { EditorView } from "@codemirror/view";
import type { AgentTextSpan, LineEdit } from "../ai/diff/actionLogTypes";
import type { InlineDiffState } from "./extensions/inlineDiff";
import {
    getTrackedFilesForSession,
    syncDerivedLinePatch,
    shouldShowInlineDiff,
} from "../ai/store/actionLogModel";
import type { AIChatSession } from "../ai/types";
import {
    clearInlineDiff,
    inlineDiffField,
    setInlineDiff,
} from "./extensions/inlineDiff";

function normalizePath(path: string) {
    return path.replace(/\\/g, "/");
}

function matchesTrackedFilePath(targetPath: string, candidatePath: string) {
    const normalizedTarget = normalizePath(targetPath);
    const normalizedCandidate = normalizePath(candidatePath);

    if (normalizedTarget === normalizedCandidate) {
        return true;
    }

    if (!normalizedCandidate.startsWith("/")) {
        return normalizedTarget.endsWith(`/${normalizedCandidate}`);
    }

    return false;
}

function editsEqual(a: LineEdit[], b: LineEdit[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((edit, index) => {
        const other = b[index];
        return (
            edit.oldStart === other.oldStart &&
            edit.oldEnd === other.oldEnd &&
            edit.newStart === other.newStart &&
            edit.newEnd === other.newEnd
        );
    });
}

function spansEqual(a: AgentTextSpan[], b: AgentTextSpan[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((span, index) => {
        const other = b[index];
        return (
            span.baseFrom === other.baseFrom &&
            span.baseTo === other.baseTo &&
            span.currentFrom === other.currentFrom &&
            span.currentTo === other.currentTo
        );
    });
}

function deletedTextsEqual(a: string[][], b: string[][]): boolean {
    if (a.length !== b.length) return false;
    return a.every((lines, index) => {
        const other = b[index];
        if (lines.length !== other.length) return false;
        return lines.every((line, lineIndex) => line === other[lineIndex]);
    });
}

function inlineDiffStatesEqual(
    current: InlineDiffState,
    next: InlineDiffState,
): boolean {
    return (
        current.sessionId === next.sessionId &&
        current.identityKey === next.identityKey &&
        current.diffBase === next.diffBase &&
        current.reviewState === next.reviewState &&
        current.version === next.version &&
        editsEqual(current.edits, next.edits) &&
        spansEqual(current.spans, next.spans) &&
        deletedTextsEqual(current.deletedTexts, next.deletedTexts)
    );
}

function dispatchInlineDiffEffect(
    view: EditorView,
    effect:
        | ReturnType<typeof setInlineDiff.of>
        | ReturnType<typeof clearInlineDiff.of>,
) {
    view.dispatch({
        effects: [view.scrollSnapshot(), effect],
    });
}

export function syncInlineDiffForPaths(
    view: EditorView | null,
    candidatePaths: string[],
    sessionsById: Record<string, AIChatSession>,
) {
    if (!view) return;

    const normalizedCandidates = candidatePaths
        .map((path) => normalizePath(path))
        .filter((path) => path.length > 0);
    const currentDiffState = view.state.field(inlineDiffField);

    if (normalizedCandidates.length === 0) {
        if (currentDiffState.edits.length > 0) {
            dispatchInlineDiffEffect(view, clearInlineDiff.of(null));
        }
        return;
    }

    let foundEdits: import("../ai/diff/actionLogTypes").LineEdit[] = [];
    let foundSpans: import("../ai/diff/actionLogTypes").AgentTextSpan[] = [];
    let foundSessionId: string | null = null;
    let foundIdentityKey: string | null = null;
    let foundVersion = 0;
    let foundDiffBase = "";
    let foundReviewState: "pending" | "finalized" = "finalized";
    // Track whether we actually found a matching tracked file in any session.
    // When false, we only retain the current decorations while the inline diff
    // is still pending, to bridge short async consolidation gaps without
    // leaving finalized decorations stuck after Keep/Reject.
    let foundFile = false;

    for (const [sessionId, session] of Object.entries(sessionsById)) {
        if (!session.actionLog) continue;

        const files = getTrackedFilesForSession(session.actionLog);

        let tracked: import("../ai/diff/actionLogTypes").TrackedFile | null =
            null;
        for (const file of Object.values(files)) {
            const pathsToCheck = [file.path, file.identityKey];
            if (
                normalizedCandidates.some((candidate) =>
                    pathsToCheck.some((path) =>
                        matchesTrackedFilePath(path, candidate),
                    ),
                )
            ) {
                tracked = file;
                break;
            }
        }

        if (!tracked) continue;
        foundFile = true;

        const syncedTracked = syncDerivedLinePatch(tracked);
        if (!shouldShowInlineDiff(syncedTracked)) {
            continue;
        }

        foundEdits = syncedTracked.unreviewedEdits.edits;
        foundSpans = syncedTracked.unreviewedRanges?.spans ?? [];
        foundSessionId = sessionId;
        foundIdentityKey = syncedTracked.identityKey;
        foundVersion = syncedTracked.version;
        foundDiffBase = syncedTracked.diffBase;
        foundReviewState = syncedTracked.reviewState ?? "finalized";
        break;
    }

    if (foundEdits.length === 0) {
        const shouldRetainPendingState =
            !foundFile &&
            currentDiffState.edits.length > 0 &&
            currentDiffState.reviewState === "pending";

        if (currentDiffState.edits.length > 0 && !shouldRetainPendingState) {
            dispatchInlineDiffEffect(view, clearInlineDiff.of(null));
        }
        return;
    }

    const baseLines = foundDiffBase ? foundDiffBase.split("\n") : [];
    const deletedTexts = foundEdits.map((edit) =>
        edit.newStart === edit.newEnd && baseLines.length > 0
            ? baseLines.slice(edit.oldStart, edit.oldEnd)
            : [],
    );

    const nextState: InlineDiffState = {
        edits: foundEdits,
        spans: foundSpans,
        deletedTexts,
        sessionId: foundSessionId,
        identityKey: foundIdentityKey,
        diffBase: foundDiffBase,
        reviewState: foundReviewState,
        version: foundVersion,
    };

    if (inlineDiffStatesEqual(currentDiffState, nextState)) {
        return;
    }

    dispatchInlineDiffEffect(view, setInlineDiff.of(nextState));
}
