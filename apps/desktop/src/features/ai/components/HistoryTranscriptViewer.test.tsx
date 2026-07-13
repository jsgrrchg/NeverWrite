import { act, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderComponent } from "../../../test/test-utils";
import { resetChatStore, useChatStore } from "../store/chatStore";
import type { AIChatSession } from "../types";
import { AI_CHAT_CONTENT_MAX_WIDTH_PX } from "./chatContentLayout";
import { resetChatMessageListViewState } from "./chatMessageListViewState";
import { HistoryTranscriptViewer } from "./HistoryTranscriptViewer";

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
        resetChatMessageListViewState();
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

    it("renders the history transcript through the shared capped message column", () => {
        const session = createEmptyPersistedSession("history-column", {
            messages: [
                {
                    id: "history-column-message",
                    role: "assistant",
                    kind: "text",
                    content: "Persisted transcript content",
                    timestamp: 10,
                },
            ],
        });

        useChatStore.setState((state) => ({
            ...state,
            runtimes: [],
            ensureSessionTranscriptLoaded: vi.fn().mockResolvedValue(true),
            sessionsById: {
                [session.sessionId]: session,
            },
        }));

        const view = renderComponent(
            <HistoryTranscriptViewer historySessionId={session.sessionId} />,
        );
        const messageColumn = view.container.querySelector(
            '[data-selectable="true"]',
        );

        expect(
            screen.getByText("Persisted transcript content"),
        ).toBeInTheDocument();
        expect(messageColumn).not.toBeNull();
        expect(messageColumn).toHaveStyle({
            width: "100%",
            maxWidth: `${AI_CHAT_CONTENT_MAX_WIDTH_PX}px`,
            marginInline: "auto",
        });
    });

    it("renders persisted tool activity through the read-only activity rail", () => {
        const session = createEmptyPersistedSession("history-activity-rail", {
            messages: [
                {
                    id: "history-tool-1",
                    role: "assistant",
                    kind: "tool",
                    content: "Read project notes",
                    title: "Read project notes",
                    timestamp: 10,
                    meta: {
                        status: "completed",
                        target: "/vault/notes/project.md",
                        tool: "read",
                    },
                },
                {
                    id: "history-tool-2",
                    role: "assistant",
                    kind: "tool",
                    content: "Search project notes",
                    title: "Search project notes",
                    timestamp: 11,
                    meta: {
                        status: "completed",
                        tool: "search",
                    },
                },
            ],
        });

        useChatStore.setState((state) => ({
            ...state,
            runtimes: [],
            ensureSessionTranscriptLoaded: vi.fn().mockResolvedValue(true),
            sessionsById: {
                [session.sessionId]: session,
            },
        }));

        const view = renderComponent(
            <HistoryTranscriptViewer historySessionId={session.sessionId} />,
        );

        expect(
            view.container.querySelector('[data-activity-rail="true"]'),
        ).toHaveAttribute("data-activity-count", "2");
        expect(
            view.container.querySelectorAll("[data-tool-activity-id]"),
        ).toHaveLength(0);
    });
});
