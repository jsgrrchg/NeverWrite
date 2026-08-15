import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { confirm } from "@neverwrite/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../app/store/editorStore";
import { useSettingsStore } from "../../app/store/settingsStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { renderComponent } from "../../test/test-utils";
import { AgentsSidebarPanel } from "./AgentsSidebarPanel";
import {
    resetTerminalRuntimeStoreForTests,
    useTerminalRuntimeStore,
    type WorkspaceTerminalRuntime,
} from "../terminal/terminalRuntimeStore";
import { EMPTY_TERMINAL_SNAPSHOT } from "../terminal/terminalTypes";
import {
    resetAgentSidebarStore,
    useAgentSidebarStore,
} from "./store/agentSidebarStore";
import { resetChatStore, useChatStore } from "./store/chatStore";
import type { AIChatSession, AIChatSessionStatus } from "./types";
import {
    AGENT_SIDEBAR_DRAG_EVENT,
    type AgentSidebarDragDetail,
} from "./agentSidebarDragEvents";
import { CLAUDE_TERMINAL_RUNTIME_ID } from "./utils/runtimeMetadata";

const chatPaneMovementMock = vi.hoisted(() => ({
    createNewChatInWorkspace: vi.fn(),
    openChatHistoryInWorkspace: vi.fn(),
    openChatSessionInWorkspace: vi.fn(),
}));
const claudeCodeTerminalMock = vi.hoisted(() => ({
    openClaudeCodeTerminalWithContext: vi.fn(async () => undefined),
}));

vi.mock("./chatPaneMovement", () => chatPaneMovementMock);
vi.mock("../terminal/claudeCodeTerminal", () => claudeCodeTerminalMock);

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

function firePointer(
    target: Element | Window,
    type: string,
    init: {
        button?: number;
        buttons?: number;
        clientX: number;
        clientY: number;
        pointerId: number;
    },
) {
    const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: init.button ?? 0,
        buttons: init.buttons ?? 0,
        clientX: init.clientX,
        clientY: init.clientY,
    });
    Object.defineProperty(event, "pointerId", { value: init.pointerId });
    fireEvent(target, event);
}

