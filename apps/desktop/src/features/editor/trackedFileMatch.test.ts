import { describe, expect, it } from "vitest";
import type { TrackedFile } from "../ai/diff/actionLogTypes";
import type { AIChatSession } from "../ai/types";
import {
    buildPatchFromTexts,
    buildTextRangePatchFromTexts,
    emptyActionLogState,
    setTrackedFilesForWorkCycle,
} from "../ai/store/actionLogModel";
import { resolveTrackedFileMatchForPaths } from "./trackedFileMatch";

function createTrackedFile(
    path: string,
    diffBase: string,
    currentText: string,
): TrackedFile {
    return {
        identityKey: path,
        originPath: path,
        path,
        previousPath: null,
        status: { kind: "modified" },
        reviewState: "finalized",
        diffBase,
        currentText,
        unreviewedRanges: buildTextRangePatchFromTexts(diffBase, currentText),
        unreviewedEdits: buildPatchFromTexts(diffBase, currentText),
        version: 1,
        isText: true,
        updatedAt: 1,
        conflictHash: null,
    };
}

function createSession(
    sessionId: string,
    vaultPath: string,
    files: TrackedFile[],
): AIChatSession {
    let actionLog = emptyActionLogState();
    if (files.length > 0) {
        actionLog = setTrackedFilesForWorkCycle(
            actionLog,
            "wc-test",
            Object.fromEntries(files.map((file) => [file.identityKey, file])),
        );
    }

    return {
        sessionId,
        historySessionId: sessionId,
        vaultPath,
        status: "idle",
        activeWorkCycleId: "wc-test",
        visibleWorkCycleId: "wc-test",
        actionLog,
        runtimeId: "test-runtime",
        modelId: "test-model",
        modeId: "default",
        models: [],
        modes: [],
        configOptions: [],
        messages: [],
        attachments: [],
        isPersistedSession: false,
        resumeContextPending: false,
    };
}

describe("trackedFileMatch", () => {
    it("filters tracked file matches by vaultPath before comparing paths", () => {
        const candidatePath = "notes/current.md";
        const foreignSession = createSession("session-b", "/vault-b", [
            createTrackedFile(candidatePath, "wrong", "CURRENT"),
        ]);
        const localSession = createSession("session-a", "/vault-a", [
            createTrackedFile(candidatePath, "alpha", "CURRENT"),
        ]);

        const result = resolveTrackedFileMatchForPaths(
            [candidatePath],
            {
                [foreignSession.sessionId]: foreignSession,
                [localSession.sessionId]: localSession,
            },
            {
                vaultPath: "/vault-a",
            },
        );

        expect(result.match?.sessionId).toBe("session-a");
        expect(result.match?.trackedFile.diffBase).toBe("alpha");
    });

    it("does not report tracked files from a different vault as present", () => {
        const candidatePath = "notes/current.md";
        const foreignSession = createSession("session-b", "/vault-b", [
            createTrackedFile(candidatePath, "wrong", "CURRENT"),
        ]);

        const result = resolveTrackedFileMatchForPaths(
            [candidatePath],
            {
                [foreignSession.sessionId]: foreignSession,
            },
            {
                vaultPath: "/vault-a",
            },
        );

        expect(result.foundTrackedFile).toBe(false);
        expect(result.match).toBeNull();
    });
});
