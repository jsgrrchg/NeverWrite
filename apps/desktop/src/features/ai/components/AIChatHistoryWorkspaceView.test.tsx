import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../../app/store/editorStore";
import { renderComponent } from "../../../test/test-utils";
import { resetChatStore, useChatStore } from "../store/chatStore";
import { exportChatSessionToVaultNote } from "../chatExport";
import type { AIChatSession } from "../types";
import { AIChatHistoryWorkspaceView } from "./AIChatHistoryWorkspaceView";

vi.mock("../chatExport", () => ({
    exportChatSessionToVaultNote: vi.fn().mockResolvedValue({
        noteId: "exported-note",
        path: "/vault/exported-note.md",
        title: "Exported note",
        content: "# Exported",
    }),
}));

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
        vi.clearAllMocks();
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

    it("keeps rename, fork, delete, and export actions working inside the workspace tab", async () => {
        const session = createSession("session-a", "Saved conversation");
        const ensureSessionTranscriptLoaded = vi.fn().mockResolvedValue(true);
        const forkSession = vi.fn().mockResolvedValue(undefined);
        const deleteSession = vi.fn().mockResolvedValue(undefined);
        const renameSession = vi.fn();

        useChatStore.setState((state) => ({
            ...state,
            ensureSessionTranscriptLoaded,
            forkSession,
            deleteSession,
            renameSession,
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

        const cardTitle = screen.getAllByText("Saved conversation")[0];

        fireEvent.mouseEnter(cardTitle!);
        fireEvent.click(screen.getByTitle("Fork chat"));
        await waitFor(() => {
            expect(forkSession).toHaveBeenCalledWith("session-a");
        });

        fireEvent.click(screen.getAllByTitle("Export to note")[0]!);
        await waitFor(() => {
            expect(ensureSessionTranscriptLoaded).toHaveBeenCalledWith(
                "session-a",
                "full",
            );
            expect(exportChatSessionToVaultNote).toHaveBeenCalled();
        });

        fireEvent.doubleClick(cardTitle!);
        const renameInput = await screen.findByDisplayValue(
            "Saved conversation",
        );
        fireEvent.change(renameInput, { target: { value: "Renamed conversation" } });
        fireEvent.keyDown(renameInput, { key: "Enter" });
        await waitFor(() => {
            expect(renameSession).toHaveBeenCalledWith(
                "session-a",
                "Renamed conversation",
            );
        });

        fireEvent.click(screen.getByTitle("Delete chat"));
        fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
        await waitFor(() => {
            expect(deleteSession).toHaveBeenCalledWith("session-a");
        });
    });

    it("shows historical subagents under their parent and restores the selected child", async () => {
        const parent = createSession("parent-session", "Parent strategy", {
            persistedUpdatedAt: 20,
        });
        const child = createSession("child-session", "Child execution", {
            parentSessionId: parent.historySessionId,
            persistedUpdatedAt: 10,
        });
        const loadSession = vi.fn().mockResolvedValue(undefined);

        useChatStore.setState((state) => ({
            ...state,
            loadSession,
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
                [child.sessionId]: child,
                [parent.sessionId]: parent,
            },
            sessionOrder: [child.sessionId, parent.sessionId],
        }));

        renderComponent(<AIChatHistoryWorkspaceView />);

        const parentRowTitle = (await screen.findAllByText(
            "Parent strategy",
        ))[0]!;
        const childRowTitle = screen.getAllByText("Child execution")[0]!;
        expect(
            parentRowTitle.compareDocumentPosition(childRowTitle) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();

        fireEvent.click(childRowTitle);
        fireEvent.click(screen.getByRole("button", { name: "Restore" }));

        await waitFor(() => {
            expect(loadSession).toHaveBeenCalledWith("child-session");
        });
    });

    it("keeps parent context visible when history search matches only a subagent", async () => {
        const parent = createSession("parent-session", "Parent strategy", {
            persistedUpdatedAt: 20,
        });
        const child = createSession("child-session", "Galileo telemetry", {
            parentSessionId: parent.historySessionId,
            persistedUpdatedAt: 10,
        });

        useChatStore.setState((state) => ({
            ...state,
            runtimes: [],
            sessionsById: {
                [parent.sessionId]: parent,
                [child.sessionId]: child,
            },
            sessionOrder: [parent.sessionId, child.sessionId],
        }));

        renderComponent(<AIChatHistoryWorkspaceView />);

        fireEvent.change(screen.getByPlaceholderText("Search chats…"), {
            target: { value: "galileo" },
        });

        expect(await screen.findAllByText("Parent strategy")).not.toHaveLength(
            0,
        );
        expect(screen.getAllByText("Galileo telemetry")).not.toHaveLength(0);
    });

    it("does not start inline rename for historical subagents", async () => {
        const parent = createSession("parent-session", "Parent strategy", {
            persistedUpdatedAt: 20,
        });
        const child = createSession("child-session", "Child execution", {
            parentSessionId: parent.historySessionId,
            persistedUpdatedAt: 10,
        });
        const renameSession = vi.fn();

        useChatStore.setState((state) => ({
            ...state,
            renameSession,
            runtimes: [],
            sessionsById: {
                [parent.sessionId]: parent,
                [child.sessionId]: child,
            },
            sessionOrder: [parent.sessionId, child.sessionId],
        }));

        renderComponent(<AIChatHistoryWorkspaceView />);

        const childRowTitle = (await screen.findAllByText(
            "Child execution",
        ))[0]!;
        fireEvent.doubleClick(childRowTitle);

        expect(screen.queryByDisplayValue("Child execution")).toBeNull();
        expect(renameSession).not.toHaveBeenCalled();
    });
});
