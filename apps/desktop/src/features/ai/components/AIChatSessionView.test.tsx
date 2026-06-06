import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../../app/store/editorStore";
import { useVaultStore } from "../../../app/store/vaultStore";
import { renderComponent } from "../../../test/test-utils";
import { resetChatStore, useChatStore } from "../store/chatStore";
import type { AIChatSession } from "../types";
import { AIChatSessionView } from "./AIChatSessionView";
import { AI_CHAT_CONTENT_MAX_WIDTH_PX } from "./chatContentLayout";

vi.mock("./AIChatMessageList", () => ({
    AIChatMessageList: () => <div data-testid="chat-message-list" />,
}));

vi.mock("./AIChatComposer", () => ({
    AIChatComposer: ({
        expanded,
        onToggleExpanded,
    }: {
        expanded?: boolean;
        onToggleExpanded?: () => void;
    }) => (
        <button
            type="button"
            data-testid="chat-composer"
            data-expanded={String(Boolean(expanded))}
            onClick={onToggleExpanded}
        />
    ),
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

function setupWorkspaceSession(sessionId = "session-a") {
    useChatStore.setState((state) => ({
        ...state,
        sessionsById: {
            [sessionId]: createSession(sessionId, "Workspace chat"),
        },
        activeSessionId: sessionId,
    }));
    useEditorStore.getState().openChat(sessionId, {
        title: "Workspace chat",
        paneId: "primary",
    });
}

function expectColumnAncestor(testId: string) {
    const element = screen.getByTestId(testId);
    const column = element.closest('[data-testid="chat-content-column"]');

    expect(column).not.toBeNull();
    expect(column).toHaveStyle({
        width: "100%",
        maxWidth: `${AI_CHAT_CONTENT_MAX_WIDTH_PX}px`,
        marginInline: "auto",
    });

    return column as HTMLElement;
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
        setupWorkspaceSession();

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

    it("removes expired screenshots from the composer", async () => {
        setupWorkspaceSession();
        useChatStore.setState((state) => ({
            ...state,
            sessionsById: {
                "session-a": createSession("session-a", "Workspace chat"),
            },
            activeSessionId: "session-a",
            screenshotRetentionSeconds: 60,
            composerPartsBySessionId: {
                "session-a": [
                    { id: "text-1", type: "text", text: "Review " },
                    {
                        id: "shot-1",
                        type: "screenshot",
                        filePath: "/vault/assets/chat/old.png",
                        mimeType: "image/png",
                        label: "Screenshot 10:42 hrs",
                        createdAt: Date.now() - 61_000,
                    },
                    { id: "text-2", type: "text", text: " please" },
                ],
            },
        }));

        renderComponent(<AIChatSessionView paneId="primary" />);

        await waitFor(() => {
            expect(
                useChatStore.getState().composerPartsBySessionId["session-a"],
            ).toEqual([{ id: "text-1", type: "text", text: "Review  please" }]);
        });
    });

    it("aligns lower chat panels to the shared content column", () => {
        setupWorkspaceSession();

        renderComponent(<AIChatSessionView paneId="primary" />);

        expectColumnAncestor("edited-files-panel");
        expectColumnAncestor("queued-messages-panel");
        expect(
            screen
                .getByTestId("chat-composer")
                .closest('[data-testid="chat-content-column"]'),
        ).toBeNull();
    });

    it("keeps the composer flexible while it is expanded", () => {
        setupWorkspaceSession();

        renderComponent(<AIChatSessionView paneId="primary" />);

        fireEvent.click(screen.getByTestId("chat-composer"));

        expect(screen.getByTestId("chat-composer")).toHaveAttribute(
            "data-expanded",
            "true",
        );
    });
});
