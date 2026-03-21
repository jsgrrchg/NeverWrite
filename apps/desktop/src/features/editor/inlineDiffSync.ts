import type { EditorView } from "@codemirror/view";
import type { AgentTextSpan, LineEdit } from "../ai/diff/actionLogTypes";
import type { InlineDiffState } from "./extensions/inlineDiff";
import type { AIChatSession } from "../ai/types";
import { deriveFileChangePresentation } from "./changePresentationModel";
import {
    clearInlineDiff,
    inlineDiffField,
    setInlineDiff,
} from "./extensions/inlineDiff";
import { resolveTrackedFileMatchForPaths } from "./trackedFileMatch";

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
        current.presentation.level === next.presentation.level &&
        current.presentation.showInlineActions ===
            next.presentation.showInlineActions &&
        current.presentation.showWordDiff ===
            next.presentation.showWordDiff &&
        current.presentation.collapseLargeDeletes ===
            next.presentation.collapseLargeDeletes &&
        current.presentation.reducedInlineMode ===
            next.presentation.reducedInlineMode &&
        deletedBlockIndexesEqual(
            current.presentation.collapsedDeleteBlockIndexes,
            next.presentation.collapsedDeleteBlockIndexes,
        ) &&
        editsEqual(current.edits, next.edits) &&
        spansEqual(current.spans, next.spans) &&
        deletedTextsEqual(current.deletedTexts, next.deletedTexts)
    );
}

function deletedBlockIndexesEqual(a: number[], b: number[]) {
    if (a.length !== b.length) return false;
    return a.every((value, index) => value === b[index]);
}

function dispatchInlineDiffEffect(
    view: EditorView,
    effect:
        | ReturnType<typeof setInlineDiff.of>
        | ReturnType<typeof clearInlineDiff.of>,
) {
    view.dispatch({
        effects: [effect],
    });
}

export function syncInlineDiffForPaths(
    view: EditorView | null,
    candidatePaths: string[],
    sessionsById: Record<string, AIChatSession>,
) {
    if (!view) return;
    const currentDiffState = view.state.field(inlineDiffField);

    if (candidatePaths.length === 0) {
        if (currentDiffState.edits.length > 0) {
            dispatchInlineDiffEffect(view, clearInlineDiff.of(null));
        }
        return;
    }

    const { match, foundTrackedFile } = resolveTrackedFileMatchForPaths(
        candidatePaths,
        sessionsById,
    );

    if (!match) {
        const shouldRetainPendingState =
            !foundTrackedFile &&
            currentDiffState.edits.length > 0 &&
            currentDiffState.reviewState === "pending";

        if (currentDiffState.edits.length > 0 && !shouldRetainPendingState) {
            dispatchInlineDiffEffect(view, clearInlineDiff.of(null));
        }
        return;
    }

    const { trackedFile, sessionId } = match;
    const baseLines = trackedFile.diffBase ? trackedFile.diffBase.split("\n") : [];
    const deletedTexts = trackedFile.unreviewedEdits.edits.map((edit) =>
        edit.newStart === edit.newEnd && baseLines.length > 0
            ? baseLines.slice(edit.oldStart, edit.oldEnd)
            : [],
    );
    const presentation = deriveFileChangePresentation(trackedFile);

    const nextState: InlineDiffState = {
        edits: trackedFile.unreviewedEdits.edits,
        spans: trackedFile.unreviewedRanges?.spans ?? [],
        deletedTexts,
        sessionId,
        identityKey: trackedFile.identityKey,
        diffBase: trackedFile.diffBase,
        reviewState: presentation.reviewState,
        version: trackedFile.version,
        presentation: {
            level: presentation.level,
            showInlineActions: presentation.showInlineActions,
            showWordDiff: presentation.showWordDiff,
            collapseLargeDeletes: presentation.collapseLargeDeletes,
            reducedInlineMode: presentation.reducedInlineMode,
            collapsedDeleteBlockIndexes:
                presentation.collapsedDeleteBlockIndexes,
        },
    };

    if (inlineDiffStatesEqual(currentDiffState, nextState)) {
        return;
    }

    dispatchInlineDiffEffect(view, setInlineDiff.of(nextState));
}
