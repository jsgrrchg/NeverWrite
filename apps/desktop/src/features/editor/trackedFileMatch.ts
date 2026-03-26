import type { TrackedFile } from "../ai/diff/actionLogTypes";
import {
    getTrackedFilesForSession,
    shouldShowInlineDiff,
    syncDerivedLinePatch,
} from "../ai/store/actionLogModel";
import type { AIChatSession } from "../ai/types";

export interface TrackedFileMatch {
    trackedFile: TrackedFile;
    sessionId: string;
}

export interface TrackedFileMatchResult {
    match: TrackedFileMatch | null;
    foundTrackedFile: boolean;
}

export function resolveTrackedFileMatchForPaths(
    candidatePaths: string[],
    sessionsById: Record<string, AIChatSession>,
    options: {
        vaultPath: string | null;
    },
): TrackedFileMatchResult {
    const normalizedCandidates = candidatePaths
        .map((path) => normalizePath(path))
        .filter((path) => path.length > 0);

    if (normalizedCandidates.length === 0) {
        return { match: null, foundTrackedFile: false };
    }

    let foundTrackedFile = false;

    for (const [sessionId, session] of Object.entries(sessionsById)) {
        if ((session.vaultPath ?? null) !== options.vaultPath) {
            continue;
        }
        if (!session.actionLog) continue;

        const files = getTrackedFilesForSession(session.actionLog);

        for (const file of Object.values(files)) {
            const pathsToCheck = [file.path, file.identityKey];
            const matchesCandidate = normalizedCandidates.some((candidate) =>
                pathsToCheck.some((path) =>
                    matchesTrackedFilePath(path, candidate),
                ),
            );

            if (!matchesCandidate) {
                continue;
            }

            foundTrackedFile = true;

            const syncedTrackedFile = syncDerivedLinePatch(file);
            if (!shouldShowInlineDiff(syncedTrackedFile)) {
                continue;
            }

            return {
                match: {
                    trackedFile: syncedTrackedFile,
                    sessionId,
                },
                foundTrackedFile,
            };
        }
    }

    return {
        match: null,
        foundTrackedFile,
    };
}

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
