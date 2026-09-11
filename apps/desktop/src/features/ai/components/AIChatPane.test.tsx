import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useArchivedChatsStore } from "../store/archivedChatsStore";
import { resetChatStore, useChatStore } from "../store/chatStore";
import { useChatTabsStore } from "../store/chatTabsStore";
import type { AIChatSession } from "../types";
import { AIChatPane } from "./AIChatPane";

vi.mock("../useChatPaneShortcuts", () => ({
    useChatPaneShortcuts: vi.fn(),
}));

vi.mock("../chatPaneMovement", () => ({
    createNewChatInWorkspace: vi.fn(),
}));

vi.mock("./AIChatSessionView", () => ({
    AIChatSessionView: ({ headerActions }: { headerActions?: ReactNode }) => (
        <div data-testid="session-view">{headerActions}</div>
    ),
}));

vi.mock("./AIChatHistoryWorkspaceView", () => ({
    AIChatHistoryWorkspaceView: () => <div />,
}));

function createSession(): AIChatSession {
    return {
        sessionId: "session-a",
        historySessionId: "session-a",
        status: "idle",
        runtimeId: "codex-acp",
        modelId: "test-model",
        modeId: "default",
        models: [],
        modes: [],
        configOptions: [],
        messages: [],
        attachments: [],
        activeWorkCycleId: null,
        visibleWorkCycleId: null,
        runtimeState: "live",
        customTitle: "Conversation title",
    };
}

describe("AIChatPane", () => {
    beforeEach(() => {
        resetChatStore();
        useArchivedChatsStore.setState({ vaultPath: "/vault", entries: {} });
        useChatTabsStore.getState().reset();
        useChatStore.setState({
            sessionsById: { "session-a": createSession() },
            ensureSessionTranscriptLoaded: vi.fn().mockResolvedValue(true),
        });
        useChatTabsStore.getState().showConversation("session-a");
    });

    it("uses the conversation header as the only toolbar", () => {
        const { container } = render(<AIChatPane />);

        expect(container.querySelector("header")).toBeNull();
        expect(screen.getByTestId("session-view")).toContainElement(
            screen.getByRole("button", { name: "Chat pane position" }),
        );
        expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
        expect(
            screen.queryByRole("button", { name: "History" }),
        ).toBeNull();
    });
    it("opens archived conversations in the same editable session view", () => {
        useArchivedChatsStore.getState().archive("session-a");
        render(<AIChatPane />);
        expect(screen.getByTestId("session-view")).toBeInTheDocument();
        expect(useArchivedChatsStore.getState().isArchived("session-a")).toBe(true);
    });
});
