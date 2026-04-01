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
import { useVaultStore } from "../../app/store/vaultStore";
import {
    buildPatchFromTexts,
    buildTextRangePatchFromTexts,
    emptyActionLogState,
    setTrackedFilesForWorkCycle,
} from "../ai/store/actionLogModel";
import { useChatStore } from "../ai/store/chatStore";
import { useEditorStore } from "../../app/store/editorStore";
import {
    mergeViewCompartment,
    readMergeViewRuntimeState,
} from "./extensions/mergeViewDiff";
import { isMergeDecisionStale, syncMergeViewForPaths } from "./mergeViewSync";

function mountView(doc: string) {
    useEditorStore.setState({
        tabs: [
            {
                id: "tab-1",
                kind: "note",
                noteId: "notes/current",
                title: "Current",
                content: doc,
                history: [],
                historyIndex: 0,
            },
        ],
        activeTabId: "tab-1",
        activationHistory: ["tab-1"],
        tabNavigationHistory: ["tab-1"],
        tabNavigationIndex: 0,
    });

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
            useEditorStore.setState({
                tabs: [],
                activeTabId: null,
                activationHistory: [],
                tabNavigationHistory: [],
                tabNavigationIndex: -1,
            });
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
    vaultPath: string | null = null,
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
        vaultPath,
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
    it("detects stale merge decisions when tracked versions drift", () => {
        expect(
            isMergeDecisionStale(2, { trackedVersion: 1, key: "chunk-1" }, [
                { trackedVersion: 1, key: "hunk-1" },
            ]),
        ).toBe(true);
        expect(
            isMergeDecisionStale(2, { trackedVersion: 2, key: "chunk-1" }, [
                { trackedVersion: 1, key: "hunk-1" },
            ]),
        ).toBe(true);
        expect(
            isMergeDecisionStale(2, { trackedVersion: 2, key: "chunk-1" }, [
                { trackedVersion: 2, key: "hunk-1" },
            ]),
        ).toBe(false);
    });

    function buildSameLineDisjointScenario(changeCount: number) {
        const words = ["aa", "bb", "cc", "dd", "ee"].slice(0, changeCount);
        const diffBase = `${words.join(" ")}\nkeep\nkeep\nzoom`;
        const currentText = `${words.map((word) => word.toUpperCase()).join(" ")}\nkeep\nkeep\nZOOM`;
        let offset = 0;
        const spans = words.map((word) => {
            const span = {
                baseFrom: offset,
                baseTo: offset + word.length,
                currentFrom: offset,
                currentTo: offset + word.length,
            };
            offset += word.length + 1;
            return span;
        });
        const zoomBaseFrom = diffBase.lastIndexOf("zoom");
        const zoomCurrentFrom = currentText.lastIndexOf("ZOOM");
        spans.push({
            baseFrom: zoomBaseFrom,
            baseTo: zoomBaseFrom + 4,
            currentFrom: zoomCurrentFrom,
            currentTo: zoomCurrentFrom + 4,
        });

        return {
            diffBase,
            currentText,
            spans,
        };
    }

    it("activates merge with a tracked file", () => {
        const { view, destroy } = mountView("alpHa");
        const path = "notes/current.md";
        useVaultStore.setState({ vaultPath: "/vault-a" });
        const session = createSession(
            "session-1",
            "wc-1",
            [createTrackedFile(path, "alpha", "alpHa")],
            "/vault-a",
        );

        syncMergeViewForPaths(view, [path], {
            [session.sessionId]: session,
        });

        expect(getChunks(view.state)?.chunks.length).toBe(1);
        expect(readMergeViewRuntimeState(view.state)).toMatchObject({
            enabled: true,
            inlineState: "projection_ready",
            sessionId: "session-1",
            targetId: "notes/current",
            targetKind: "note",
            trackedVersion: 1,
            transitionReason: "none",
        });
        destroy();
    });

    it("ignores tracked files from other vaults even when relative paths collide", () => {
        const { view, destroy } = mountView("alpHa");
        const path = "notes/current.md";
        useVaultStore.setState({ vaultPath: "/vault-a" });
        const foreignSession = createSession(
            "session-foreign",
            "wc-foreign",
            [createTrackedFile(path, "wrong", "alpHa")],
            "/vault-b",
        );
        const localSession = createSession(
            "session-local",
            "wc-local",
            [createTrackedFile(path, "alpha", "alpHa")],
            "/vault-a",
        );

        syncMergeViewForPaths(view, [path], {
            [foreignSession.sessionId]: foreignSession,
            [localSession.sessionId]: localSession,
        });

        expect(getOriginalDoc(view.state).toString()).toBe("alpha");
        expect(readMergeViewRuntimeState(view.state)).toMatchObject({
            enabled: true,
            sessionId: "session-local",
            trackedVersion: 1,
        });
        destroy();
    });

    it("activates merge for restored sessions missing vaultPath metadata", () => {
        const { view, destroy } = mountView("alpHa");
        const path = "notes/current.md";
        useVaultStore.setState({ vaultPath: "/vault-a" });
        const legacySession = {
            ...createSession("session-legacy", "wc-legacy", [
                createTrackedFile(path, "alpha", "alpHa"),
            ]),
            vaultPath: undefined,
        };

        syncMergeViewForPaths(view, [path], {
            [legacySession.sessionId]: legacySession,
        });

        expect(getChunks(view.state)?.chunks.length).toBe(1);
        expect(readMergeViewRuntimeState(view.state)).toMatchObject({
            enabled: true,
            sessionId: "session-legacy",
            trackedVersion: 1,
        });
        destroy();
    });

    it("deactivates merge in preview mode", () => {
        const { view, destroy } = mountView("alpHa");
        const path = "notes/current.md";
        useVaultStore.setState({ vaultPath: "/vault-a" });
        const session = createSession(
            "session-1",
            "wc-1",
            [createTrackedFile(path, "alpha", "alpHa")],
            "/vault-a",
        );

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
        expect(readMergeViewRuntimeState(view.state)).toMatchObject({
            enabled: false,
            inlineState: "disabled",
            targetId: null,
            targetKind: null,
            transitionReason: "preview_mode",
        });
        destroy();
    });

    it("waits for the active editor target before mounting merge inline", () => {
        const { view, destroy } = mountView("alpHa");
        const path = "notes/current.md";
        useVaultStore.setState({ vaultPath: "/vault-a" });
        const session = createSession(
            "session-1",
            "wc-1",
            [createTrackedFile(path, "alpha", "alpHa")],
            "/vault-a",
        );
        useEditorStore.setState({
            tabs: [
                {
                    id: "tab-2",
                    kind: "note",
                    noteId: "notes/other",
                    title: "Other",
                    content: "alpHa",
                    history: [],
                    historyIndex: 0,
                },
            ],
            activeTabId: "tab-2",
            activationHistory: ["tab-2"],
            tabNavigationHistory: ["tab-2"],
            tabNavigationIndex: 0,
        });

        syncMergeViewForPaths(view, [path], {
            [session.sessionId]: session,
        });

        expect(getChunks(view.state)).toBeNull();
        expect(view.dom.dataset.mergeTransitioning).toBe("true");
        expect(readMergeViewRuntimeState(view.state)).toMatchObject({
            enabled: false,
            inlineState: "waiting_for_editor_target",
            sessionId: "session-1",
            identityKey: path,
            targetId: "notes/current",
            targetKind: "note",
            trackedVersion: 1,
            transitionReason: "target_not_active",
        });

        destroy();
    });

    it("reconfigures metadata when the review state changes", () => {
        const { view, destroy } = mountView("alpHa");
        const path = "notes/current.md";
        useVaultStore.setState({ vaultPath: "/vault-a" });
        const session = createSession(
            "session-1",
            "wc-1",
            [createTrackedFile(path, "alpha", "alpHa")],
            "/vault-a",
        );
        const pendingFile = createTrackedFile(path, "alpha", "alpHa");
        pendingFile.reviewState = "pending";
        const pendingSession = createSession(
            "session-1",
            "wc-1",
            [pendingFile],
            "/vault-a",
        );

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
        useVaultStore.setState({ vaultPath: "/vault-a" });
        const firstSession = createSession(
            "session-1",
            "wc-1",
            [createTrackedFile(path, "alpha", "alpHa")],
            "/vault-a",
        );
        const secondSession = createSession(
            "session-1",
            "wc-1",
            [createTrackedFile(path, "alpaa", "alpHa")],
            "/vault-a",
        );

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
                [{ trackedVersion: 1, key: "10:10:11:16" }],
            );
            expect(resolveReviewHunks).toHaveBeenNthCalledWith(
                2,
                "session-1",
                path,
                "rejected",
                1,
                [{ trackedVersion: 1, key: "10:10:11:16" }],
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
                [{ trackedVersion: 1, key: "6:11:6:6" }],
            );

            destroy();
        } finally {
            useChatStore.setState(originalState);
        }
    });

    it("suppresses inline decisions while merge view is transitioning out of sync", () => {
        vi.useFakeTimers();
        const originalState = useChatStore.getState();
        const resolveReviewHunks = vi.fn();
        useChatStore.setState({
            ...originalState,
            resolveReviewHunks,
        });

        try {
            const path = "notes/current.md";
            const firstDoc = "FOO bar baz";
            const secondDoc = "FOO bar BAZ";
            const { view, destroy } = mountView(firstDoc);
            const firstSession = createSession("session-1", "wc-1", [
                createTrackedFile(path, "foo bar baz", firstDoc),
            ]);
            const secondSession = createSession("session-1", "wc-1", [
                createTrackedFile(path, "foo bar baz", secondDoc, {
                    version: 2,
                }),
            ]);

            syncMergeViewForPaths(view, [path], {
                [firstSession.sessionId]: firstSession,
            });

            syncMergeViewForPaths(view, [path], {
                [secondSession.sessionId]: secondSession,
            });

            expect(view.dom.dataset.mergeTransitioning).toBe("true");
            expect(
                view.dom.querySelector('[data-review-decision="accept"]'),
            ).toBeNull();

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

            expect(view.dom.dataset.mergeTransitioning).toBeUndefined();

            const freshAccept = view.dom.querySelector(
                '[data-review-decision="accept"]',
            ) as HTMLButtonElement | null;
            expect(freshAccept).not.toBeNull();
            if (freshAccept) {
                fireEvent.mouseDown(freshAccept);
            }
            expect(resolveReviewHunks).toHaveBeenCalledTimes(1);

            destroy();
        } finally {
            useChatStore.setState(originalState);
            vi.useRealTimers();
        }
    });

    it("waits for the editor doc before rendering merge controls", () => {
        const path = "notes/current.md";
        const { view, destroy } = mountView("alpha\nbeta\n");
        const session = createSession("session-1", "wc-1", [
            createTrackedFile(path, "alpha\nbeta\n", "ALPHA\nbeta\n"),
        ]);

        syncMergeViewForPaths(view, [path], {
            [session.sessionId]: session,
        });

        expect(view.dom.dataset.mergeTransitioning).toBe("true");
        expect(readMergeViewRuntimeState(view.state)).toMatchObject({
            enabled: false,
            inlineState: "waiting_for_editor_doc",
            sessionId: "session-1",
            identityKey: path,
            targetId: "notes/current",
            targetKind: "note",
            trackedVersion: 1,
            transitionReason: "editor_doc_stale",
        });
        expect(
            view.dom.querySelector('[data-review-decision="accept"]'),
        ).toBeNull();
        expect(
            view.dom.querySelector('[data-review-decision="reject"]'),
        ).toBeNull();

        view.dispatch({
            changes: {
                from: 0,
                to: view.state.doc.length,
                insert: "ALPHA\nbeta\n",
            },
        });

        syncMergeViewForPaths(view, [path], {
            [session.sessionId]: session,
        });

        expect(readMergeViewRuntimeState(view.state)).toMatchObject({
            enabled: true,
            inlineState: "projection_ready",
            sessionId: "session-1",
            identityKey: path,
            targetId: "notes/current",
            targetKind: "note",
            trackedVersion: 1,
            transitionReason: "none",
        });
        expect(view.dom.dataset.mergeTransitioning).toBeUndefined();
        expect(
            view.dom.querySelector('[data-review-decision="accept"]'),
        ).not.toBeNull();
        expect(
            view.dom.querySelector('[data-review-decision="reject"]'),
        ).not.toBeNull();

        destroy();
    });

    it("cancels stale retries when a newer tracked version arrives", () => {
        vi.useFakeTimers();
        const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
        const path = "notes/current.md";
        const { view, destroy } = mountView("alpha\nbeta\n");
        const sessionV1 = createSession("session-1", "wc-1", [
            createTrackedFile(path, "alpha\nbeta\n", "ALPHA\nbeta\n", {
                version: 1,
            }),
        ]);

        try {
            syncMergeViewForPaths(view, [path], {
                [sessionV1.sessionId]: sessionV1,
            });
            expect(clearTimeoutSpy).not.toHaveBeenCalled();

            const sessionV2 = createSession("session-1", "wc-1", [
                createTrackedFile(path, "alpha\nbeta\n", "ALPHA\nBETA\n", {
                    version: 2,
                }),
            ]);

            syncMergeViewForPaths(view, [path], {
                [sessionV2.sessionId]: sessionV2,
            });

            expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
        } finally {
            destroy();
            clearTimeoutSpy.mockRestore();
            vi.useRealTimers();
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
                [{ trackedVersion: 2, key: "0:5:0:5" }],
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

        expect(view.dom.textContent).not.toContain("Review in Changes");
        expect(
            view.dom.querySelectorAll('[data-review-decision="accept"]'),
        ).toHaveLength(1);
        expect(
            view.dom.querySelector(".cm-review-chunk-controls")
                ?.textContent,
        ).toContain("3 changes");
        expect(
            view.dom.querySelector('[data-review-hunk-key="0:3:0:3"]'),
        ).toBeNull();
        expect(
            view.dom.querySelector(
                '[data-review-presentation-mode="grouped"]',
            ),
        ).not.toBeNull();

        destroy();
    });

    it("keeps inline hunk actions available after a second nearby edit on the same line", () => {
        const path = "notes/current.md";
        const diffBase = "foo bar baz";
        const firstDoc = "FOO bar baz";
        const secondDoc = "FOO bar BAZ";

        const { view, destroy } = mountView(firstDoc);
        const firstFile = createTrackedFile(path, diffBase, firstDoc);
        const secondFile = createTrackedFile(path, diffBase, secondDoc, {
            version: 2,
        });
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

        expect(view.dom.textContent).not.toContain("Review in Changes");
        expect(
            view.dom.querySelectorAll('[data-review-decision="accept"]'),
        ).toHaveLength(2);
        expect(
            view.dom.querySelector('[data-review-hunk-key="0:3:0:3"]'),
        ).not.toBeNull();
        expect(
            view.dom.querySelector('[data-review-hunk-key="8:11:8:11"]'),
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
                '[data-review-decision="accept"][data-review-hunk-key="0:3:0:3"]',
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
                [{ trackedVersion: 1, key: "0:3:0:3" }],
            );

            destroy();
        } finally {
            useChatStore.setState(originalState);
        }
    });

    it.each([3, 4, 5])(
        "keeps %i same-line disjoint hunks inline while keeping precise neighbor actions",
        (changeCount) => {
            const originalState = useChatStore.getState();
            const resolveReviewHunks = vi.fn();
            useChatStore.setState({
                ...originalState,
                resolveReviewHunks,
            });

            const scenario = buildSameLineDisjointScenario(changeCount);
            const { view, destroy } = mountView(scenario.currentText);
            const path = "notes/current.md";
            const session = createSession("session-1", "wc-1", [
                createTrackedFile(
                    path,
                    scenario.diffBase,
                    scenario.currentText,
                    {
                        unreviewedRanges: {
                            spans: scenario.spans,
                        },
                        unreviewedEdits: buildPatchFromTexts(
                            scenario.diffBase,
                            scenario.currentText,
                        ),
                    },
                ),
            ]);

            try {
                syncMergeViewForPaths(view, [path], {
                    [session.sessionId]: session,
                });

                expect(view.dom.textContent).not.toContain("Review in Changes");
                expect(
                    view.dom.querySelectorAll(
                        '[data-review-decision="accept"]',
                    ),
                ).toHaveLength(changeCount + 1);
                expect(
                    view.dom.querySelectorAll(
                        '[data-review-decision="reject"]',
                    ),
                ).toHaveLength(changeCount + 1);

                const acceptButton = view.dom.querySelector(
                    '[data-review-decision="accept"][data-review-hunk-key="0:2:0:2"]',
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
                    [{ trackedVersion: 1, key: "0:2:0:2" }],
                );

                destroy();
            } finally {
                useChatStore.setState(originalState);
            }
        },
    );

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

    it("keeps exact inline actions available for large files", () => {
        const path = "notes/current.md";
        const diffBase = Array.from(
            { length: 10 },
            (_, index) => `line ${index}`,
        ).join("\n");
        const currentText = Array.from({ length: 10 }, (_, index) =>
            index % 2 === 0 ? `LINE ${index}` : `line ${index}`,
        ).join("\n");

        const { view, destroy } = mountView(currentText);
        const session = createSession("session-1", "wc-1", [
            createTrackedFile(path, diffBase, currentText),
        ]);

        syncMergeViewForPaths(view, [path], {
            [session.sessionId]: session,
        });

        expect(view.dom.textContent).not.toContain("Review in Changes");
        expect(
            view.dom.querySelectorAll('[data-review-decision="accept"]').length,
        ).toBeGreaterThan(0);
        expect(
            view.dom.querySelectorAll('[data-review-decision="reject"]').length,
        ).toBeGreaterThan(0);

        destroy();
    });
});
