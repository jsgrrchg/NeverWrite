import { beforeEach, describe, expect, it, vi } from "vitest";
import { isReviewTab, useEditorStore } from "../../../app/store/editorStore";
import { renderComponent } from "../../../test/test-utils";
import type { AIChatSession, AIRuntimeDescriptor } from "../types";
import type { TrackedFile } from "../diff/actionLogTypes";
import * as actionLogModel from "../store/actionLogModel";
import { resetChatStore, useChatStore } from "../store/chatStore";
import { buildPatchFromTexts } from "../store/actionLogModel";
import { useAutoOpenReviewTab } from "./useAutoOpenReviewTab";

function AutoOpenReviewHarness() {
    useAutoOpenReviewTab();
    return null;
}

function createTrackedFile(path: string): TrackedFile {
    return {
        identityKey: path,
        originPath: path,
        path,
        previousPath: null,
        status: { kind: "modified" },
        diffBase: "old line",
        currentText: "new line",
        unreviewedEdits: buildPatchFromTexts("old line", "new line"),
        version: 1,
        isText: true,
        updatedAt: 10,
    };
}

function createSession(
    sessionId: string,
    paths: string[],
    runtimeId = "codex-acp",
): AIChatSession {
    const workCycleId = `${sessionId}-cycle`;
    const tracked: Record<string, TrackedFile> = {};
    for (const p of paths) {
        tracked[p] = createTrackedFile(p);
    }

    return {
        sessionId,
        historySessionId: sessionId,
        status: "idle",
        activeWorkCycleId: workCycleId,
        visibleWorkCycleId: workCycleId,
        actionLog: {
            trackedFilesByWorkCycleId: { [workCycleId]: tracked },
            lastRejectUndo: null,
        },
        runtimeId,
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

const runtimes: AIRuntimeDescriptor[] = [
    {
        runtime: {
            id: "codex-acp",
            name: "Codex ACP",
            description: "",
            capabilities: [],
        },
        models: [],
        modes: [],
        configOptions: [],
    },
];

describe("useAutoOpenReviewTab", () => {
    beforeEach(() => {
        resetChatStore();
        useEditorStore.setState({
            tabs: [],
            activeTabId: null,
            activationHistory: [],
            tabNavigationHistory: [],
            tabNavigationIndex: -1,
        });
    });

    it("opens a background review tab when another session starts surfacing edits", () => {
        renderComponent(<AutoOpenReviewHarness />);

        const sessionA = createSession("session-a", ["/vault/a.ts"]);
        useChatStore.setState((state) => ({
            ...state,
            runtimes,
            activeSessionId: sessionA.sessionId,
            sessionsById: {
                [sessionA.sessionId]: sessionA,
            },
        }));

        let reviewTabs = useEditorStore
            .getState()
            .tabs.filter((tab) => isReviewTab(tab));
        expect(reviewTabs).toHaveLength(1);
        expect(reviewTabs[0]?.sessionId).toBe("session-a");
        expect(reviewTabs[0]?.title).toBe("Review Codex");

        const sessionB = createSession("session-b", ["/vault/b.ts"]);
        useChatStore.setState((state) => ({
            ...state,
            sessionsById: {
                ...state.sessionsById,
                [sessionB.sessionId]: sessionB,
            },
        }));

        reviewTabs = useEditorStore
            .getState()
            .tabs.filter((tab) => isReviewTab(tab));
        expect(reviewTabs).toHaveLength(2);
        expect(reviewTabs.map((tab) => tab.sessionId)).toEqual([
            "session-a",
            "session-b",
        ]);
    });

    it("does not create duplicate review tabs for the same session", () => {
        renderComponent(<AutoOpenReviewHarness />);

        const session = createSession("session-a", ["/vault/a.ts"]);
        useChatStore.setState((state) => ({
            ...state,
            runtimes,
            activeSessionId: session.sessionId,
            sessionsById: {
                [session.sessionId]: session,
            },
        }));

        // Add more tracked files to simulate additional edits
        useChatStore.setState((state) => ({
            ...state,
            sessionsById: {
                [session.sessionId]: {
                    ...session,
                    actionLog: {
                        trackedFilesByWorkCycleId: {
                            [`${session.sessionId}-cycle`]: {
                                "/vault/a.ts": createTrackedFile("/vault/a.ts"),
                                "/vault/b.ts": createTrackedFile("/vault/b.ts"),
                            },
                        },
                        lastRejectUndo: null,
                    },
                },
            },
        }));

        const reviewTabs = useEditorStore
            .getState()
            .tabs.filter((tab) => isReviewTab(tab));
        expect(reviewTabs).toHaveLength(1);
        expect(reviewTabs[0]?.sessionId).toBe("session-a");
    });

    it("reopens a review tab when a resolved session surfaces new edits again", () => {
        renderComponent(<AutoOpenReviewHarness />);

        const session = createSession("session-a", ["/vault/a.ts"]);
        useChatStore.setState((state) => ({
            ...state,
            runtimes,
            activeSessionId: session.sessionId,
            sessionsById: {
                [session.sessionId]: session,
            },
        }));

        expect(
            useEditorStore
                .getState()
                .tabs.filter(
                    (tab) =>
                        isReviewTab(tab) && tab.sessionId === session.sessionId,
                ),
        ).toHaveLength(1);

        useChatStore.getState().keepAllEditedFiles(session.sessionId);

        expect(
            useEditorStore
                .getState()
                .tabs.filter(
                    (tab) =>
                        isReviewTab(tab) && tab.sessionId === session.sessionId,
                ),
        ).toHaveLength(0);

        useChatStore.setState((state) => ({
            ...state,
            sessionsById: {
                [session.sessionId]: createSession(session.sessionId, [
                    "/vault/b.ts",
                ]),
            },
        }));

        expect(
            useEditorStore
                .getState()
                .tabs.filter(
                    (tab) =>
                        isReviewTab(tab) && tab.sessionId === session.sessionId,
                ),
        ).toHaveLength(1);
    });

    it("recomputes tracked counts only for sessions whose object changed", () => {
        const sessionA = createSession("session-a", ["/vault/a.ts"]);
        const sessionB = createSession("session-b", ["/vault/b.ts"]);

        useChatStore.setState((state) => ({
            ...state,
            runtimes,
            activeSessionId: sessionA.sessionId,
            sessionsById: {
                [sessionA.sessionId]: sessionA,
                [sessionB.sessionId]: sessionB,
            },
        }));

        const countSpy = vi.spyOn(actionLogModel, "getTrackedFilesForSession");

        renderComponent(<AutoOpenReviewHarness />);
        countSpy.mockClear();

        useChatStore.setState((state) => ({
            ...state,
            sessionsById: {
                ...state.sessionsById,
                [sessionA.sessionId]: {
                    ...state.sessionsById[sessionA.sessionId]!,
                    messages: [
                        {
                            id: "session-a-message",
                            role: "assistant",
                            kind: "text",
                            content: "update",
                            timestamp: 1,
                        },
                    ],
                },
            },
        }));

        expect(countSpy).toHaveBeenCalledTimes(1);
    });
});
