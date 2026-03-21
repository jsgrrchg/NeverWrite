/**
 * @vitest-environment jsdom
 */
import { EditorState } from "@codemirror/state";
import { getChunks, getOriginalDoc } from "@codemirror/merge";
import { EditorView } from "@codemirror/view";
import { fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TrackedFile } from "../ai/diff/actionLogTypes";
import type { AIChatSession } from "../ai/types";
import {
    buildPatchFromTexts,
    buildTextRangePatchFromTexts,
    emptyActionLogState,
    setTrackedFilesForWorkCycle,
} from "../ai/store/actionLogModel";
import { useChatStore } from "../ai/store/chatStore";
import {
    mergeViewCompartment,
    readMergeViewRuntimeState,
} from "./extensions/mergeViewDiff";
import { syncMergeViewForPaths } from "./mergeViewSync";

function mountView(doc: string) {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const state = EditorState.create({
        doc,
        extensions: [mergeViewCompartment.of([])],
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
): TrackedFile {
    return {
        identityKey: path,
        originPath: path,
        path,
        previousPath: null,
        status: { kind: "modified" },
        diffBase,
        currentText,
        unreviewedRanges: buildTextRangePatchFromTexts(diffBase, currentText),
        unreviewedEdits: buildPatchFromTexts(diffBase, currentText),
        version: 1,
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

describe("mergeViewSync", () => {
    it("activates merge with a tracked file", () => {
        const { view, destroy } = mountView("alpHa");
        const path = "notes/current.md";
        const session = createSession("session-1", "wc-1", [
            createTrackedFile(path, "alpha", "alpHa"),
        ]);

        syncMergeViewForPaths(view, [path], {
            [session.sessionId]: session,
        });

        expect(getChunks(view.state)?.chunks.length).toBe(1);
        expect(readMergeViewRuntimeState(view.state)?.sessionId).toBe(
            "session-1",
        );
        destroy();
    });

    it("deactivates merge in preview mode", () => {
        const { view, destroy } = mountView("alpHa");
        const path = "notes/current.md";
        const session = createSession("session-1", "wc-1", [
            createTrackedFile(path, "alpha", "alpHa"),
        ]);

        syncMergeViewForPaths(view, [path], {
            [session.sessionId]: session,
        });
        syncMergeViewForPaths(
            view,
            [path],
            {
                [session.sessionId]: session,
            },
            { mode: "preview" },
        );

        expect(getChunks(view.state)).toBeNull();
        expect(readMergeViewRuntimeState(view.state)?.enabled).toBe(false);
        destroy();
    });

    it("reconfigures metadata when the review state changes", () => {
        const { view, destroy } = mountView("alpHa");
        const path = "notes/current.md";
        const session = createSession("session-1", "wc-1", [
            createTrackedFile(path, "alpha", "alpHa"),
        ]);
        const pendingFile = createTrackedFile(path, "alpha", "alpHa");
        pendingFile.reviewState = "pending";
        const pendingSession = createSession("session-1", "wc-1", [
            pendingFile,
        ]);

        syncMergeViewForPaths(view, [path], {
            [session.sessionId]: session,
        });
        syncMergeViewForPaths(view, [path], {
            [pendingSession.sessionId]: pendingSession,
        });

        expect(readMergeViewRuntimeState(view.state)?.reviewState).toBe(
            "pending",
        );
        destroy();
    });

    it("updates the original document without dropping the merge extension", () => {
        const { view, destroy } = mountView("alpHa");
        const path = "notes/current.md";
        const firstSession = createSession("session-1", "wc-1", [
            createTrackedFile(path, "alpha", "alpHa"),
        ]);
        const secondSession = createSession("session-1", "wc-1", [
            createTrackedFile(path, "alpaa", "alpHa"),
        ]);

        syncMergeViewForPaths(view, [path], {
            [firstSession.sessionId]: firstSession,
        });
        syncMergeViewForPaths(view, [path], {
            [secondSession.sessionId]: secondSession,
        });

        expect(getOriginalDoc(view.state).toString()).toBe("alpaa");
        expect(getChunks(view.state)?.chunks.length).toBe(1);
        destroy();
    });

    it("routes Accept and Reject through resolveHunkEdits with ActionLog line ranges", () => {
        const originalState = useChatStore.getState();
        const resolveHunkEdits = vi.fn();
        useChatStore.setState({
            ...originalState,
            resolveHunkEdits,
        });

        try {
            const { view, destroy } = mountView("alpha\nbeta\ngamma");
            const path = "notes/current.md";
            const session = createSession("session-1", "wc-1", [
                createTrackedFile(path, "alpha\nbeta", "alpha\nbeta\ngamma"),
            ]);

            syncMergeViewForPaths(view, [path], {
                [session.sessionId]: session,
            });

            const acceptButton = view.dom.querySelector(
                '[data-merge-decision="accept"]',
            ) as HTMLButtonElement | null;
            const rejectButton = view.dom.querySelector(
                '[data-merge-decision="reject"]',
            ) as HTMLButtonElement | null;

            expect(acceptButton).not.toBeNull();
            expect(rejectButton).not.toBeNull();

            if (acceptButton) {
                fireEvent.mouseDown(acceptButton);
            }
            if (rejectButton) {
                fireEvent.mouseDown(rejectButton);
            }

            expect(resolveHunkEdits).toHaveBeenNthCalledWith(
                1,
                "session-1",
                path,
                "accepted",
                2,
                3,
            );
            expect(resolveHunkEdits).toHaveBeenNthCalledWith(
                2,
                "session-1",
                path,
                "rejected",
                2,
                3,
            );

            destroy();
        } finally {
            useChatStore.setState(originalState);
        }
    });

    it("maps inline deletion chunks to the tracked file line edit range", () => {
        const originalState = useChatStore.getState();
        const resolveHunkEdits = vi.fn();
        useChatStore.setState({
            ...originalState,
            resolveHunkEdits,
        });

        try {
            const { view, destroy } = mountView("alpha gamma\nomega");
            const path = "notes/current.md";
            const session = createSession("session-1", "wc-1", [
                createTrackedFile(
                    path,
                    "alpha beta gamma\nomega",
                    "alpha gamma\nomega",
                ),
            ]);

            syncMergeViewForPaths(view, [path], {
                [session.sessionId]: session,
            });

            const rejectButton = view.dom.querySelector(
                '[data-merge-decision="reject"]',
            ) as HTMLButtonElement | null;

            expect(rejectButton).not.toBeNull();

            if (rejectButton) {
                fireEvent.mouseDown(rejectButton);
            }

            expect(resolveHunkEdits).toHaveBeenCalledWith(
                "session-1",
                path,
                "rejected",
                0,
                1,
            );

            destroy();
        } finally {
            useChatStore.setState(originalState);
        }
    });

    it("refreshes merge decisions when the tracked file changes without changing presentation flags", () => {
        const originalState = useChatStore.getState();
        const resolveHunkEdits = vi.fn();
        useChatStore.setState({
            ...originalState,
            resolveHunkEdits,
        });

        try {
            const doc = "alpha\nbeta\ngamma";
            const { view, destroy } = mountView(doc);
            const path = "notes/current.md";
            const firstFile = createTrackedFile(path, "alpha\nbeta", doc);
            const secondFile = createTrackedFile(
                path,
                "ALPHA\nbeta\ngamma",
                doc,
            );
            secondFile.version = 2;
            const firstSession = createSession("session-1", "wc-1", [
                firstFile,
            ]);
            const secondSession = createSession("session-1", "wc-1", [
                secondFile,
            ]);

            syncMergeViewForPaths(view, [path], {
                [firstSession.sessionId]: firstSession,
            });
            syncMergeViewForPaths(view, [path], {
                [secondSession.sessionId]: secondSession,
            });

            const acceptButton = view.dom.querySelector(
                '[data-merge-decision="accept"]',
            ) as HTMLButtonElement | null;

            expect(acceptButton).not.toBeNull();

            if (acceptButton) {
                fireEvent.mouseDown(acceptButton);
            }

            expect(resolveHunkEdits).toHaveBeenCalledWith(
                "session-1",
                path,
                "accepted",
                0,
                1,
            );

            destroy();
        } finally {
            useChatStore.setState(originalState);
        }
    });
});
