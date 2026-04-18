import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../app/store/editorStore";
import { useLayoutStore } from "../../app/store/layoutStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { renderComponent } from "../../test/test-utils";
import { AIChatPanel } from "./AIChatPanel";
import { resetChatStore, useChatStore } from "./store/chatStore";

function createSession(sessionId: string, title: string, runtimeId = "codex") {
    return {
        sessionId,
        historySessionId: sessionId,
        status: "idle" as const,
        runtimeId,
        modelId: "model-1",
        modeId: "default",
        models: [],
        modes: [],
        configOptions: [],
        messages: [
            {
                id: `${sessionId}:user`,
                role: "user" as const,
                kind: "text" as const,
                content: title,
                timestamp: 1,
            },
        ],
        attachments: [],
        activeWorkCycleId: null,
        visibleWorkCycleId: null,
        runtimeState: "live" as const,
    };
}

describe("AIChatPanel", () => {
    beforeEach(() => {
        resetChatStore();
        useVaultStore.setState({ vaultPath: "/vault", notes: [], entries: [] });
        useLayoutStore.setState({
            rightPanelExpanded: false,
            rightPanelCollapsed: false,
            rightPanelView: "chat",
        });
        useEditorStore.setState({
            tabs: [],
            activeTabId: null,
        });
    });

    it("opens a selected session as a workspace chat tab", async () => {
        const sessionA = createSession("session-a", "First conversation");
        const sessionB = createSession("session-b", "Second conversation");

        useChatStore.setState((state) => ({
            ...state,
            runtimes: [
                {
                    runtime: {
                        id: "codex",
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
                "session-a": sessionA,
                "session-b": sessionB,
            },
            sessionOrder: ["session-a", "session-b"],
        }));

        renderComponent(<AIChatPanel />);

        fireEvent.click(
            screen.getByRole("button", { name: /First conversation/ }),
        );

        await waitFor(() => {
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

    it("creates a new workspace chat from the sidebar launcher", async () => {
        type NewSessionFn = ReturnType<typeof useChatStore.getState>["newSession"];
        const newSession = vi.fn<NewSessionFn>(
            async (_runtimeId, _provisionalSessionId) => {
            useChatStore.setState((state) => ({
                ...state,
                activeSessionId: "session-new",
                sessionsById: {
                    ...state.sessionsById,
                    "session-new": createSession("session-new", "New chat"),
                },
                sessionOrder: ["session-new", ...state.sessionOrder],
            }));
                return "session-new";
            },
        );

        useChatStore.setState((state) => ({
            ...state,
            newSession,
            selectedRuntimeId: "codex",
            runtimes: [
                {
                    runtime: {
                        id: "codex",
                        name: "Codex ACP",
                        description: "",
                        capabilities: [],
                    },
                    models: [],
                    modes: [],
                    configOptions: [],
                },
            ],
        }));

        renderComponent(<AIChatPanel />);

        fireEvent.click(screen.getByRole("button", { name: "New" }));
        fireEvent.click(screen.getByRole("button", { name: "Codex" }));

        await waitFor(() => {
            const pendingSessionCall = newSession.mock.calls[0];
            expect(pendingSessionCall).toBeDefined();
            const [runtimeId, pendingSessionId] = pendingSessionCall!;
            expect(runtimeId).toBe("codex");
            expect(pendingSessionId).toMatch(/^pending:/);
            expect(
                useEditorStore
                    .getState()
                    .tabs.some(
                        (tab) =>
                            tab.kind === "ai-chat" &&
                            tab.sessionId === pendingSessionId,
                    ),
            ).toBe(true);
        });
    });

    it("shows the focused workspace chat as contextual sidebar state", () => {
        useChatStore.setState((state) => ({
            ...state,
            sessionsById: {
                "session-a": createSession("session-a", "Workspace chat"),
            },
            sessionOrder: ["session-a"],
            activeSessionId: "session-a",
        }));
        useEditorStore.getState().openChat("session-a", {
            title: "Workspace chat",
        });

        renderComponent(<AIChatPanel />);

        expect(screen.queryByText("Focused Workspace Chat")).toBeNull();
        expect(screen.getByText("Workspace chat")).toBeInTheDocument();
        expect(
            screen.queryByRole("textbox", { name: /message composer/i }),
        ).not.toBeInTheDocument();
    });

    it("restores the selected history session into the workspace", async () => {
        const sessionA = createSession("session-a", "Saved conversation");
        const loadSession = vi.fn().mockResolvedValue(undefined);

        useChatStore.setState((state) => ({
            ...state,
            loadSession,
            historyViewOpen: true,
            historySelectedSessionId: "session-a",
            runtimes: [
                {
                    runtime: {
                        id: "codex",
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
                "session-a": sessionA,
            },
            sessionOrder: ["session-a"],
        }));

        renderComponent(<AIChatPanel />);

        fireEvent.click(screen.getByRole("button", { name: "Restore" }));

        await waitFor(() => {
            expect(loadSession).toHaveBeenCalledWith("session-a");
            expect(useChatStore.getState().historyViewOpen).toBe(false);
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
});
