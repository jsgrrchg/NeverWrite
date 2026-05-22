import { pathsMatchVaultScoped } from "../../../app/utils/vaultPaths";
import type { TrackedFile } from "./actionLogTypes";
import { createDiffFromTrackedFile } from "./reviewDiff";
import type { AIFileDiff } from "../types";

export function deriveChatChangeReviewDiffs(
    diffs: readonly AIFileDiff[],
    trackedFiles: readonly TrackedFile[],
    vaultPath: string | null,
): AIFileDiff[] {
    const unmatchedTrackedFiles = new Map(
        trackedFiles.map((file) => [file.identityKey, file]),
    );

    return diffs.map((diff) => {
        const file = matchTrackedFileToDiff(
            diff,
            [...unmatchedTrackedFiles.values()],
            vaultPath,
        );
        if (!file) {
            return diff;
        }

        unmatchedTrackedFiles.delete(file.identityKey);
        return createDiffFromTrackedFile(file);
    });
}

function matchTrackedFileToDiff(
    diff: AIFileDiff,
    trackedFiles: readonly TrackedFile[],
    vaultPath: string | null,
): TrackedFile | null {
    let bestCandidate: TrackedFile | null = null;
    let bestScore = -1;
    let hasTie = false;

    for (const trackedFile of trackedFiles) {
        const score = scoreTrackedFileMatch(diff, trackedFile, vaultPath);
        if (score < 0) {
            continue;
        }

        if (score > bestScore) {
            bestCandidate = trackedFile;
            bestScore = score;
            hasTie = false;
            continue;
        }

        if (score === bestScore) {
            hasTie = true;
        }
    }

    return hasTie ? null : bestCandidate;
}

function scoreTrackedFileMatch(
    diff: AIFileDiff,
    trackedFile: TrackedFile,
    vaultPath: string | null,
) {
    const previousPath = diff.previous_path ?? null;
    if (
        pathsMatch(trackedFile.path, diff.path, vaultPath) &&
        ((trackedFile.previousPath ?? null) === previousPath ||
            (trackedFile.previousPath != null &&
                previousPath != null &&
                pathsMatch(trackedFile.previousPath, previousPath, vaultPath)))
    ) {
        return 4;
    }

    if (pathsMatch(trackedFile.path, diff.path, vaultPath)) {
        return 3;
    }

    if (
        previousPath != null &&
        trackedFile.previousPath != null &&
        pathsMatch(trackedFile.previousPath, previousPath, vaultPath)
    ) {
        return 2;
    }

    if (
        previousPath != null &&
        pathsMatch(trackedFile.path, previousPath, vaultPath)
    ) {
        return 1;
    }

    return -1;
}

function pathsMatch(
    left: string,
    right: string,
    vaultPath: string | null,
) {
    return pathsMatchVaultScoped(left, right, vaultPath, {
        includeLegacyLeadingSlashRelative: true,
    });
}
