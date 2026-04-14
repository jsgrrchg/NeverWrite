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
        const newSession = vi.fn(async () => {
            useChatStore.setState((state) => ({
                ...state,
                activeSessionId: "session-new",
                sessionsById: {
                    ...state.sessionsById,
                    "session-new": createSession("session-new", "New chat"),
                },
                sessionOrder: ["session-new", ...state.sessionOrder],
            }));
        });

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

        fireEvent.click(screen.getByRole("button", { name: "New Chat" }));
        fireEvent.click(screen.getByRole("button", { name: "Codex" }));

        await waitFor(() => {
            expect(newSession).toHaveBeenCalledWith("codex");
            expect(
                useEditorStore
                    .getState()
                    .tabs.some(
                        (tab) =>
                            tab.kind === "ai-chat" &&
                            tab.sessionId === "session-new",
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

        expect(screen.getByText("Focused Workspace Chat")).toBeInTheDocument();
        expect(screen.getAllByText("Workspace chat")).toHaveLength(2);
        expect(
            screen.queryByRole("textbox", { name: /message composer/i }),
        ).not.toBeInTheDocument();
    });
});
