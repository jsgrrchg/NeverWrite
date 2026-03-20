import { describe, expect, it } from "vitest";
import type { AIChatSession } from "../types";
import type { TrackedFile } from "../diff/actionLogTypes";
import {
    buildPatchFromTexts,
    buildTextRangePatchFromTexts,
    emptyActionLogState,
    getTrackedFilesForWorkCycle,
    setTrackedFilesForWorkCycle,
} from "./actionLogModel";
import { startNewWorkCycle } from "./editedFilesBufferModel";

function createTrackedFile(path: string): TrackedFile {
    return {
        identityKey: path,
        originPath: path,
        path,
        previousPath: null,
        status: { kind: "modified" },
        reviewState: "finalized",
        diffBase: "old line",
        currentText: "new line",
        unreviewedRanges: buildTextRangePatchFromTexts("old line", "new line"),
        unreviewedEdits: buildPatchFromTexts("old line", "new line"),
        version: 1,
        isText: true,
        updatedAt: 1,
    };
}

describe("startNewWorkCycle", () => {
    it("carries tracked files forward from the active work cycle when no visible cycle is set", () => {
        const trackedFile = createTrackedFile("/vault/src/current.ts");
        const activeWorkCycleId = "wc-active";
        const actionLog = setTrackedFilesForWorkCycle(
            emptyActionLogState(),
            activeWorkCycleId,
            { [trackedFile.identityKey]: trackedFile },
        );
        const session: AIChatSession = {
            sessionId: "session-1",
            historySessionId: "session-1",
            status: "idle",
            activeWorkCycleId,
            visibleWorkCycleId: null,
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

        const nextSession = startNewWorkCycle(session);

        expect(nextSession.activeWorkCycleId).toBeTruthy();
        expect(nextSession.activeWorkCycleId).not.toBe(activeWorkCycleId);
        expect(nextSession.visibleWorkCycleId).toBe(nextSession.activeWorkCycleId);
        expect(
            getTrackedFilesForWorkCycle(
                nextSession.actionLog!,
                nextSession.activeWorkCycleId,
            ),
        ).toMatchObject({
            [trackedFile.identityKey]: trackedFile,
        });
        expect(
            getTrackedFilesForWorkCycle(nextSession.actionLog!, activeWorkCycleId),
        ).toEqual({});
    });
});
