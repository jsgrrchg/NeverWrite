import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../../app/store/editorStore";
import { useVaultStore } from "../../../app/store/vaultStore";
import { renderComponent } from "../../../test/test-utils";
import { resetChatStore, useChatStore } from "../store/chatStore";
import { aiMoveAllSessionHistories } from "../api";
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

vi.mock("../api", () => ({
    aiLoadSessionHistories: vi.fn().mockResolvedValue([]),
    aiMoveAllSessionHistories: vi.fn().mockResolvedValue({
        completed: true,
        from_scope: "vault",
        to_scope: "device",
        histories_moved: 0,
        histories_deduplicated: 0,
        conflicts: [],
        recovery_required: false,
    }),
}));

const aiMoveAllSessionHistoriesMock = vi.mocked(aiMoveAllSessionHistories);

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
        localStorage.clear();
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
            entries: [],
        });
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

    it("moves vault-only legacy histories to the device", async () => {
        useChatStore.setState({
            sessionsById: {},
            sessionOrder: [],
            aiStorageScope: "vault",
            aiHistoryRecovery: {
                status: "vault_only",
                vaultHistoryCount: 1,
                deviceHistoryCount: 0,
                conflictSessionIds: [],
                recoveryRequired: false,
            },
        });
        renderComponent(<AIChatHistoryWorkspaceView />);

        expect(await screen.findByText("AI chat history was found in this vault.")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Move all chats to device" }));

        await waitFor(() => {
            expect(aiMoveAllSessionHistoriesMock).toHaveBeenCalledWith({
                vaultPath: "/vault",
                fromScope: "vault",
                toScope: "device",
            });
        });
    });

    it("confirms vault-only legacy history without moving it", async () => {
        useChatStore.setState({
            sessionsById: {},
            sessionOrder: [],
            aiStorageScope: "vault",
            aiHistoryRecovery: {
                status: "vault_only",
                vaultHistoryCount: 1,
                deviceHistoryCount: 0,
                conflictSessionIds: [],
                recoveryRequired: false,
            },
        });
        renderComponent(<AIChatHistoryWorkspaceView />);
        fireEvent.click(screen.getByRole("button", { name: "Keep chats in vault" }));

        expect(aiMoveAllSessionHistoriesMock).not.toHaveBeenCalled();
        expect(useChatStore.getState().aiStorageScope).toBe("vault");
    });

    it("shows and can move a recovered device-only history", async () => {
        useChatStore.setState({
            sessionsById: {},
            sessionOrder: [],
            aiStorageScope: "device",
            aiHistoryRecovery: {
                status: "device_only",
                vaultHistoryCount: 0,
                deviceHistoryCount: 1,
                conflictSessionIds: [],
                recoveryRequired: false,
            },
        });
        renderComponent(<AIChatHistoryWorkspaceView />);

        expect(await screen.findByText("AI chat history was found on this device.")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Move all chats to vault" }));

        await waitFor(() => {
            expect(aiMoveAllSessionHistoriesMock).toHaveBeenCalledWith({
                vaultPath: "/vault",
                fromScope: "device",
                toScope: "vault",
            });
        });
    });

    it("lets the user select a canonical copy when legacy roots conflict", () => {
        useChatStore.setState({
            sessionsById: {},
            sessionOrder: [],
            aiStorageScope: "device",
            aiHistoryRecovery: {
                status: "required",
                vaultHistoryCount: 1,
                deviceHistoryCount: 1,
                conflictSessionIds: ["session-conflict"],
                recoveryRequired: false,
            },
        });
        renderComponent(<AIChatHistoryWorkspaceView />);

        expect(screen.getByText("AI chat history was found in both storage locations.")).toBeInTheDocument();
        expect(screen.getByText("Conflicting chats were left unchanged: session-conflict.")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Use vault copies" }));

        expect(useChatStore.getState().aiStorageScope).toBe("vault");
        expect(useChatStore.getState().aiHistoryRecovery.status).toBe("idle");
        expect(aiMoveAllSessionHistoriesMock).not.toHaveBeenCalled();
    });
});
