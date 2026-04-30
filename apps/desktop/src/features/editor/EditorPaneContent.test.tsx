import { act, screen } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../app/store/editorStore";
import type { TerminalSessionSnapshot } from "../devtools/terminal/terminalTypes";
import {
    getXtermMockInstances,
    flushPromises,
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

function getEditorView() {
    const editorElement = document.querySelector(".cm-editor");
    expect(editorElement).not.toBeNull();

    const view = EditorView.findFromDOM(editorElement as HTMLElement);
    expect(view).not.toBeNull();
    return view!;
}

async function flushEditorViewUpdates() {
    await flushPromises();
    await act(async () => {
        vi.runOnlyPendingTimers();
    });
    await flushPromises();
}

describe("EditorPaneContent", () => {
    beforeEach(() => {
        resetTerminalRuntimeStoreForTests();
    });

    afterEach(() => {
        resetTerminalRuntimeStoreForTests();
        vi.restoreAllMocks();
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
        expect(screen.queryByText(/open a note/i)).not.toBeInTheDocument();
    });

    it("renders the top-level active terminal even when the focused pane is empty", () => {
        useEditorStore.getState().hydrateWorkspace(
            [
                {
                    id: "primary",
                    tabs: [],
                    activeTabId: null,
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
        useEditorStore.setState({ activeTabId: "terminal-tab-1" });
        seedTerminalRuntime("terminal-1", "terminal ready\n");

        renderComponent(<EditorPaneContent />);

        const terminal = screen.getByTestId("workspace-terminal-view");
        expect(terminal).toHaveAttribute("data-terminal-active", "true");
        expect(screen.queryByText(/this pane is empty/i)).not.toBeInTheDocument();
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

    it("keeps note scroll position when switching to an agent tab and back", async () => {
        vi.useFakeTimers();
        vi.spyOn(EditorView.prototype, "posAtCoords").mockReturnValue(12);
        vi.spyOn(EditorView.prototype, "coordsAtPos").mockReturnValue(null);

        setEditorTabs(
            [
                {
                    id: "note-tab-1",
                    kind: "note",
                    noteId: "note-1",
                    title: "Note",
                    content: "Line 1\nLine 2\nLine 3",
                },
                {
                    id: "chat-tab-1",
                    kind: "ai-chat",
                    sessionId: "session-1",
                    title: "Agent",
                },
            ],
            "note-tab-1",
        );

        renderComponent(<EditorPaneContent />);
        await flushEditorViewUpdates();

        let view = getEditorView();
        view.scrollDOM.scrollTop = 360;
        view.scrollDOM.scrollLeft = 18;

        act(() => {
            useEditorStore.getState().switchTab("chat-tab-1");
        });
        await flushEditorViewUpdates();
        expect(document.querySelector(".cm-editor")).not.toBeNull();

        act(() => {
            useEditorStore.getState().switchTab("note-tab-1");
        });
        await flushEditorViewUpdates();

        view = getEditorView();
        expect(view.scrollDOM.scrollTop).toBe(360);
        expect(view.scrollDOM.scrollLeft).toBe(18);
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

        renderComponent(
            <EditorPaneContent
                paneId="secondary"
                emptyStateMessage="This pane is empty. Open a note here or close the pane from its menu."
            />,
        );
        expect(getXtermMockInstances()).toHaveLength(1);
        expect(
            screen.queryByText(/this pane is empty/i),
        ).not.toBeInTheDocument();

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
