import type { ReviewState } from "../ai/diff/actionLogTypes";
import type {
    ChangePresentationLevel,
    FileChangePresentation,
} from "./changePresentationModel";

export interface MergePresentationFlags {
    highlightChanges: boolean;
    allowInlineDiffs: boolean;
    enableControls: boolean;
    syntaxHighlightDeletions: boolean;
    syntaxHighlightDeletionsMaxLength: number;
}

export interface MergeStructuralConfig {
    shouldShowMerge: boolean;
    sessionId: string | null;
    identityKey: string | null;
    reviewState: ReviewState;
    level: ChangePresentationLevel;
    statusKind: string | null;
    mode: "source" | "preview";
}

export function getMergePresentationFlags(
    presentation: FileChangePresentation,
): MergePresentationFlags {
    return {
        highlightChanges: presentation.level !== "very-large",
        allowInlineDiffs:
            presentation.level === "small" || presentation.level === "medium",
        enableControls:
            presentation.reviewState === "finalized" &&
            presentation.level !== "very-large",
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
        config.reviewState,
        config.level,
        config.statusKind,
        config.mode,
    ]);
}
