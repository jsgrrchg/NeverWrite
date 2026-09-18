import { useEditorStore } from "../../../app/store/editorStore";
import { useLayoutStore } from "../../../app/store/layoutStore";
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
        useEditorStore.getState().hydrateTabs([], null);
        useLayoutStore.setState({ chatPaneVisible: true });
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
    it("only makes the standalone chat header draggable on macOS", () => {
        useChatTabsStore.getState().showHistory();
        const { container } = render(<AIChatPane />);
        expect(
            container.querySelector("header")?.classList.contains("drag"),
        ).toBe(getDesktopPlatform() === "macos");
    });
    it("toggles expansion and restores editors when the chat is hidden", () => {
        useEditorStore.getState().openNote("a", "A", "a");
        render(<AIChatPane />);
        fireEvent.click(screen.getByRole("button", { name: "Expand chat" }));
        expect(useChatTabsStore.getState().chatExpanded).toBe(true);
        fireEvent.click(screen.getByRole("button", { name: "Restore panes" }));
        expect(useChatTabsStore.getState().chatExpanded).toBe(false);
        fireEvent.click(screen.getByRole("button", { name: "Expand chat" }));
        fireEvent.click(screen.getByRole("button", { name: "Hide chat pane" }));
        expect(useChatTabsStore.getState().chatExpanded).toBe(false);
        expect(useLayoutStore.getState().chatPaneVisible).toBe(false);
    });
    it("opens archived conversations in the same editable session view", () => {
        useArchivedChatsStore.getState().archive("session-a");
        render(<AIChatPane />);
        expect(screen.getByTestId("session-view")).toBeInTheDocument();
        expect(useArchivedChatsStore.getState().isArchived("session-a")).toBe(true);
    });
});
