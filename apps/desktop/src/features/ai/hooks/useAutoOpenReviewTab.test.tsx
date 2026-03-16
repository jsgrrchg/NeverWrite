import { beforeEach, describe, expect, it } from "vitest";
import { isReviewTab, useEditorStore } from "../../../app/store/editorStore";
import { renderComponent } from "../../../test/test-utils";
import type {
    AIEditedFileBufferEntry,
    AIChatSession,
    AIRuntimeDescriptor,
} from "../types";
import { resetChatStore, useChatStore } from "../store/chatStore";
import { useAutoOpenReviewTab } from "./useAutoOpenReviewTab";

function AutoOpenReviewHarness() {
    useAutoOpenReviewTab();
    return null;
}

function createEntry(path: string): AIEditedFileBufferEntry {
    return {
        identityKey: path,
        originPath: path,
        path,
        previousPath: null,
        operation: "update",
        baseText: "old line",
        appliedText: "new line",
        reversible: true,
        isText: true,
        supported: true,
        status: "pending",
        appliedHash: "hash-1",
        currentHash: null,
        additions: 1,
        deletions: 1,
        updatedAt: 10,
    };
}

function createSession(
    sessionId: string,
    entries: AIEditedFileBufferEntry[],
    runtimeId = "codex-acp",
): AIChatSession {
    const workCycleId = `${sessionId}-cycle`;

    return {
        sessionId,
        historySessionId: sessionId,
        status: "idle",
        activeWorkCycleId: workCycleId,
        visibleWorkCycleId: workCycleId,
        editedFilesBufferByWorkCycleId: {
            [workCycleId]: entries,
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
    });

    it("opens a background review tab when another session starts surfacing edits", () => {
        renderComponent(<AutoOpenReviewHarness />);

        const sessionA = createSession("session-a", [
            createEntry("/vault/a.ts"),
        ]);
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

        const sessionB = createSession("session-b", [
            createEntry("/vault/b.ts"),
        ]);
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

        const session = createSession("session-a", [
            createEntry("/vault/a.ts"),
        ]);
        useChatStore.setState((state) => ({
            ...state,
            runtimes,
            activeSessionId: session.sessionId,
            sessionsById: {
                [session.sessionId]: session,
            },
        }));

        useChatStore.setState((state) => ({
            ...state,
            sessionsById: {
                [session.sessionId]: {
                    ...session,
                    editedFilesBufferByWorkCycleId: {
                        [`${session.sessionId}-cycle`]: [
                            createEntry("/vault/a.ts"),
                            createEntry("/vault/b.ts"),
                        ],
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
});
