import type { ReviewState } from "../ai/diff/actionLogTypes";
import type { ReviewProjectionInlineState } from "../ai/diff/reviewProjection";
import type {
    ChangePresentationLevel,
    FileChangePresentation,
} from "./changePresentationModel";

export interface MergePresentationFlags {
    highlightChanges: boolean;
    allowInlineDiffs: boolean;
    enableControls: boolean;
    showControlWidgets: boolean;
    syntaxHighlightDeletions: boolean;
    syntaxHighlightDeletionsMaxLength: number;
}

export interface MergeStructuralConfig {
    shouldShowMerge: boolean;
    sessionId: string | null;
    identityKey: string | null;
    trackedVersion: number | null;
    reviewState: ReviewState;
    level: ChangePresentationLevel;
    statusKind: string | null;
    mode: "source" | "preview";
}

export function getMergePresentationFlags(
    presentation: FileChangePresentation,
    projectionState: ReviewProjectionInlineState,
): MergePresentationFlags {
    const showControlWidgets = projectionState.reviewProjectionReady;
    const enableControls = showControlWidgets;

    return {
        highlightChanges: presentation.level !== "very-large",
        allowInlineDiffs:
            projectionState.reviewProjectionReady &&
            (presentation.level === "small" || presentation.level === "medium"),
        enableControls,
        showControlWidgets,
        syntaxHighlightDeletions: presentation.level !== "very-large",
        syntaxHighlightDeletionsMaxLength:
            presentation.level === "very-large" ? 1200 : 3000,
    };
}

export function buildMergeStructuralSignature(config: MergeStructuralConfig) {
    return JSON.stringify([
        config.shouldShowMerge,
        config.sessionId,
        config.identityKey,
        config.trackedVersion,
        config.reviewState,
        config.level,
        config.statusKind,
        config.mode,
    ]);
}
