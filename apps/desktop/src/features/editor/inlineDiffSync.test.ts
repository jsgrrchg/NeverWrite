/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { TrackedFile } from "../ai/diff/actionLogTypes";
import type { AIChatSession } from "../ai/types";
import {
    buildPatchFromTexts,
    buildTextRangePatchFromTexts,
    emptyActionLogState,
    setTrackedFilesForWorkCycle,
} from "../ai/store/actionLogModel";
import {
    getInlineDiffExtension,
    inlineDiffField,
} from "./extensions/inlineDiff";
import { syncInlineDiffForPaths } from "./inlineDiffSync";

function mountView(doc: string) {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const state = EditorState.create({
        doc,
        extensions: [getInlineDiffExtension()],
    });
    const view = new EditorView({ state, parent });

    return {
        view,
        destroy() {
            view.destroy();
            parent.remove();
        },
    };
}

function createTrackedFile(
    path: string,
    diffBase: string,
    currentText: string,
    sessionVersion = 1,
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
        version: sessionVersion,
        isText: true,
        updatedAt: 1,
    };
}

function createSession(
    sessionId: string,
    workCycleId: string,
    files: TrackedFile[],
): AIChatSession {
    let actionLog = emptyActionLogState();
    if (files.length > 0) {
        actionLog = setTrackedFilesForWorkCycle(
            actionLog,
            workCycleId,
            Object.fromEntries(files.map((file) => [file.identityKey, file])),
        );
    }

    return {
        sessionId,
        historySessionId: sessionId,
        status: "idle",
        activeWorkCycleId: workCycleId,
        visibleWorkCycleId: workCycleId,
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

describe("inlineDiffSync", () => {
    it("clears inline decorations after the tracked file is removed", () => {
        const { view, destroy } = mountView("alpHa");
        const path = "notes/current.md";
        const session = createSession("session-1", "wc-1", [
            createTrackedFile(path, "alpha", "alpHa"),
        ]);

        syncInlineDiffForPaths(view, [path], {
            [session.sessionId]: session,
        });
        expect(view.state.field(inlineDiffField).edits).toHaveLength(1);

        const removedSession = createSession("session-1", "wc-1", []);
        syncInlineDiffForPaths(view, [path], {
            [removedSession.sessionId]: removedSession,
        });

        expect(view.state.field(inlineDiffField).edits).toHaveLength(0);
        expect(
            view.dom.querySelector(
                ".cm-diff-inline-modified, .cm-diff-word-changed",
            ),
        ).toBeNull();

        destroy();
    });

    it("refreshes the inline state when the tracked file changes without a version bump", () => {
        const { view, destroy } = mountView("alpHa");
        const path = "notes/current.md";
        const firstSession = createSession("session-1", "wc-1", [
            createTrackedFile(path, "alpha", "alpHa", 1),
        ]);
        const secondSession = createSession("session-2", "wc-2", [
            createTrackedFile(path, "alpaa", "alpHa", 1),
        ]);

        syncInlineDiffForPaths(view, [path], {
            [firstSession.sessionId]: firstSession,
        });
        expect(view.state.field(inlineDiffField).sessionId).toBe("session-1");
        expect(view.state.field(inlineDiffField).diffBase).toBe("alpha");

        syncInlineDiffForPaths(view, [path], {
            [secondSession.sessionId]: secondSession,
        });

        expect(view.state.field(inlineDiffField).sessionId).toBe("session-2");
        expect(view.state.field(inlineDiffField).diffBase).toBe("alpaa");

        destroy();
    });

    it("derives presentation flags from the matched tracked file", () => {
        const { view, destroy } = mountView("alpha\nbeta\ngamma");
        const path = "notes/current.md";
        const session = createSession("session-1", "wc-1", [
            createTrackedFile(
                path,
                Array.from({ length: 12 }, (_, index) => `old-${index}`).join(
                    "\n",
                ),
                "old-0\nold-10\nold-11",
            ),
        ]);

        syncInlineDiffForPaths(view, [path], {
            [session.sessionId]: session,
        });

        const state = view.state.field(inlineDiffField);
        expect(state.presentation.level).toBe("large");
        expect(state.presentation.showInlineActions).toBe(false);
        expect(state.presentation.collapseLargeDeletes).toBe(true);
        expect(state.presentation.collapsedDeleteBlockIndexes).toEqual([0]);

        destroy();
    });

    it("does not throw when syncing after the document shrinks", () => {
        const path = "notes/current.md";
        const diffBase = Array.from({ length: 12 }, (_, index) => `old-${index}`).join(
            "\n",
        );
        const currentText = "old-0\nold-10\nold-11";
        const { view, destroy } = mountView(diffBase);
        const session = createSession("session-1", "wc-1", [
            createTrackedFile(path, diffBase, currentText),
        ]);

        view.dispatch({
            changes: {
                from: 0,
                to: view.state.doc.length,
                insert: currentText,
            },
        });

        expect(() => {
            syncInlineDiffForPaths(view, [path], {
                [session.sessionId]: session,
            });
        }).not.toThrow();

        destroy();
    });
});
