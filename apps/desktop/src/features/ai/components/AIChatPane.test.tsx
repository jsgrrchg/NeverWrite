import { getDesktopPlatform } from "../../../app/utils/platform";
import { fireEvent, render, screen } from "@testing-library/react";
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

vi.mock("./AIChatMessageList", () => ({
    AIChatMessageList: ({ findOpen }: { findOpen?: boolean }) => <div data-testid="transcript-messages" data-find-open={String(Boolean(findOpen))} />,
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
            screen.getByRole("button", { name: "New chat" }),
        );
        expect(
            screen.queryByRole("button", { name: "History" }),
        ).toBeNull();
    });
    it("combines archived transcript and pane actions in one row", () => {
        useArchivedChatsStore.getState().archive("session-a");
        const { container } = render(<AIChatPane />);

        const title = screen.getByText("Conversation title");
        const row = title.parentElement!;
        expect(screen.getAllByText("Conversation title")).toHaveLength(1);
        expect(container.querySelector("header")).toBeNull();
        for (const name of ["Unarchive", "New chat", "Chat pane position", "Hide chat pane"]) {
            expect(row).toContainElement(screen.getByRole("button", { name }));
        }
        expect(screen.queryByRole("button", { name: "Fork" })).toBeNull();
        expect(screen.queryByText(/test-model/)).toBeNull();
        expect(screen.queryByRole("button", { name: "Find" })).toBeNull();
        const messages = screen.getByTestId("transcript-messages");
        const action = screen.getByRole("button", { name: "Unarchive" });
        action.focus();
        fireEvent.keyDown(action, {
            key: "f",
            ...(getDesktopPlatform() === "macos" ? { metaKey: true } : { ctrlKey: true }),
        });
        expect(messages).toHaveAttribute("data-find-open", "true");
    });

});
