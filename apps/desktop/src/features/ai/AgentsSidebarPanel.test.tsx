import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { confirm } from "@neverwrite/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { renderComponent } from "../../test/test-utils";
import { AgentsSidebarPanel } from "./AgentsSidebarPanel";
import { usePinnedChatsStore } from "./store/pinnedChatsStore";
import { resetChatStore, useChatStore } from "./store/chatStore";
import type { AIChatSession, AIChatSessionStatus } from "./types";
import {
    AGENT_SIDEBAR_DRAG_EVENT,
    type AgentSidebarDragDetail,
} from "./agentSidebarDragEvents";

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
    overrides: Partial<AIChatSession> = {},
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
        ...overrides,
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
        vi.mocked(confirm).mockResolvedValue(true);
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

    it("opens a provider menu from the plus button before creating a chat", async () => {
        renderComponent(<AgentsSidebarPanel />);

        fireEvent.click(screen.getByRole("button", { name: "New chat" }));

        expect(
            chatPaneMovementMock.createNewChatInWorkspace,
        ).not.toHaveBeenCalled();
        expect(
            await screen.findByRole("button", { name: "Codex" }),
        ).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Claude" }));

        await waitFor(() => {
            expect(
                chatPaneMovementMock.createNewChatInWorkspace,
            ).toHaveBeenCalledTimes(1);
        });
        expect(
            chatPaneMovementMock.createNewChatInWorkspace,
        ).toHaveBeenCalledWith("claude-acp");
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

    it("renders subagents under their parent and opens the child row", async () => {
        const parent = createSession("session-parent", "Parent task");
        const child = createSession(
            "session-child",
            "Worker investigation",
            "streaming",
            200,
            { parentSessionId: parent.sessionId },
        );

        useChatStore.setState((state) => ({
            ...state,
            sessionsById: {
                [parent.sessionId]: parent,
                [child.sessionId]: child,
            },
            sessionOrder: [child.sessionId, parent.sessionId],
        }));

        renderComponent(<AgentsSidebarPanel />);

        const labels = screen
            .getAllByRole("option")
            .map((item) => item.textContent ?? "");
        expect(labels[0]).toContain("Parent task");
        expect(labels[1]).toContain("Worker investigation");
        expect(labels[1]).not.toContain("Agent");
        expect(labels[1]).toContain("Working");

        fireEvent.click(screen.getAllByRole("option")[1]);

        await waitFor(() => {
            expect(
                chatPaneMovementMock.openChatSessionInWorkspace,
            ).toHaveBeenCalledWith("session-child");
        });
    });

    it("emits agent drag events from a sidebar row without opening it", () => {
        const alpha = createSession("session-alpha", "Alpha task");
        useChatStore.setState((state) => ({
            ...state,
            sessionsById: {
                [alpha.sessionId]: alpha,
            },
            sessionOrder: [alpha.sessionId],
        }));

        const dragEvents: AgentSidebarDragDetail[] = [];
        const handleDrag = (event: Event) => {
            dragEvents.push(
                (event as CustomEvent<AgentSidebarDragDetail>).detail,
            );
        };
        window.addEventListener(AGENT_SIDEBAR_DRAG_EVENT, handleDrag);

        try {
            renderComponent(<AgentsSidebarPanel />);

            const row = screen.getByRole("option");
            fireEvent.pointerDown(row, {
                button: 0,
                pointerId: 1,
                clientX: 10,
                clientY: 10,
            });
            fireEvent.pointerMove(row, {
                pointerId: 1,
                clientX: 20,
                clientY: 10,
            });
            expect(
                screen.getByText("Drag to open in pane · Codex"),
            ).toBeInTheDocument();
            fireEvent.pointerUp(row, {
                pointerId: 1,
                clientX: 24,
                clientY: 12,
            });
            expect(
                screen.queryByText("Drag to open in pane · Codex"),
            ).toBeNull();

            expect(dragEvents.map((event) => event.phase)).toEqual([
                "start",
                "move",
                "end",
            ]);
            expect(dragEvents[0]).toMatchObject({
                sessionId: alpha.sessionId,
                title: "Alpha task",
            });
            expect(
                chatPaneMovementMock.openChatSessionInWorkspace,
            ).not.toHaveBeenCalled();
        } finally {
            window.removeEventListener(AGENT_SIDEBAR_DRAG_EVENT, handleDrag);
        }
    });

    it("keeps working subagents in activation order under their parent", async () => {
        const parent = createSession("session-parent", "Parent task", "streaming");
        const heisenberg = createSession(
            "session-heisenberg",
            "Heisenberg",
            "streaming",
            100,
            { parentSessionId: parent.sessionId },
        );
        const mill = createSession("session-mill", "Mill", "streaming", 300, {
            parentSessionId: parent.sessionId,
        });

        useChatStore.setState((state) => ({
            ...state,
            sessionsById: {
                [parent.sessionId]: parent,
                [heisenberg.sessionId]: heisenberg,
                [mill.sessionId]: mill,
            },
            sessionOrder: [
                parent.sessionId,
                heisenberg.sessionId,
                mill.sessionId,
            ],
        }));

        renderComponent(<AgentsSidebarPanel />);

        await waitFor(() => {
            const labels = screen
                .getAllByRole("option")
                .map((item) => item.textContent ?? "");
            expect(labels[0]).toContain("Parent task");
            expect(labels[1]).toContain("Heisenberg");
            expect(labels[2]).toContain("Mill");
        });
    });

    it("keeps parent context visible when filtering by child content", () => {
        const parent = createSession("session-parent", "Parent task");
        const child = createSession(
            "session-child",
            "Needle subagent result",
            "idle",
            200,
            { parentSessionId: parent.sessionId },
        );

        useChatStore.setState((state) => ({
            ...state,
            sessionsById: {
                [parent.sessionId]: parent,
                [child.sessionId]: child,
            },
            sessionOrder: [parent.sessionId, child.sessionId],
        }));

        renderComponent(<AgentsSidebarPanel />);

        fireEvent.change(screen.getByLabelText("Filter threads"), {
            target: { value: "needle" },
        });

        const labels = screen
            .getAllByRole("option")
            .map((item) => item.textContent ?? "");
        expect(labels[0]).toContain("Parent task");
        expect(labels[1]).toContain("Needle subagent result");
    });

    it("does not start inline rename for subagents", () => {
        const parent = createSession("session-parent", "Parent task");
        const child = createSession(
            "session-child",
            "Worker investigation",
            "idle",
            200,
            { parentSessionId: parent.sessionId },
        );

        useChatStore.setState((state) => ({
            ...state,
            sessionsById: {
                [parent.sessionId]: parent,
                [child.sessionId]: child,
            },
            sessionOrder: [parent.sessionId, child.sessionId],
        }));

        renderComponent(<AgentsSidebarPanel />);

        fireEvent.doubleClick(screen.getAllByRole("option")[1]);

        expect(screen.queryByDisplayValue("Worker investigation")).toBeNull();
    });

    it("confirms destructive parent delete and preserves child sessions", async () => {
        const parent = createSession("session-parent", "Parent task");
        const child = createSession("session-child", "Worker investigation", "idle", 200, {
            parentSessionId: parent.sessionId,
        });
        const deleteSession = vi.fn().mockResolvedValue(undefined);

        useChatStore.setState((state) => ({
            ...state,
            sessionsById: {
                [parent.sessionId]: parent,
                [child.sessionId]: child,
            },
            sessionOrder: [parent.sessionId, child.sessionId],
            deleteSession,
        }));

        renderComponent(<AgentsSidebarPanel />);

        fireEvent.contextMenu(screen.getAllByRole("option")[0]);
        fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

        await waitFor(() => {
            expect(confirm).toHaveBeenCalledWith(
                expect.stringContaining(
                    "1 subagent will stay in the sidebar as a detached agent.",
                ),
                expect.objectContaining({ title: "Delete thread?" }),
            );
        });
        await waitFor(() => {
            expect(deleteSession).toHaveBeenCalledWith(parent.sessionId);
        });
    });

    it("does not delete when sidebar delete confirmation is rejected", async () => {
        vi.mocked(confirm).mockResolvedValue(false);
        const session = createSession("session-alpha", "Alpha task");
        const deleteSession = vi.fn().mockResolvedValue(undefined);

        useChatStore.setState((state) => ({
            ...state,
            sessionsById: {
                [session.sessionId]: session,
            },
            sessionOrder: [session.sessionId],
            deleteSession,
        }));

        renderComponent(<AgentsSidebarPanel />);

        fireEvent.contextMenu(screen.getByRole("option"));
        fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

        await waitFor(() => {
            expect(confirm).toHaveBeenCalledTimes(1);
        });
        expect(deleteSession).not.toHaveBeenCalled();
    });
});
