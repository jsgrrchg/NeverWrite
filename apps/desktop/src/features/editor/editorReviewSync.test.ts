import { afterEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../app/store/editorStore";
import { useSettingsStore } from "../../app/store/settingsStore";
import { useVaultStore } from "../../app/store/vaultStore";
import {
    buildPatchFromTexts,
    buildTextRangePatchFromTexts,
    emptyActionLogState,
    setTrackedFilesForWorkCycle,
} from "../ai/store/actionLogModel";
import type { TrackedFile } from "../ai/diff/actionLogTypes";
import type { AIChatSession } from "../ai/types";
import type { EditorTarget } from "./editorTargetResolver";
import { syncTrackedEditorReviewTarget } from "./editorReviewSync";

function buildTrackedSessions(
    targetPath: string,
    diffBase: string,
    currentText: string,
): Record<string, AIChatSession> {
    const workCycleId = "wc-editor-review-sync";
    const trackedFile: TrackedFile = {
        identityKey: targetPath,
        originPath: targetPath,
        path: targetPath,
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

    return {
        "session-editor-review-sync": {
            sessionId: "session-editor-review-sync",
            historySessionId: "session-editor-review-sync",
            vaultPath: "/vault",
            status: "idle",
            activeWorkCycleId: workCycleId,
            visibleWorkCycleId: workCycleId,
            actionLog: setTrackedFilesForWorkCycle(
                emptyActionLogState(),
                workCycleId,
                {
                    [trackedFile.identityKey]: trackedFile,
                },
            ),
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
        },
    };
}

describe("editorReviewSync", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        useSettingsStore.getState().setSetting("inlineReviewEnabled", true);
    });

    it("does not force reload when inline review is disabled", () => {
        useVaultStore.setState({ vaultPath: "/vault" });
        useSettingsStore.getState().setSetting("inlineReviewEnabled", false);

        const target: EditorTarget = {
            kind: "note",
            absolutePath: "/vault/notes/current.md",
            noteId: "notes/current",
            openTab: {
                id: "tab-1",
                noteId: "notes/current",
                title: "Current",
                content: "old body",
                history: [],
                historyIndex: 0,
            },
        };
        const sessionsById = buildTrackedSessions(
            "/vault/notes/current.md",
            "old body",
            "new body",
        );

        const reloadSpy = vi
            .spyOn(useEditorStore.getState(), "forceReloadEditorTarget")
            .mockImplementation(() => undefined);

        const didSync = syncTrackedEditorReviewTarget(target, sessionsById);

        expect(didSync).toBe(false);
        expect(reloadSpy).not.toHaveBeenCalled();
    });

    it("forces reload when inline review is enabled and tracked content differs", () => {
        useVaultStore.setState({ vaultPath: "/vault" });
        useSettingsStore.getState().setSetting("inlineReviewEnabled", true);

        const target: EditorTarget = {
            kind: "note",
            absolutePath: "/vault/notes/current.md",
            noteId: "notes/current",
            openTab: {
                id: "tab-1",
                noteId: "notes/current",
                title: "Current",
                content: "old body",
                history: [],
                historyIndex: 0,
            },
        };
        const sessionsById = buildTrackedSessions(
            "/vault/notes/current.md",
            "old body",
            "new body",
        );

        const reloadSpy = vi
            .spyOn(useEditorStore.getState(), "forceReloadEditorTarget")
            .mockImplementation(() => undefined);

        const didSync = syncTrackedEditorReviewTarget(target, sessionsById);

        expect(didSync).toBe(true);
        expect(reloadSpy).toHaveBeenCalledWith(target, {
            content: "new body",
            title: "Current",
            origin: "agent",
        });
    });
});
