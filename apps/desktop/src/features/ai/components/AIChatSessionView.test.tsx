import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../../app/store/editorStore";
import { useVaultStore } from "../../../app/store/vaultStore";
import { renderComponent } from "../../../test/test-utils";
import { resetChatStore, useChatStore } from "../store/chatStore";
import type { AIChatSession } from "../types";
import { AIChatSessionView } from "./AIChatSessionView";

vi.mock("./AIChatMessageList", () => ({
    AIChatMessageList: () => <div data-testid="chat-message-list" />,
}));

vi.mock("./AIChatComposer", () => ({
    AIChatComposer: () => <div data-testid="chat-composer" />,
}));

vi.mock("./AIChatContextBar", () => ({
    AIChatContextBar: () => <div data-testid="chat-context-bar" />,
}));

vi.mock("./AIChatAgentControls", () => ({
    AIChatAgentControls: () => <div data-testid="chat-agent-controls" />,
}));

vi.mock("./EditedFilesBufferPanel", () => ({
    EditedFilesBufferPanel: () => <div data-testid="edited-files-panel" />,
}));

vi.mock("./QueuedMessagesPanel", () => ({
    QueuedMessagesPanel: () => <div data-testid="queued-messages-panel" />,
}));

vi.mock("./AIChatRuntimeBanner", () => ({
    AIChatRuntimeBanner: () => <div data-testid="chat-runtime-banner" />,
}));

function createSession(sessionId: string, title: string): AIChatSession {
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
                id: `${sessionId}-message`,
                role: "user",
                kind: "text",
                content: title,
                timestamp: 10,
            },
        ],
        attachments: [],
        activeWorkCycleId: null,
        visibleWorkCycleId: null,
        runtimeState: "live",
    };
}

describe("AIChatSessionView", () => {
    beforeEach(() => {
        resetChatStore();
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
            entries: [],
        });
        useEditorStore.setState({
            tabs: [],
            activeTabId: null,
        });
    });

    it("renames the workspace chat from the local header title on double click", async () => {
        useChatStore.setState((state) => ({
            ...state,
            sessionsById: {
                "session-a": createSession("session-a", "Workspace chat"),
            },
            activeSessionId: "session-a",
        }));
        useEditorStore.getState().openChat("session-a", {
            title: "Workspace chat",
            paneId: "primary",
        });

        renderComponent(<AIChatSessionView paneId="primary" />);

        fireEvent.doubleClick(screen.getByText("Workspace chat"));

        const input = screen.getByDisplayValue("Workspace chat");
        fireEvent.change(input, {
            target: { value: "Renamed workspace chat" },
        });
        fireEvent.keyDown(input, { key: "Enter" });

        await waitFor(() => {
            expect(
                useChatStore.getState().sessionsById["session-a"]?.customTitle,
            ).toBe("Renamed workspace chat");
        });

        expect(screen.getByText("Renamed workspace chat")).toBeInTheDocument();
    });
});
