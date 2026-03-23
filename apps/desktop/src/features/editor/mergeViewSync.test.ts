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
    overrides: Partial<TrackedFile> = {},
): TrackedFile {
    return {
        identityKey: overrides.identityKey ?? path,
        originPath: overrides.originPath ?? path,
        path: overrides.path ?? path,
        previousPath: overrides.previousPath ?? null,
        status: overrides.status ?? { kind: "modified" },
        diffBase,
        currentText,
        unreviewedRanges:
            overrides.unreviewedRanges ??
            buildTextRangePatchFromTexts(diffBase, currentText),
        unreviewedEdits:
            overrides.unreviewedEdits ??
            buildPatchFromTexts(diffBase, currentText),
        version: overrides.version ?? 1,
        isText: overrides.isText ?? true,
        updatedAt: overrides.updatedAt ?? 1,
        reviewState: overrides.reviewState,
        conflictHash: overrides.conflictHash ?? null,
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

    it("routes Accept and Reject through resolveReviewHunks with ReviewHunk ids", () => {
        const originalState = useChatStore.getState();
        const resolveReviewHunks = vi.fn();
        useChatStore.setState({
            ...originalState,
            resolveReviewHunks,
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
                '[data-review-decision="accept"]',
            ) as HTMLButtonElement | null;
            const rejectButton = view.dom.querySelector(
                '[data-review-decision="reject"]',
            ) as HTMLButtonElement | null;

            expect(acceptButton).not.toBeNull();
            expect(rejectButton).not.toBeNull();

            if (acceptButton) {
                fireEvent.mouseDown(acceptButton);
            }
            if (rejectButton) {
                fireEvent.mouseDown(rejectButton);
            }

            expect(resolveReviewHunks).toHaveBeenNthCalledWith(
                1,
                "session-1",
                path,
                "accepted",
                1,
                [{ trackedVersion: 1, key: "0:10:10:11:16" }],
            );
            expect(resolveReviewHunks).toHaveBeenNthCalledWith(
                2,
                "session-1",
                path,
                "rejected",
                1,
                [{ trackedVersion: 1, key: "0:10:10:11:16" }],
            );

            destroy();
        } finally {
            useChatStore.setState(originalState);
        }
    });

    it("routes inline deletion chunks through exact ReviewHunk ids", () => {
        const originalState = useChatStore.getState();
        const resolveReviewHunks = vi.fn();
        useChatStore.setState({
            ...originalState,
            resolveReviewHunks,
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
                '[data-review-decision="reject"]',
            ) as HTMLButtonElement | null;

            expect(rejectButton).not.toBeNull();

            if (rejectButton) {
                fireEvent.mouseDown(rejectButton);
            }

            expect(resolveReviewHunks).toHaveBeenCalledWith(
                "session-1",
                path,
                "rejected",
                1,
                [{ trackedVersion: 1, key: "0:6:11:6:6" }],
            );

            destroy();
        } finally {
            useChatStore.setState(originalState);
        }
    });

    it("refreshes inline controls when the tracked file changes without changing presentation flags", () => {
        const originalState = useChatStore.getState();
        const resolveReviewHunks = vi.fn();
        useChatStore.setState({
            ...originalState,
            resolveReviewHunks,
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
                '[data-review-decision="accept"]',
            ) as HTMLButtonElement | null;

            expect(acceptButton).not.toBeNull();

            if (acceptButton) {
                fireEvent.mouseDown(acceptButton);
            }

            expect(resolveReviewHunks).toHaveBeenCalledWith(
                "session-1",
                path,
                "accepted",
                2,
                [{ trackedVersion: 2, key: "0:0:5:0:5" }],
            );

            destroy();
        } finally {
            useChatStore.setState(originalState);
        }
    });

    it("reanchors inline controls when the projected chunks change without a structural signature change", () => {
        const path = "notes/current.md";
        const diffBase = "one\ntwo\nthree\nfour\nfive";
        const firstDoc = "one\ntwo\nthree\nfour\nFIVE";
        const secondDoc = "ONE\ntwo\nTHREE\nfour\nFIVE";

        const { view, destroy } = mountView(firstDoc);
        const firstFile = createTrackedFile(path, diffBase, firstDoc);
        const secondFile = createTrackedFile(path, diffBase, secondDoc);
        const firstSession = createSession("session-1", "wc-1", [firstFile]);
        const secondSession = createSession("session-1", "wc-1", [secondFile]);

        syncMergeViewForPaths(view, [path], {
            [firstSession.sessionId]: firstSession,
        });

        expect(
            view.dom.querySelectorAll('[data-review-decision="accept"]'),
        ).toHaveLength(1);

        view.dispatch({
            changes: {
                from: 0,
                to: view.state.doc.length,
                insert: secondDoc,
            },
        });

        syncMergeViewForPaths(view, [path], {
            [secondSession.sessionId]: secondSession,
        });

        expect(
            view.dom.querySelectorAll('[data-review-decision="accept"]'),
        ).toHaveLength(3);
        expect(
            view.dom.querySelector('[data-review-hunk-key="0:0:3:0:3"]'),
        ).not.toBeNull();
        expect(
            view.dom.querySelector('[data-review-hunk-key="1:8:13:8:13"]'),
        ).not.toBeNull();
        expect(
            view.dom.querySelector('[data-review-hunk-key="2:19:23:19:23"]'),
        ).not.toBeNull();

        destroy();
    });

    it("keeps local exact actions for separable multi-hunk chunks and precise neighbors", () => {
        const originalState = useChatStore.getState();
        const resolveReviewHunks = vi.fn();
        useChatStore.setState({
            ...originalState,
            resolveReviewHunks,
        });

        try {
            const { view, destroy } = mountView(
                "ONE\ntwo\nTHREE\nfour\nkeep\nkeep\nZOOM",
            );
            const path = "notes/current.md";
            const session = createSession("session-1", "wc-1", [
                createTrackedFile(
                    path,
                    "one\ntwo\nthree\nfour\nkeep\nkeep\nzoom",
                    "ONE\ntwo\nTHREE\nfour\nkeep\nkeep\nZOOM",
                ),
            ]);

            syncMergeViewForPaths(view, [path], {
                [session.sessionId]: session,
            });

            expect(
                view.dom.querySelectorAll('[data-review-decision="accept"]'),
            ).toHaveLength(3);
            expect(
                view.dom.querySelectorAll('[data-review-decision="reject"]'),
            ).toHaveLength(3);
            expect(view.dom.textContent).not.toContain("Review in Changes");

            const memberAcceptButton = view.dom.querySelector(
                '[data-review-decision="accept"][data-review-hunk-key="0:0:3:0:3"]',
            ) as HTMLButtonElement | null;

            expect(memberAcceptButton).not.toBeNull();
            if (memberAcceptButton) {
                fireEvent.mouseDown(memberAcceptButton);
            }

            expect(resolveReviewHunks).toHaveBeenCalledWith(
                "session-1",
                path,
                "accepted",
                1,
                [{ trackedVersion: 1, key: "0:0:3:0:3" }],
            );

            destroy();
        } finally {
            useChatStore.setState(originalState);
        }
    });

    it("degrades only the ambiguous chunk while keeping precise chunk actions", () => {
        const originalState = useChatStore.getState();
        const resolveReviewHunks = vi.fn();
        useChatStore.setState({
            ...originalState,
            resolveReviewHunks,
        });

        const { view, destroy } = mountView("FOO bar BAZ\nkeep\nkeep\nZOOM");
        const path = "notes/current.md";
        const session = createSession("session-1", "wc-1", [
            createTrackedFile(
                path,
                "foo bar baz\nkeep\nkeep\nzoom",
                "FOO bar BAZ\nkeep\nkeep\nZOOM",
                {
                    unreviewedRanges: {
                        spans: [
                            {
                                baseFrom: 0,
                                baseTo: 3,
                                currentFrom: 0,
                                currentTo: 3,
                            },
                            {
                                baseFrom: 8,
                                baseTo: 11,
                                currentFrom: 8,
                                currentTo: 11,
                            },
                            {
                                baseFrom: 22,
                                baseTo: 26,
                                currentFrom: 22,
                                currentTo: 26,
                            },
                        ],
                    },
                    unreviewedEdits: buildPatchFromTexts(
                        "foo bar baz\nkeep\nkeep\nzoom",
                        "FOO bar BAZ\nkeep\nkeep\nZOOM",
                    ),
                },
            ),
        ]);

        try {
            syncMergeViewForPaths(view, [path], {
                [session.sessionId]: session,
            });

            expect(view.dom.textContent).toContain("Review in Changes");
            expect(
                view.dom.querySelectorAll('[data-review-decision="accept"]'),
            ).toHaveLength(1);
            expect(
                view.dom.querySelectorAll('[data-review-decision="reject"]'),
            ).toHaveLength(1);

            const acceptButton = view.dom.querySelector(
                '[data-review-decision="accept"][data-review-decision-scope="chunk"]',
            ) as HTMLButtonElement | null;

            expect(acceptButton).not.toBeNull();
            if (acceptButton) {
                fireEvent.mouseDown(acceptButton);
            }

            expect(resolveReviewHunks).toHaveBeenCalledWith(
                "session-1",
                path,
                "accepted",
                1,
                [{ trackedVersion: 1, key: "2:22:26:22:26" }],
            );

            destroy();
        } finally {
            useChatStore.setState(originalState);
        }
    });

    it("degrades conflicting chunks to the review panel instead of showing inline actions", () => {
        const { view, destroy } = mountView("alpha\nbeta\ngamma");
        const path = "notes/current.md";
        const session = createSession("session-1", "wc-1", [
            createTrackedFile(path, "alpha\nbeta", "alpha\nbeta\ngamma", {
                conflictHash: "conflict-1",
            }),
        ]);

        syncMergeViewForPaths(view, [path], {
            [session.sessionId]: session,
        });

        expect(
            view.dom.querySelector('[data-review-decision="accept"]'),
        ).toBeNull();
        expect(
            view.dom.querySelector('[data-review-decision="reject"]'),
        ).toBeNull();
        expect(view.dom.textContent).toContain("Review in Changes");

        destroy();
    });
});
