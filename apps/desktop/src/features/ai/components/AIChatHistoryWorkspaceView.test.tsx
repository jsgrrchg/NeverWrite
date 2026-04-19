import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../../app/store/editorStore";
import { renderComponent } from "../../../test/test-utils";
import { resetChatStore, useChatStore } from "../store/chatStore";
import type { AIChatSession } from "../types";
import { AIChatHistoryWorkspaceView } from "./AIChatHistoryWorkspaceView";

function createSession(
    sessionId: string,
    content: string,
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
        messages: [
            {
                id: `${sessionId}-message-1`,
                role: "user",
                kind: "text",
                content,
                timestamp: 1,
            },
        ],
        attachments: [],
        activeWorkCycleId: null,
        visibleWorkCycleId: null,
        resumeContextPending: false,
        persistedUpdatedAt: 10,
        runtimeState: "live",
        ...overrides,
    };
}

describe("AIChatHistoryWorkspaceView", () => {
    beforeEach(() => {
        resetChatStore();
        useEditorStore.getState().hydrateWorkspace(
            [
                {
                    id: "primary",
                    tabs: [],
                    activeTabId: null,
                },
            ],
            "primary",
        );
    });

    it("restores a history session into the workspace without closing history state", async () => {
        const session = createSession("session-a", "Saved conversation");
        const loadSession = vi.fn().mockResolvedValue(undefined);

        useChatStore.setState((state) => ({
            ...state,
            loadSession,
            historyViewOpen: true,
            runtimes: [
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
            ],
            sessionsById: {
                [session.sessionId]: session,
            },
            sessionOrder: [session.sessionId],
        }));

        renderComponent(<AIChatHistoryWorkspaceView />);

        await screen.findByRole("button", { name: "Restore" });
        expect(screen.queryByTitle("Back to chat")).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Restore" }));

        await waitFor(() => {
            expect(loadSession).toHaveBeenCalledWith("session-a");
            expect(useChatStore.getState().historyViewOpen).toBe(true);
            expect(
                useEditorStore
                    .getState()
                    .tabs.some(
                        (tab) =>
                            tab.kind === "ai-chat" &&
                            tab.sessionId === "session-a",
                    ),
            ).toBe(true);
        });
    });
});
