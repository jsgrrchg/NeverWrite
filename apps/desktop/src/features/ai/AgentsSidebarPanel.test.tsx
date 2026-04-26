import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { renderComponent } from "../../test/test-utils";
import { AgentsSidebarPanel } from "./AgentsSidebarPanel";
import { usePinnedChatsStore } from "./store/pinnedChatsStore";
import { resetChatStore, useChatStore } from "./store/chatStore";
import type { AIChatSession, AIChatSessionStatus } from "./types";

const chatPaneMovementMock = vi.hoisted(() => ({
    createNewChatInWorkspace: vi.fn(),
    openChatHistoryInWorkspace: vi.fn(),
    openChatSessionInWorkspace: vi.fn(),
}));

vi.mock("./chatPaneMovement", () => chatPaneMovementMock);

function createSession(
    sessionId: string,
    title: string,
    status: AIChatSessionStatus = "idle",
    timestamp = 10,
): AIChatSession {
    return {
        sessionId,
        historySessionId: sessionId,
        status,
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
                timestamp,
            },
        ],
        attachments: [],
        activeWorkCycleId: null,
        visibleWorkCycleId: null,
        runtimeState: "live",
    };
}

describe("AgentsSidebarPanel", () => {
    beforeEach(() => {
        resetChatStore();
        vi.clearAllMocks();
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
            entries: [],
        });
        usePinnedChatsStore.setState({ entries: {} });
        useEditorStore.getState().hydrateTabs([], null);
        useChatStore.setState({
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
                {
                    runtime: {
                        id: "claude-acp",
                        name: "Claude ACP",
                        description: "",
                        capabilities: [],
                    },
                    models: [],
                    modes: [],
                    configOptions: [],
                },
            ],
            selectedRuntimeId: "codex-acp",
        });
    });

    it("creates a chat directly from the plus button without opening a provider menu", () => {
        renderComponent(<AgentsSidebarPanel />);

        fireEvent.click(screen.getByRole("button", { name: "New chat" }));

        expect(
            chatPaneMovementMock.createNewChatInWorkspace,
        ).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole("button", { name: "Codex" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Claude" })).toBeNull();
        expect(
            screen.queryByRole("button", { name: "Add providers" }),
        ).toBeNull();
    });

    it("keeps open working agents in the order they became busy", async () => {
        const alpha = createSession(
            "session-alpha",
            "Alpha task",
            "streaming",
            100,
        );
        const beta = createSession("session-beta", "Beta task", "idle", 200);

        useChatStore.setState((state) => ({
            ...state,
            sessionsById: {
                [alpha.sessionId]: alpha,
                [beta.sessionId]: beta,
            },
            sessionOrder: [beta.sessionId, alpha.sessionId],
        }));
        useEditorStore.getState().openChat(alpha.sessionId, {
            title: "Alpha task",
            paneId: "primary",
        });
        useEditorStore.getState().openChat(beta.sessionId, {
            background: true,
            title: "Beta task",
            paneId: "primary",
        });

        renderComponent(<AgentsSidebarPanel />);

        act(() => {
            useChatStore.setState((state) => ({
                ...state,
                sessionsById: {
                    ...state.sessionsById,
                    [beta.sessionId]: createSession(
                        beta.sessionId,
                        "Beta task",
                        "streaming",
                        300,
                    ),
                },
            }));
        });

        await waitFor(() => {
            const labels = screen
                .getAllByRole("option")
                .map((item) => item.textContent ?? "");
            expect(labels[0]).toContain("Alpha task");
            expect(labels[1]).toContain("Beta task");
        });
    });
});
