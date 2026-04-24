import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../app/store/editorStore";
import type { TerminalSessionSnapshot } from "../devtools/terminal/terminalTypes";
import {
    getXtermMockInstances,
    renderComponent,
    setEditorTabs,
} from "../../test/test-utils";
import {
    resetTerminalRuntimeStoreForTests,
    useTerminalRuntimeStore,
} from "../terminal/terminalRuntimeStore";
import { EditorPaneContent } from "./EditorPaneContent";

function makeSnapshot(
    overrides: Partial<TerminalSessionSnapshot> = {},
): TerminalSessionSnapshot {
    return {
        sessionId: "devterm-1",
        program: "/bin/zsh",
        status: "running",
        displayName: "zsh",
        cwd: "/vault",
        cols: 120,
        rows: 24,
        exitCode: null,
        errorMessage: null,
        ...overrides,
    };
}

function seedTerminalRuntime(terminalId: string, rawOutput = "ready\n") {
    useTerminalRuntimeStore.setState({
        runtimesById: {
            [terminalId]: {
                terminalId,
                tabId: `${terminalId}-tab`,
                sessionId: `session-${terminalId}`,
                snapshot: makeSnapshot({
                    sessionId: `session-${terminalId}`,
                }),
                rawOutput,
                busy: false,
                launchError: null,
            },
        },
    });
}

describe("EditorPaneContent", () => {
    beforeEach(() => {
        resetTerminalRuntimeStoreForTests();
    });

    afterEach(() => {
        resetTerminalRuntimeStoreForTests();
        vi.useRealTimers();
    });

    it("renders the workspace chat history view for history tabs", () => {
        setEditorTabs([
            {
                id: "history-tab-1",
                kind: "ai-chat-history",
                title: "History",
            },
        ]);

        renderComponent(<EditorPaneContent />);

        expect(
            screen.getByTestId("ai-chat-history-workspace-view"),
        ).toBeInTheDocument();
        expect(screen.getByText("Chat History")).toBeInTheDocument();
    });

    it("renders the workspace terminal view for an active terminal tab", () => {
        setEditorTabs([
            {
                id: "terminal-tab-1",
                kind: "terminal",
                terminalId: "terminal-1",
                title: "Terminal 1",
                cwd: "/vault",
            },
        ]);
        seedTerminalRuntime("terminal-1", "terminal ready\n");

        renderComponent(<EditorPaneContent />);

        const terminal = screen.getByTestId("workspace-terminal-view");
        expect(terminal).toHaveAttribute("data-terminal-active", "true");
        expect(screen.getByText(/terminal ready/i)).toBeInTheDocument();
    });

    it("keeps terminal tabs mounted but hidden when a non-terminal tab is active", () => {
        setEditorTabs(
            [
                {
                    id: "terminal-tab-1",
                    kind: "terminal",
                    terminalId: "terminal-1",
                    title: "Terminal 1",
                    cwd: "/vault",
                },
                {
                    id: "note-tab-1",
                    kind: "note",
                    noteId: "note-1",
                    title: "Note",
                    content: "Note body",
                },
            ],
            "terminal-tab-1",
        );
        seedTerminalRuntime("terminal-1", "kept runtime\n");

        renderComponent(<EditorPaneContent />);
        const terminal = screen.getByTestId("workspace-terminal-view");
        expect(terminal).toBeVisible();
        expect(getXtermMockInstances()).toHaveLength(1);

        act(() => {
            useEditorStore.getState().switchTab("note-tab-1");
        });

        expect(terminal).toHaveStyle({ visibility: "hidden" });
        expect(screen.getByText(/kept runtime/i)).toBeInTheDocument();
        expect(getXtermMockInstances()).toHaveLength(1);
    });

    it("requests terminal focus only when the tab and pane are both active", async () => {
        vi.useFakeTimers();
        useEditorStore.getState().hydrateWorkspace(
            [
                {
                    id: "primary",
                    tabs: [
                        {
                            id: "note-tab-1",
                            kind: "note",
                            noteId: "note-1",
                            title: "Note",
                            content: "Note body",
                        },
                    ],
                    activeTabId: "note-tab-1",
                },
                {
                    id: "secondary",
                    tabs: [
                        {
                            id: "terminal-tab-1",
                            kind: "terminal",
                            terminalId: "terminal-1",
                            title: "Terminal 1",
                            cwd: "/vault",
                        },
                    ],
                    activeTabId: "terminal-tab-1",
                },
            ],
            "primary",
        );
        seedTerminalRuntime("terminal-1", "focused later\n");

        renderComponent(<EditorPaneContent paneId="secondary" />);
        expect(getXtermMockInstances()).toHaveLength(1);

        await act(async () => {
            vi.runOnlyPendingTimers();
        });
        expect(getXtermMockInstances()[0]?.focusCalls).toBe(0);

        act(() => {
            useEditorStore.getState().focusPane("secondary");
        });
        await act(async () => {
            await Promise.resolve();
            vi.runOnlyPendingTimers();
        });

        expect(getXtermMockInstances()[0]?.focusCalls).toBeGreaterThan(0);
    });
});
