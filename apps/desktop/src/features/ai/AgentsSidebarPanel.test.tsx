import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { confirm } from "@neverwrite/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { renderComponent } from "../../test/test-utils";
import { AgentsSidebarPanel } from "./AgentsSidebarPanel";
import {
    resetTerminalRuntimeStoreForTests,
    useTerminalRuntimeStore,
    type WorkspaceTerminalRuntime,
} from "../terminal/terminalRuntimeStore";
import { EMPTY_TERMINAL_SNAPSHOT } from "../terminal/terminalTypes";
import { usePinnedChatsStore } from "./store/pinnedChatsStore";
import { useChatFoldersStore } from "./store/chatFoldersStore";
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
        usePinnedChatsStore.setState({ entries: {} });
        useChatFoldersStore.setState({
            folders: {},
            sessionFolderIds: {},
            collapsedFolderIds: [],
        });
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

    it("keeps existing chats unfiled until the user explicitly moves one", async () => {
        const session = createSession("session-alpha", "Alpha task", "idle", 100);
        useChatStore.setState((state) => ({
            ...state,
            sessionsById: { [session.sessionId]: session },
            sessionOrder: [session.sessionId],
        }));
        renderComponent(<AgentsSidebarPanel />);

        expect(screen.getByText("Alpha task")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "New folder" }));
        fireEvent.change(screen.getByRole("textbox", { name: "Folder name" }), {
            target: { value: "Research" },
        });
        fireEvent.blur(screen.getByRole("textbox", { name: "Folder name" }));
        expect(screen.getByText("Research")).toBeInTheDocument();
        expect(
            useChatFoldersStore.getState().sessionFolderIds,
        ).toEqual({});

        fireEvent.contextMenu(screen.getByTestId("agent-sidebar-item"), {
            clientX: 20,
            clientY: 20,
        });
        const moveToFolder = await screen.findByRole("button", {
            name: "Move to Folder",
        });
        fireEvent.mouseEnter(moveToFolder);
        fireEvent.click(await screen.findByRole("button", { name: "Research" }));

        await waitFor(() => {
            expect(
                useChatFoldersStore.getState().sessionFolderIds,
            ).toEqual({ "session-alpha": expect.any(String) });
        });
        expect(screen.getAllByText("Alpha task").length).toBeGreaterThan(0);
    });

    it("renames, collapses, and deletes a folder without losing its chat", async () => {
        const session = createSession("session-alpha", "Alpha task");
        const folderId = useChatFoldersStore
            .getState()
            .createFolder("Research");
        expect(folderId).toBeTruthy();
        useChatFoldersStore.getState().moveSession(session.sessionId, folderId);
        useChatStore.setState((state) => ({
            ...state,
            sessionsById: { [session.sessionId]: session },
            sessionOrder: [session.sessionId],
        }));

        renderComponent(<AgentsSidebarPanel />);

        fireEvent.click(screen.getByTitle("Collapse folder"));
        expect(screen.queryByTestId("agent-sidebar-item")).toBeNull();

        fireEvent.contextMenu(screen.getByTitle("Expand folder"));
        fireEvent.click(
            await screen.findByRole("button", { name: "Rename Folder" }),
        );
        const folderNameInput = await screen.findByRole("textbox", {
            name: "Folder name",
        });
        fireEvent.change(folderNameInput, {
            target: { value: "Archive" },
        });
        fireEvent.keyDown(folderNameInput, {
            key: "Enter",
        });
        expect(screen.getByText("Archive")).toBeInTheDocument();

        fireEvent.contextMenu(screen.getByTitle("Expand folder"));
        fireEvent.click(
            await screen.findByRole("button", { name: "Delete Folder" }),
        );

        await waitFor(() => {
            expect(useChatFoldersStore.getState().sessionFolderIds).toEqual({});
        });
        expect(screen.queryByText("Archive")).not.toBeInTheDocument();
        expect(screen.getByTestId("agent-sidebar-item")).toHaveTextContent(
            "Alpha task",
        );
    });

    it("opens Claude Code from the plus menu as a terminal runtime", async () => {
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
        });

        renderComponent(<AgentsSidebarPanel />);

        fireEvent.click(screen.getByRole("button", { name: "New chat" }));
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
        expect(useChatStore.getState().selectedRuntimeId).toBe(
            CLAUDE_TERMINAL_RUNTIME_ID,
        );
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
                .getAllByTestId("agent-sidebar-item")
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
            .getAllByTestId("agent-sidebar-item")
            .map((item) => item.textContent ?? "");
        expect(labels[0]).toContain("Parent task");
        expect(labels[1]).toContain("Worker investigation");
        expect(labels[1]).toContain("Working…");

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

    it("moves a root chat into a folder when it is dropped on that folder", () => {
        const alpha = createSession("session-alpha", "Alpha task");
        const folderId = useChatFoldersStore
            .getState()
            .createFolder("Research");
        expect(folderId).toBeTruthy();
        useChatStore.setState((state) => ({
            ...state,
            sessionsById: { [alpha.sessionId]: alpha },
            sessionOrder: [alpha.sessionId],
        }));
        const dragEvents: AgentSidebarDragDetail[] = [];
        const handleDrag = (event: Event) =>
            dragEvents.push(
                (event as CustomEvent<AgentSidebarDragDetail>).detail,
            );
        window.addEventListener(AGENT_SIDEBAR_DRAG_EVENT, handleDrag);

        try {
            renderComponent(<AgentsSidebarPanel />);
            const folderLabel = screen.getByText("Research");
            Object.defineProperty(document, "elementFromPoint", {
                configurable: true,
                value: vi.fn(() => folderLabel),
            });
            const row = screen.getByTestId("agent-sidebar-item");
            firePointer(row, "pointerdown", {
                button: 0,
                buttons: 1,
                pointerId: 9,
                clientX: 10,
                clientY: 10,
            });
            firePointer(window, "pointermove", {
                pointerId: 9,
                buttons: 1,
                clientX: 20,
                clientY: 10,
            });
            firePointer(window, "pointerup", {
                pointerId: 9,
                clientX: 20,
                clientY: 10,
            });

            expect(useChatFoldersStore.getState().sessionFolderIds).toEqual({
                [alpha.sessionId]: folderId,
            });
            expect(dragEvents.at(-1)?.phase).toBe("cancel");
        } finally {
            delete (document as Partial<Document>).elementFromPoint;
            window.removeEventListener(AGENT_SIDEBAR_DRAG_EVENT, handleDrag);
        }
    });

    it("removes a root chat from its folder when it is dropped on All", () => {
        const alpha = createSession("session-alpha", "Alpha task");
        const folderId = useChatFoldersStore
            .getState()
            .createFolder("Research");
        expect(folderId).toBeTruthy();
        useChatFoldersStore
            .getState()
            .moveSession(alpha.sessionId, folderId);
        useChatStore.setState((state) => ({
            ...state,
            sessionsById: { [alpha.sessionId]: alpha },
            sessionOrder: [alpha.sessionId],
        }));

        renderComponent(<AgentsSidebarPanel />);
        const allDropZone = document.querySelector(
            "[data-chat-unfiled-drop-zone]",
        );
        expect(allDropZone).not.toBeNull();
        Object.defineProperty(document, "elementFromPoint", {
            configurable: true,
            value: vi.fn(() => allDropZone),
        });

        try {
            const row = screen.getByTestId("agent-sidebar-item");
            firePointer(row, "pointerdown", {
                button: 0,
                buttons: 1,
                pointerId: 10,
                clientX: 10,
                clientY: 10,
            });
            firePointer(window, "pointermove", {
                pointerId: 10,
                buttons: 1,
                clientX: 20,
                clientY: 10,
            });
            firePointer(window, "pointerup", {
                pointerId: 10,
                clientX: 20,
                clientY: 10,
            });

            expect(useChatFoldersStore.getState().sessionFolderIds).toEqual({});
        } finally {
            delete (document as Partial<Document>).elementFromPoint;
        }
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
                .getAllByTestId("agent-sidebar-item")
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