describe("AgentsSidebarPanel", () => {
    beforeEach(() => {
        resetChatStore();
        resetTerminalRuntimeStoreForTests();
        vi.clearAllMocks();
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
            entries: [],
        });
        resetAgentSidebarStore();
        useAgentSidebarStore.getState().setVaultPath("/vault");
        useEditorStore.getState().hydrateTabs([], null);
        useSettingsStore.setState({ claudeCodeEnabled: false });
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
            sessionInventoryLoaded: true,
        });
    });


    it("creates a canonical agent directly when Claude Code is disabled", async () => {
        renderComponent(<AgentsSidebarPanel />);

        fireEvent.click(screen.getByRole("button", { name: "New agent" }));

        await waitFor(() => {
            expect(
                chatPaneMovementMock.createNewChatInWorkspace,
            ).toHaveBeenCalledTimes(1);
        });
        expect(
            chatPaneMovementMock.createNewChatInWorkspace,
        ).toHaveBeenCalledWith();
        expect(screen.queryByRole("button", { name: "Claude" })).toBeNull();
    });




    it("opens Claude Code from the plus menu as a terminal runtime", async () => {
        useSettingsStore.setState({ claudeCodeEnabled: true });
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
                        id: "claude-code-terminal",
                        name: "Claude Code",
                        description: "",
                        capabilities: [],
                    },
                    models: [],
                    modes: [],
                    configOptions: [],
                },
            ],
            selectedRuntimeId: "codex-acp",
            setupStatusByRuntimeId: {
                [CLAUDE_TERMINAL_RUNTIME_ID]: {
                    runtimeId: CLAUDE_TERMINAL_RUNTIME_ID,
                    binaryReady: true,
                    binarySource: "env",
                    authReady: true,
                    onboardingRequired: false,
                    authMethods: [],
                },
            },
        });

        renderComponent(<AgentsSidebarPanel />);

        fireEvent.click(screen.getByRole("button", { name: "New agent" }));
        expect(
            await screen.findByRole("button", { name: "New Agent" }),
        ).toBeInTheDocument();
        fireEvent.click(
            await screen.findByRole("button", { name: "Claude Code" }),
        );

        await waitFor(() => {
            expect(
                claudeCodeTerminalMock.openClaudeCodeTerminalWithContext,
            ).toHaveBeenCalledTimes(1);
        });
        expect(
            chatPaneMovementMock.createNewChatInWorkspace,
        ).not.toHaveBeenCalled();
        expect(useChatStore.getState().selectedRuntimeId).toBe("codex-acp");
    });

    it("keeps canonical order when agent working states change", async () => {
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
                .getAllByTestId("agent-sidebar-item")
                .map((item) => item.textContent ?? "");
            expect(labels[0]).toContain("Beta task");
            expect(labels[1]).toContain("Alpha task");
        });
    });

    it("renders the T3-style card contract without project chrome", () => {
        const startedAt = Date.now() - 3 * 60_000;
        const working = createSession(
            "session-working",
            "Draft the chapter",
            "streaming",
            startedAt,
            {
                activeWorkCycleId: "cycle-1",
                messages: [
                    {
                        id: "working-message",
                        role: "user",
                        kind: "text",
                        content: "Draft the chapter",
                        timestamp: startedAt,
                        workCycleId: "cycle-1",
                    },
                ],
            },
        );
        useChatStore.setState((state) => ({
            ...state,
            sessionsById: { [working.sessionId]: working },
            sessionOrder: [working.sessionId],
        }));

        renderComponent(<AgentsSidebarPanel />);

        const card = screen.getByTestId("agent-sidebar-item");
        expect(card).toHaveStyle({ minHeight: "78px", borderRadius: "7px" });
        expect(card.querySelector('[data-agent-status="working"]')).toHaveTextContent(
            "Working 3m",
        );
        expect(card.children[1]).toHaveTextContent("Draft the chapter");
        expect(card.children[2].querySelector("svg")).not.toBeNull();
        expect(card).not.toHaveTextContent("/vault");
        expect(card).not.toHaveTextContent("main");
        expect(screen.queryByText("Open")).toBeNull();
    });

    it("keeps approval, input, review, and failure distinct", () => {
        const sessions = [
            createSession("review", "Review item", "review_required", 4),
            createSession("approval", "Approval item", "waiting_permission", 3),
            createSession("input", "Input item", "waiting_user_input", 2),
            createSession("failed", "Failed item", "error", 1),
        ];
        useChatStore.setState((state) => ({
            ...state,
            sessionsById: Object.fromEntries(
                sessions.map((item) => [item.sessionId, item]),
            ),
            sessionOrder: sessions.map((item) => item.sessionId),
        }));

        renderComponent(<AgentsSidebarPanel />);

        expect(screen.getByText("Review")).toBeInTheDocument();
        expect(screen.getByText("Approval")).toBeInTheDocument();
        expect(screen.getByText("Input")).toBeInTheDocument();
        expect(screen.getByText("Failed")).toBeInTheDocument();
    });

    it("completes and reopens a focused thread without changing its tab", async () => {
        const session = createSession("session-complete", "Complete me");
        useChatStore.setState((state) => ({
            ...state,
            sessionsById: { [session.sessionId]: session },
            sessionOrder: [session.sessionId],
        }));
        useEditorStore.getState().openChat(session.sessionId, {
            title: "Complete me",
            paneId: "primary",
        });
        renderComponent(<AgentsSidebarPanel />);

        fireEvent.click(screen.getByRole("button", { name: "Complete" }));

        await waitFor(() => {
            expect(
                useAgentSidebarStore.getState().sessionMetadata[session.sessionId]
                    ?.completedAt,
            ).toEqual(expect.any(Number));
        });
        expect(screen.getByText("Completed")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Reopen" })).toBeInTheDocument();
        expect(useEditorStore.getState().tabs).toHaveLength(1);

        fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
        await waitFor(() => {
            expect(
                useAgentSidebarStore.getState().sessionMetadata[session.sessionId]
                    ?.completedAt,
            ).toBeNull();
        });
        expect(useEditorStore.getState().tabs).toHaveLength(1);
    });

    it("does not offer Complete while work needs attention", () => {
        const session = createSession(
            "session-review",
            "Review pending",
            "review_required",
        );
        useChatStore.setState((state) => ({
            ...state,
            sessionsById: { [session.sessionId]: session },
            sessionOrder: [session.sessionId],
        }));
        renderComponent(<AgentsSidebarPanel />);
        expect(screen.queryByRole("button", { name: "Complete" })).toBeNull();
    });

    it("snoozes and wakes an active thread", async () => {
        const session = createSession("session-snooze", "Snooze me");
        useChatStore.setState((state) => ({
            ...state,
            sessionsById: { [session.sessionId]: session },
            sessionOrder: [session.sessionId],
        }));
        renderComponent(<AgentsSidebarPanel />);

        fireEvent.click(screen.getByRole("button", { name: "Snooze" }));

        await waitFor(() => {
            expect(
                useAgentSidebarStore.getState().sessionMetadata[session.sessionId]
                    ?.snoozedUntil,
            ).toEqual(expect.any(Number));
        });
        expect(screen.getByText("Snoozed")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: /Snoozed/ }));
        fireEvent.click(screen.getByRole("button", { name: "Wake now" }));
        await waitFor(() => {
            expect(
                useAgentSidebarStore.getState().sessionMetadata[session.sessionId]
                    ?.snoozedUntil,
            ).toBeNull();
        });
    });

    it("reorders pinned cards with the keyboard and announces the move", async () => {
        const first = createSession("first", "First", "idle", 300);
        const second = createSession("second", "Second", "idle", 200);
        const third = createSession("third", "Third", "idle", 100);
        useChatStore.setState((state) => ({
            ...state,
            sessionsById: { first, second, third },
            sessionOrder: ["first", "second", "third"],
        }));
        useAgentSidebarStore
            .getState()
            .migrateLegacyMetadata(["first", "second", "third"]);
        useAgentSidebarStore.getState().pinSession("first", 1);
        useAgentSidebarStore.getState().pinSession("second", 2);
        useAgentSidebarStore.getState().pinSession("third", 3);
        renderComponent(<AgentsSidebarPanel />);

        const firstRow = document.querySelector<HTMLElement>(
            '[data-agent-session-id="first"]',
        )!;
        fireEvent.keyDown(firstRow, { key: " " });
        fireEvent.keyDown(firstRow, { key: "ArrowDown" });
        fireEvent.keyDown(firstRow, { key: " " });

        await waitFor(() => {
            const labels = screen
                .getAllByTestId("agent-sidebar-item")
                .map((item) => item.getAttribute("data-agent-session-id"));
            expect(labels).toEqual(["second", "first", "third"]);
        });
        expect(screen.getByText("Agent position saved.")).toBeInTheDocument();
        expect(useAgentSidebarStore.getState().pinnedOrder).toEqual([
            "second",
            "first",
            "third",
        ]);
    });

    it("reorders pinned cards by pointer", async () => {
        const first = createSession("first", "First", "idle", 200);
        const second = createSession("second", "Second", "idle", 100);
        useChatStore.setState((state) => ({
            ...state,
            sessionsById: { first, second },
            sessionOrder: ["first", "second"],
        }));
        useAgentSidebarStore
            .getState()
            .migrateLegacyMetadata(["first", "second"]);
        useAgentSidebarStore.getState().pinSession("first", 1);
        useAgentSidebarStore.getState().pinSession("second", 2);
        renderComponent(<AgentsSidebarPanel />);
        const source = document.querySelector<HTMLElement>(
            '[data-agent-session-id="first"]',
        )!;
        const target = document.querySelector<HTMLElement>(
            '[data-agent-session-id="second"]',
        )!;
        Object.defineProperty(document, "elementFromPoint", {
            configurable: true,
            value: vi.fn(() => target),
        });
        vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
            x: 0,
            y: 100,
            top: 100,
            left: 0,
            right: 200,
            bottom: 180,
            width: 200,
            height: 80,
            toJSON: () => ({}),
        });

        firePointer(source, "pointerdown", {
            pointerId: 91,
            buttons: 1,
            clientX: 10,
            clientY: 10,
        });
        firePointer(window, "pointermove", {
            pointerId: 91,
            buttons: 1,
            clientX: 10,
            clientY: 170,
        });
        firePointer(window, "pointerup", {
            pointerId: 91,
            buttons: 0,
            clientX: 10,
            clientY: 170,
        });

        await waitFor(() => {
            expect(useAgentSidebarStore.getState().pinnedOrder).toEqual([
                "second",
                "first",
            ]);
        });
        delete (document as Partial<Document>).elementFromPoint;
    });

    it("cancels a keyboard reorder with Escape", async () => {
        const first = createSession("first", "First", "idle", 200);
        const second = createSession("second", "Second", "idle", 100);
        useChatStore.setState((state) => ({
            ...state,
            sessionsById: { first, second },
            sessionOrder: ["first", "second"],
        }));
        useAgentSidebarStore
            .getState()
            .migrateLegacyMetadata(["first", "second"]);
        useAgentSidebarStore.getState().pinSession("first", 1);
        useAgentSidebarStore.getState().pinSession("second", 2);
        renderComponent(<AgentsSidebarPanel />);
        const row = document.querySelector<HTMLElement>(
            '[data-agent-session-id="first"]',
        )!;
        fireEvent.keyDown(row, { key: " " });
        await screen.findByText("Picked up agent 1 of 2.");
        fireEvent.keyDown(row, { key: "ArrowDown" });
        fireEvent.keyDown(row, { key: "Escape" });

        await waitFor(() => {
            expect(useAgentSidebarStore.getState().pinnedOrder).toEqual([
                "first",
                "second",
            ]);
        });
        expect(screen.getByText("Agent move cancelled.")).toBeInTheDocument();
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
            .getAllByTestId("agent-sidebar-item")
            .map((item) => item.textContent ?? "");
        expect(labels[0]).toContain("Parent task");
        expect(labels[1]).toContain("Worker investigation");
        expect(labels[1]).toContain("Working");

        fireEvent.click(screen.getAllByTestId("agent-sidebar-item")[1]);

        await waitFor(() => {
            expect(
                chatPaneMovementMock.openChatSessionInWorkspace,
            ).toHaveBeenCalledWith("session-child");
        });
    });

    it("opens a thread from the keyboard", async () => {
        const session = createSession("session-alpha", "Alpha task");
        useChatStore.setState((state) => ({
            ...state,
            sessionsById: { [session.sessionId]: session },
            sessionOrder: [session.sessionId],
        }));

        renderComponent(<AgentsSidebarPanel />);

        fireEvent.keyDown(screen.getByTestId("agent-sidebar-item"), {
            key: "Enter",
        });

        await waitFor(() => {
            expect(
                chatPaneMovementMock.openChatSessionInWorkspace,
            ).toHaveBeenCalledWith(session.sessionId);
        });
    });

    it("does not open a thread from a nested row control", () => {
        const session = createSession("session-alpha", "Alpha task");
        useChatStore.setState((state) => ({
            ...state,
            sessionsById: { [session.sessionId]: session },
            sessionOrder: [session.sessionId],
        }));

        renderComponent(<AgentsSidebarPanel />);

        fireEvent.keyDown(
            screen.getByRole("button", { name: "Pin to sidebar" }),
            { key: "Enter" },
        );

        expect(
            chatPaneMovementMock.openChatSessionInWorkspace,
        ).not.toHaveBeenCalled();
    });



    it("completes an agent row drag when pointerup is received on window", () => {
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

            const row = screen.getByTestId("agent-sidebar-item");
            firePointer(row, "pointerdown", {
                button: 0,
                buttons: 1,
                pointerId: 1,
                clientX: 10,
                clientY: 10,
            });
            firePointer(window, "pointermove", {
                pointerId: 1,
                buttons: 1,
                clientX: 20,
                clientY: 10,
            });
            expect(
                screen.getByTestId("agent-sidebar-drag-preview"),
            ).toBeInTheDocument();
            firePointer(window, "pointerup", {
                pointerId: 1,
                clientX: 24,
                clientY: 12,
            });
            expect(
                screen.queryByTestId("agent-sidebar-drag-preview"),
            ).toBeNull();

            expect(dragEvents.map((event) => event.phase)).toEqual([
                "start",
                "move",
                "end",
            ]);
            expect(dragEvents[2]).toMatchObject({
                x: 24,
                y: 12,
            });
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

    it("cancels an active agent row drag when pointercancel is received on window", () => {
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

            const row = screen.getByTestId("agent-sidebar-item");
            firePointer(row, "pointerdown", {
                button: 0,
                buttons: 1,
                pointerId: 2,
                clientX: 10,
                clientY: 10,
            });
            firePointer(window, "pointermove", {
                pointerId: 2,
                buttons: 1,
                clientX: 20,
                clientY: 10,
            });
            expect(
                screen.getByTestId("agent-sidebar-drag-preview"),
            ).toBeInTheDocument();

            firePointer(window, "pointercancel", {
                pointerId: 2,
                clientX: 20,
                clientY: 10,
            });

            expect(
                screen.queryByTestId("agent-sidebar-drag-preview"),
            ).toBeNull();
            expect(dragEvents.map((event) => event.phase)).toEqual([
                "start",
                "move",
                "cancel",
            ]);
        } finally {
            window.removeEventListener(AGENT_SIDEBAR_DRAG_EVENT, handleDrag);
        }
    });

    it("completes an active agent row drag when movement reports the button was released", () => {
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

            const row = screen.getByTestId("agent-sidebar-item");
            firePointer(row, "pointerdown", {
                button: 0,
                buttons: 1,
                pointerId: 4,
                clientX: 10,
                clientY: 10,
            });
            firePointer(window, "pointermove", {
                pointerId: 4,
                buttons: 1,
                clientX: 20,
                clientY: 10,
            });
            firePointer(window, "pointermove", {
                pointerId: 4,
                buttons: 0,
                clientX: 28,
                clientY: 12,
            });

            expect(
                screen.queryByTestId("agent-sidebar-drag-preview"),
            ).toBeNull();
            expect(dragEvents.map((event) => event.phase)).toEqual([
                "start",
                "move",
                "end",
            ]);
            expect(dragEvents[2]).toMatchObject({
                x: 28,
                y: 12,
            });
        } finally {
            window.removeEventListener(AGENT_SIDEBAR_DRAG_EVENT, handleDrag);
        }
    });

    it("cancels an active agent row drag when the sidebar unmounts", () => {
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
            const { unmount } = renderComponent(<AgentsSidebarPanel />);

            const row = screen.getByTestId("agent-sidebar-item");
            firePointer(row, "pointerdown", {
                button: 0,
                buttons: 1,
                pointerId: 3,
                clientX: 10,
                clientY: 10,
            });
            firePointer(window, "pointermove", {
                pointerId: 3,
                buttons: 1,
                clientX: 20,
                clientY: 10,
            });
            expect(
                screen.getByTestId("agent-sidebar-drag-preview"),
            ).toBeInTheDocument();

            unmount();

            expect(
                dragEvents.map((event) => event.phase),
            ).toContain("cancel");
            expect(
                screen.queryByTestId("agent-sidebar-drag-preview"),
            ).toBeNull();
        } finally {
            window.removeEventListener(AGENT_SIDEBAR_DRAG_EVENT, handleDrag);
        }
    });

    it("keeps working subagents in canonical creation order", async () => {
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
                .getAllByTestId("agent-sidebar-item")
                .map((item) => item.textContent ?? "");
            expect(labels[0]).toContain("Parent task");
            expect(labels[1]).toContain("Mill");
            expect(labels[2]).toContain("Heisenberg");
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
            .getAllByTestId("agent-sidebar-item")
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

        fireEvent.doubleClick(screen.getAllByTestId("agent-sidebar-item")[1]);

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

        fireEvent.contextMenu(screen.getAllByTestId("agent-sidebar-item")[0]);
        fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

        await waitFor(() => {
            expect(confirm).toHaveBeenCalledWith(
                'Delete "Parent task"?',
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

        fireEvent.contextMenu(screen.getByTestId("agent-sidebar-item"));
        fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

        await waitFor(() => {
            expect(confirm).toHaveBeenCalledTimes(1);
        });
        expect(deleteSession).not.toHaveBeenCalled();
    });

    it("opens a thread in a new tab from the context menu", async () => {
        const session = createSession("session-alpha", "Alpha task");
        useChatStore.setState((state) => ({
            ...state,
            sessionsById: { [session.sessionId]: session },
            sessionOrder: [session.sessionId],
        }));

        renderComponent(<AgentsSidebarPanel />);

        fireEvent.contextMenu(screen.getByTestId("agent-sidebar-item"));
        fireEvent.click(
            await screen.findByRole("button", { name: "Open in New Tab" }),
        );

        await waitFor(() => {
            expect(
                chatPaneMovementMock.openChatSessionInWorkspace,
            ).toHaveBeenCalledWith(session.sessionId, { forceNewTab: true });
        });
    });

    it("closes a Claude Code terminal agent instead of deleting it", async () => {
        const session = createSession(
            "claude-terminal:term-1",
            "Claude Code 1",
            "idle",
            10,
            {
                runtimeId: CLAUDE_TERMINAL_RUNTIME_ID,
                terminalId: "term-1",
                persistedTitle: "Claude Code 1",
                messages: [],
            },
        );
        const deleteSession = vi.fn().mockResolvedValue(undefined);

        useChatStore.setState((state) => ({
            ...state,
            sessionsById: {
                [session.sessionId]: session,
            },
            sessionOrder: [session.sessionId],
            deleteSession,
        }));
        useEditorStore.getState().hydrateTabs(
            [
                {
                    id: "term-tab-1",
                    kind: "terminal",
                    terminalId: "term-1",
                    title: "Claude Code 1",
                    cwd: "/vault",
                },
            ],
            "term-tab-1",
        );
        useTerminalRuntimeStore.setState({
            runtimesById: {
                "term-1": {
                    terminalId: "term-1",
                    tabId: "term-tab-1",
                    sessionId: null,
                    snapshot: {
                        ...EMPTY_TERMINAL_SNAPSHOT,
                        status: "running",
                    },
                    hasOutput: false,
                    busy: false,
                    launchError: null,
                } satisfies WorkspaceTerminalRuntime,
            },
        });

        renderComponent(<AgentsSidebarPanel />);

        fireEvent.contextMenu(screen.getByTestId("agent-sidebar-item"));
        expect(
            await screen.findByRole("button", { name: "Close Terminal" }),
        ).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Close Terminal" }));

        await waitFor(() => {
            expect(confirm).toHaveBeenCalledWith(
                expect.stringContaining("Close terminal \"Claude Code 1\"?"),
                expect.objectContaining({ title: "Close terminal?" }),
            );
        });
        await waitFor(() => {
            expect(
                useTerminalRuntimeStore.getState().runtimesById["term-1"],
            ).toBeUndefined();
        });
        expect(useEditorStore.getState().tabs).toHaveLength(0);
        expect(deleteSession).not.toHaveBeenCalled();
    });
});
