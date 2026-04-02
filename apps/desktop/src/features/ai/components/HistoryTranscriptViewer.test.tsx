import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderComponent } from "../../../test/test-utils";
import { resetChatStore, useChatStore } from "../store/chatStore";
import type { AIChatSession } from "../types";
import { HistoryTranscriptViewer } from "./HistoryTranscriptViewer";

vi.mock("./AIChatMessageList", () => ({
    AIChatMessageList: () => <div data-testid="history-message-list" />,
}));

function createEmptyPersistedSession(
    sessionId: string,
    overrides: Partial<AIChatSession> = {},
): AIChatSession {
    return {
        sessionId,
        historySessionId: sessionId,
        status: "idle",
        runtimeId: "codex-acp",
        modelId: "test-model",
        modeId: "default",
        models: [],
        modes: [],
        configOptions: [],
        messages: [],
        attachments: [],
        runtimeState: "persisted_only",
        isPersistedSession: true,
        persistedMessageCount: 0,
        loadedPersistedMessageStart: null,
        isLoadingPersistedMessages: false,
        activeWorkCycleId: null,
        visibleWorkCycleId: null,
        resumeContextPending: false,
        ...overrides,
    };
}

describe("HistoryTranscriptViewer", () => {
    beforeEach(() => {
        resetChatStore();
    });

    it("does not reload an empty history session when only the session object identity changes", async () => {
        const session = createEmptyPersistedSession("empty-history");
        const ensureSessionTranscriptLoaded = vi.fn().mockResolvedValue(true);

        useChatStore.setState((state) => ({
            ...state,
            runtimes: [],
            ensureSessionTranscriptLoaded,
            sessionsById: {
                [session.sessionId]: session,
            },
        }));

        renderComponent(
            <HistoryTranscriptViewer historySessionId={session.sessionId} />,
        );

        await waitFor(() => {
            expect(ensureSessionTranscriptLoaded).toHaveBeenCalledTimes(1);
        });
        expect(ensureSessionTranscriptLoaded).toHaveBeenCalledWith(
            session.sessionId,
            "full",
        );

        await act(async () => {
            useChatStore.setState((state) => ({
                ...state,
                sessionsById: {
                    ...state.sessionsById,
                    [session.sessionId]: {
                        ...state.sessionsById[session.sessionId]!,
                        persistedUpdatedAt: 42,
                    },
                },
            }));
        });

        expect(ensureSessionTranscriptLoaded).toHaveBeenCalledTimes(1);
    });
});
