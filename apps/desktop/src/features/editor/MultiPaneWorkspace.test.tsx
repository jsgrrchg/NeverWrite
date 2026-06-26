import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import {
    flushPromises,
    getMockCurrentWebview,
    getMockCurrentWindow,
    mockInvoke,
    renderComponent,
    setVaultEntries,
} from "../../test/test-utils";
import { publishWindowTabDropZone } from "../../app/detachedWindows";
import { useEditorStore, type ChatTab } from "../../app/store/editorStore";
import { CLEAR_FILE_TREE_SELECTION_EVENT } from "../../app/utils/navigation";
import {
    createInitialLayout,
    splitPane,
} from "../../app/store/workspaceLayoutTree";
import { useVaultStore } from "../../app/store/vaultStore";
import { FILE_TREE_NOTE_DRAG_EVENT } from "../ai/dragEvents";
import {
    resetChatStore,
    useChatStore,
} from "../ai/store/chatStore";
import type { AIChatSession, AIChatSessionStatus } from "../ai/types";
import { MultiPaneWorkspace } from "./MultiPaneWorkspace";
import { CROSS_PANE_TAB_DROP_PREVIEW_EVENT } from "./workspaceTabDropPreview";

const innerPositionMock = vi.fn();
const scaleFactorMock = vi.fn();
const onDragDropEventMock = vi.fn();
const originalStopStreaming = useChatStore.getState().stopStreaming;

vi.mock("../../app/detachedWindows", () => ({
    getCurrentWindowLabel: vi.fn(() => "main"),
    publishWindowTabDropZone: vi.fn(),
}));

vi.mock("./EditorPaneBar", () => ({
    EditorPaneBar: ({
        paneId,
        isFocused,
    }: {
        paneId: string;
        isFocused: boolean;
    }) => (
        <div
            data-testid={`pane-bar-${paneId}`}
            data-focused={isFocused || undefined}
        >
            {paneId}
        </div>
    ),
}));

vi.mock("./EditorPaneContent", () => ({
    EditorPaneContent: ({
        paneId,
        emptyStateMessage,
    }: {
        paneId?: string;
        emptyStateMessage?: string;
    }) => (
        <div data-testid={`pane-content-${paneId ?? "focused"}`}>
            {paneId}
            {emptyStateMessage ? `:${emptyStateMessage}` : ""}
        </div>
    ),
}));

describe("MultiPaneWorkspace", () => {
    function createThreePaneLayout() {
        return splitPane(
            splitPane(
                createInitialLayout("primary"),
                "primary",
                "row",
                "secondary",
            ),
            "secondary",
            "column",
            "tertiary",
        );
    }

    function createChatTab(sessionId: string): ChatTab {
        return {
            id: `tab-${sessionId}`,
            kind: "ai-chat",
            sessionId,
            title: sessionId,
        };
    }

    function createChatSession(
        sessionId: string,
        status: AIChatSessionStatus,
    ): AIChatSession {
        return {
            sessionId,
            status,
        } as AIChatSession;
    }

    function setPaneChatSession(
        paneId: string,
        sessionId: string,
        status: AIChatSessionStatus,
    ) {
        const tab = createChatTab(sessionId);
        useEditorStore.setState((state) => ({
            panes: state.panes.map((pane) =>
                pane.id === paneId
                    ? {
                          ...pane,
                          tabs: [tab],
                          tabIds: [tab.id],
                          activeTabId: tab.id,
                      }
                    : pane,
            ),
        }));
        useChatStore.setState((state) => ({
            sessionsById: {
                ...state.sessionsById,
                [sessionId]: createChatSession(sessionId, status),
            },
            sessionOrder: [
                ...state.sessionOrder.filter((id) => id !== sessionId),
                sessionId,
            ],
        }));
    }

    function installStopStreamingMock() {
        const stopStreaming = vi.fn(async (_sessionId?: string) => {});
        useChatStore.setState({ stopStreaming });
        return stopStreaming;
    }

    beforeEach(() => {
        resetChatStore();
        useChatStore.setState({ stopStreaming: originalStopStreaming });
        const mockWindow = getMockCurrentWindow() as unknown as {
            innerPosition: typeof innerPositionMock;
            scaleFactor: typeof scaleFactorMock;
        };
        mockWindow.innerPosition = innerPositionMock;
        mockWindow.scaleFactor = scaleFactorMock;
        (
            getMockCurrentWebview() as {
                onDragDropEvent: typeof onDragDropEventMock;
            }
        ).onDragDropEvent = onDragDropEventMock;
        class MockResizeObserver {
            private readonly callback: ResizeObserverCallback;

            constructor(callback: ResizeObserverCallback) {
                this.callback = callback;
            }

            observe(target: Element) {
                this.callback(
                    [
                        {
                            target,
                            contentRect: {
                                width: 900,
                                height: 600,
                                x: 0,
                                y: 0,
                                top: 0,
                                left: 0,
                                right: 900,
                                bottom: 600,
                                toJSON: () => ({}),
                            },
                        } as ResizeObserverEntry,
                    ],
                    this,
                );
            }

            disconnect() {}

            unobserve() {}
        }

        Object.defineProperty(globalThis, "ResizeObserver", {
            configurable: true,
            value: MockResizeObserver,
        });
        onDragDropEventMock.mockReset();
        onDragDropEventMock.mockResolvedValue(vi.fn());
        Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
            configurable: true,
            value: vi.fn(),
        });
        Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
            configurable: true,
            value: () => ({
                width: 900,
                height: 600,
                x: 0,
                y: 0,
                top: 0,
                left: 0,
                right: 900,
                bottom: 600,
                toJSON: () => ({}),
            }),
        });

        const layoutTree = createThreePaneLayout();
        useEditorStore.setState({
            panes: [
                {
                    id: "primary",
                    tabs: [],
                    tabIds: [],
                    pinnedTabIds: [],
                    activeTabId: null,
                    activationHistory: [],
                    tabNavigationHistory: [],
                    tabNavigationIndex: -1,
                    tabDisplayMode: "default",
                },
                {
                    id: "secondary",
                    tabs: [],
                    tabIds: [],
                    pinnedTabIds: [],
                    activeTabId: null,
                    activationHistory: [],
                    tabNavigationHistory: [],
                    tabNavigationIndex: -1,
                    tabDisplayMode: "default",
                },
                {
                    id: "tertiary",
                    tabs: [],
                    tabIds: [],
                    pinnedTabIds: [],
                    activeTabId: null,
                    activationHistory: [],
                    tabNavigationHistory: [],
                    tabNavigationIndex: -1,
                    tabDisplayMode: "default",
                },
            ],
            focusedPaneId: "primary",
            layoutTree,
        });
        useVaultStore.setState((state) => ({
            ...state,
            vaultPath: "/vaults/main",
        }));
        Object.defineProperty(window, "screenX", {
            value: 900,
            configurable: true,
        });
        Object.defineProperty(window, "screenY", {
            value: 700,
            configurable: true,
        });
        scaleFactorMock.mockResolvedValue(2);
        innerPositionMock.mockResolvedValue({
            x: 240,
            y: 80,
            toLogical: () => ({
                x: 120,
                y: 40,
            }),
        });
        Object.defineProperty(document, "elementsFromPoint", {
            configurable: true,
            value: vi.fn(() => []),
        });
    });

    it("focuses the clicked pane", () => {
        renderComponent(<MultiPaneWorkspace />);

        const targetPane = screen
            .getByTestId("pane-content-secondary")
            .closest('[data-editor-pane-id="secondary"]');
        expect(targetPane).not.toBeNull();

        fireEvent.pointerDown(targetPane!, { pointerId: 1, button: 0 });

        expect(useEditorStore.getState().focusedPaneId).toBe("secondary");
    });

    it("requests file tree selection cleanup when a pane is clicked", () => {
        const events: Event[] = [];
        const handleClearSelection = (event: Event) => events.push(event);
        window.addEventListener(
            CLEAR_FILE_TREE_SELECTION_EVENT,
            handleClearSelection,
        );

        try {
            renderComponent(<MultiPaneWorkspace />);

            const targetPane = screen
                .getByTestId("pane-content-secondary")
                .closest('[data-editor-pane-id="secondary"]');
            expect(targetPane).not.toBeNull();

            fireEvent.pointerDown(targetPane!, { pointerId: 1, button: 0 });

            expect(events).toHaveLength(1);
        } finally {
            window.removeEventListener(
                CLEAR_FILE_TREE_SELECTION_EVENT,
                handleClearSelection,
            );
        }
    });

    it.each<AIChatSessionStatus>([
        "streaming",
        "waiting_permission",
        "waiting_user_input",
    ])("stops the focused chat when Escape is pressed in %s", (status) => {
        setPaneChatSession("primary", "session-primary", status);
        const stopStreaming = installStopStreamingMock();
        renderComponent(<MultiPaneWorkspace />);

        fireEvent.keyDown(window, { key: "Escape" });

        expect(stopStreaming).toHaveBeenCalledTimes(1);
        expect(stopStreaming).toHaveBeenCalledWith("session-primary");
    });

    it("does not stop a chat in another pane", () => {
        setPaneChatSession("primary", "session-primary", "streaming");
        setPaneChatSession("secondary", "session-secondary", "streaming");
        useEditorStore.setState({ focusedPaneId: "primary" });
        const stopStreaming = installStopStreamingMock();
        renderComponent(<MultiPaneWorkspace />);

        fireEvent.keyDown(window, { key: "Escape" });

        expect(stopStreaming).toHaveBeenCalledTimes(1);
        expect(stopStreaming).toHaveBeenCalledWith("session-primary");
        expect(stopStreaming).not.toHaveBeenCalledWith("session-secondary");
    });

    it("does not stop the focused chat when Escape was already prevented", () => {
        setPaneChatSession("primary", "session-primary", "streaming");
        const stopStreaming = installStopStreamingMock();
        renderComponent(<MultiPaneWorkspace />);
        const event = new KeyboardEvent("keydown", {
            key: "Escape",
            cancelable: true,
        });
        event.preventDefault();

        window.dispatchEvent(event);

        expect(stopStreaming).not.toHaveBeenCalled();
    });

    it.each([
        ["metaKey", { metaKey: true }],
        ["ctrlKey", { ctrlKey: true }],
        ["altKey", { altKey: true }],
        ["shiftKey", { shiftKey: true }],
    ])("does not stop the focused chat with %s", (_name, modifier) => {
        setPaneChatSession("primary", "session-primary", "streaming");
        const stopStreaming = installStopStreamingMock();
        renderComponent(<MultiPaneWorkspace />);

        fireEvent.keyDown(window, { key: "Escape", ...modifier });

        expect(stopStreaming).not.toHaveBeenCalled();
    });

    it.each<AIChatSessionStatus>(["idle", "review_required", "error"])(
        "does not stop a focused chat in %s",
        (status) => {
            setPaneChatSession("primary", "session-primary", status);
            const stopStreaming = installStopStreamingMock();
            renderComponent(<MultiPaneWorkspace />);

            fireEvent.keyDown(window, { key: "Escape" });

            expect(stopStreaming).not.toHaveBeenCalled();
        },
    );

    it("opens a dragged vault file in the pane under the pointer", async () => {
        setVaultEntries([
            {
                id: "docs/reference.txt",
                path: "/vault/docs/reference.txt",
                relative_path: "docs/reference.txt",
                title: "Reference",
                file_name: "reference.txt",
                extension: "txt",
                kind: "file",
                modified_at: 1,
                created_at: 1,
                size: 32,
                mime_type: "text/plain",
            },
        ]);
        mockInvoke().mockImplementation(async (command, args) => {
            if (
                command === "read_vault_file" &&
                (args as { relativePath?: string }).relativePath ===
                    "docs/reference.txt"
            ) {
                return {
                    relative_path: "docs/reference.txt",
                    path: "/vault/docs/reference.txt",
                    file_name: "reference.txt",
                    mime_type: "text/plain",
                    content: "reference",
                    size_bytes: 32,
                    content_truncated: false,
                };
            }

            return undefined;
        });

        renderComponent(<MultiPaneWorkspace />);
        await flushPromises();

        const primaryPane = screen
            .getByTestId("pane-content-primary")
            .closest('[data-editor-pane-id="primary"]') as HTMLElement | null;
        const secondaryPane = screen
            .getByTestId("pane-content-secondary")
            .closest('[data-editor-pane-id="secondary"]') as HTMLElement | null;
        expect(primaryPane).not.toBeNull();
        expect(secondaryPane).not.toBeNull();

        vi.spyOn(primaryPane!, "getBoundingClientRect").mockReturnValue({
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: 300,
            bottom: 300,
            width: 300,
            height: 300,
            toJSON: () => ({}),
        } as DOMRect);
        vi.spyOn(secondaryPane!, "getBoundingClientRect").mockReturnValue({
            x: 320,
            y: 0,
            left: 320,
            top: 0,
            right: 620,
            bottom: 300,
            width: 300,
            height: 300,
            toJSON: () => ({}),
        } as DOMRect);

        const dragDropListener = onDragDropEventMock.mock.calls.at(-1)?.[0] as
            | ((event: {
                  payload: {
                      type: "drop";
                      position: { x: number; y: number };
                      paths: string[];
                  };
              }) => void)
            | undefined;
        expect(dragDropListener).toBeTypeOf("function");

        await act(async () => {
            dragDropListener?.({
                payload: {
                    type: "drop",
                    position: { x: 460, y: 120 },
                    paths: ["/vault/docs/reference.txt"],
                },
            });
            await flushPromises();
        });

        const secondaryWorkspacePane = useEditorStore
            .getState()
            .panes.find((pane) => pane.id === "secondary");
        expect(secondaryWorkspacePane?.tabs).toHaveLength(1);
        expect(secondaryWorkspacePane?.tabs[0]).toMatchObject({
            kind: "file",
            relativePath: "docs/reference.txt",
            title: "reference.txt",
        });
        expect(useEditorStore.getState().focusedPaneId).toBe("secondary");
    });

    it("opens dragged Excalidraw vault files as map tabs", async () => {
        setVaultEntries([
            {
                id: "Excalidraw/Board.excalidraw",
                path: "/vault/Excalidraw/Board.excalidraw",
                relative_path: "Excalidraw/Board.excalidraw",
                title: "Board",
                file_name: "Board.excalidraw",
                extension: "excalidraw",
                kind: "file",
                modified_at: 1,
                created_at: 1,
                size: 2048,
                mime_type: "application/json",
            },
        ]);
        mockInvoke().mockImplementation(async (command) => {
            if (command === "read_vault_file") {
                throw new Error("Excalidraw drops should open as map tabs");
            }

            return undefined;
        });

        renderComponent(<MultiPaneWorkspace />);
        await flushPromises();

        const primaryPane = screen
            .getByTestId("pane-content-primary")
            .closest('[data-editor-pane-id="primary"]') as HTMLElement | null;
        const secondaryPane = screen
            .getByTestId("pane-content-secondary")
            .closest('[data-editor-pane-id="secondary"]') as HTMLElement | null;
        expect(primaryPane).not.toBeNull();
        expect(secondaryPane).not.toBeNull();

        vi.spyOn(primaryPane!, "getBoundingClientRect").mockReturnValue({
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: 300,
            bottom: 300,
            width: 300,
            height: 300,
            toJSON: () => ({}),
        } as DOMRect);
        vi.spyOn(secondaryPane!, "getBoundingClientRect").mockReturnValue({
            x: 320,
            y: 0,
            left: 320,
            top: 0,
            right: 620,
            bottom: 300,
            width: 300,
            height: 300,
            toJSON: () => ({}),
        } as DOMRect);

        const dragDropListener = onDragDropEventMock.mock.calls.at(-1)?.[0] as
            | ((event: {
                  payload: {
                      type: "drop";
                      position: { x: number; y: number };
                      paths: string[];
                  };
              }) => void)
            | undefined;
        expect(dragDropListener).toBeTypeOf("function");

        await act(async () => {
            dragDropListener?.({
                payload: {
                    type: "drop",
                    position: { x: 460, y: 120 },
                    paths: ["/vault/Excalidraw/Board.excalidraw"],
                },
            });
            await flushPromises();
        });

        const secondaryWorkspacePane = useEditorStore
            .getState()
            .panes.find((pane) => pane.id === "secondary");
        expect(secondaryWorkspacePane?.tabs).toHaveLength(1);
        expect(secondaryWorkspacePane?.tabs[0]).toMatchObject({
            kind: "map",
            relativePath: "Excalidraw/Board.excalidraw",
            title: "Board",
        });
        expect(mockInvoke()).not.toHaveBeenCalledWith(
            "read_vault_file",
            expect.anything(),
        );
    });

    it("copies external files into the hovered file-tree folder", async () => {
        const originalRefreshStructure =
            useVaultStore.getState().refreshStructure;
        const refreshStructure = vi.fn(async () => {});
        useVaultStore.setState({ refreshStructure });
        mockInvoke().mockResolvedValue({
            relative_path: "Projects/draft.pdf",
            path: "/vaults/main/Projects/draft.pdf",
            file_name: "draft.pdf",
            mime_type: "application/pdf",
        });
        const folder = document.createElement("div");
        folder.setAttribute("data-folder-path", "Projects");
        vi.mocked(document.elementsFromPoint).mockReturnValue([folder]);

        renderComponent(<MultiPaneWorkspace />);
        await flushPromises();

        const dragDropListener = onDragDropEventMock.mock.calls.at(-1)?.[0] as
            | ((event: {
                  payload: {
                      type: "drop";
                      position: { x: number; y: number };
                      paths: string[];
                  };
              }) => void)
            | undefined;
        expect(dragDropListener).toBeTypeOf("function");

        await act(async () => {
            dragDropListener?.({
                payload: {
                    type: "drop",
                    position: { x: 24, y: 48 },
                    paths: ["/Users/jfg/Desktop/draft.pdf"],
                },
            });
            await flushPromises();
        });

        expect(mockInvoke()).toHaveBeenCalledWith("copy_external_file_to_vault", {
            sourcePath: "/Users/jfg/Desktop/draft.pdf",
            targetFolder: "Projects",
            vaultPath: "/vaults/main",
        });
        await waitFor(() => {
            expect(refreshStructure).toHaveBeenCalledTimes(1);
        });
        expect(useEditorStore.getState().panes.flatMap((pane) => pane.tabs)).toEqual(
            [],
        );
        useVaultStore.setState({ refreshStructure: originalRefreshStructure });
    });

    it("copies external files into the parent folder when hovering a file row", async () => {
        const originalRefreshStructure =
            useVaultStore.getState().refreshStructure;
        const refreshStructure = vi.fn(async () => {});
        useVaultStore.setState({ refreshStructure });
        mockInvoke().mockResolvedValue({
            relative_path: "Projects/assets/draft.pdf",
            path: "/vaults/main/Projects/assets/draft.pdf",
            file_name: "draft.pdf",
            mime_type: "application/pdf",
        });
        const fileRow = document.createElement("div");
        fileRow.setAttribute("data-folder-path", "Projects/assets");
        const fileLabel = document.createElement("span");
        fileRow.append(fileLabel);
        vi.mocked(document.elementsFromPoint).mockReturnValue([fileLabel]);

        renderComponent(<MultiPaneWorkspace />);
        await flushPromises();

        const dragDropListener = onDragDropEventMock.mock.calls.at(-1)?.[0] as
            | ((event: {
                  payload: {
                      type: "drop";
                      position: { x: number; y: number };
                      paths: string[];
                  };
              }) => void)
            | undefined;
        expect(dragDropListener).toBeTypeOf("function");

        await act(async () => {
            dragDropListener?.({
                payload: {
                    type: "drop",
                    position: { x: 24, y: 48 },
                    paths: ["/Users/jfg/Desktop/draft.pdf"],
                },
            });
            await flushPromises();
        });

        expect(mockInvoke()).toHaveBeenCalledWith("copy_external_file_to_vault", {
            sourcePath: "/Users/jfg/Desktop/draft.pdf",
            targetFolder: "Projects/assets",
            vaultPath: "/vaults/main",
        });
        await waitFor(() => {
            expect(refreshStructure).toHaveBeenCalledTimes(1);
        });
        useVaultStore.setState({ refreshStructure: originalRefreshStructure });
    });

    it("does not open a pane tab when the drop lands over the composer zone", async () => {
        setVaultEntries([
            {
                id: "docs/reference.txt",
                path: "/vault/docs/reference.txt",
                relative_path: "docs/reference.txt",
                title: "Reference",
                file_name: "reference.txt",
                extension: "txt",
                kind: "file",
                modified_at: 1,
                created_at: 1,
                size: 32,
                mime_type: "text/plain",
            },
        ]);
        mockInvoke().mockResolvedValue({
            relative_path: "docs/reference.txt",
            path: "/vault/docs/reference.txt",
            file_name: "reference.txt",
            mime_type: "text/plain",
            content: "reference",
            size_bytes: 32,
            content_truncated: false,
        });

        renderComponent(<MultiPaneWorkspace />);
        await flushPromises();

        const secondaryPane = screen
            .getByTestId("pane-content-secondary")
            .closest('[data-editor-pane-id="secondary"]') as HTMLElement | null;
        expect(secondaryPane).not.toBeNull();

        vi.spyOn(secondaryPane!, "getBoundingClientRect").mockReturnValue({
            x: 320,
            y: 0,
            left: 320,
            top: 0,
            right: 620,
            bottom: 300,
            width: 300,
            height: 300,
            toJSON: () => ({}),
        } as DOMRect);

        const composerDropZone = document.createElement("div");
        composerDropZone.dataset.aiComposerDropZone = "true";
        Object.defineProperty(composerDropZone, "getBoundingClientRect", {
            configurable: true,
            value: () =>
                ({
                    x: 400,
                    y: 80,
                    left: 400,
                    top: 80,
                    right: 560,
                    bottom: 200,
                    width: 160,
                    height: 120,
                    toJSON: () => ({}),
                }) as DOMRect,
        });
        document.body.appendChild(composerDropZone);

        try {
            await act(async () => {
                window.dispatchEvent(
                    new CustomEvent(FILE_TREE_NOTE_DRAG_EVENT, {
                        detail: {
                            phase: "end",
                            x: 460,
                            y: 120,
                            notes: [],
                            files: [
                                {
                                    filePath: "/vault/docs/reference.txt",
                                    fileName: "reference.txt",
                                    mimeType: "text/plain",
                                },
                            ],
                        },
                    }),
                );
                await flushPromises();
            });
        } finally {
            composerDropZone.remove();
        }

        expect(
            useEditorStore
                .getState()
                .panes.find((pane) => pane.id === "secondary")?.tabs,
        ).toHaveLength(0);
    });

    it("creates a split pane when a dragged vault file lands on a pane edge", async () => {
        setVaultEntries([
            {
                id: "docs/reference.txt",
                path: "/vault/docs/reference.txt",
                relative_path: "docs/reference.txt",
                title: "Reference",
                file_name: "reference.txt",
                extension: "txt",
                kind: "file",
                modified_at: 1,
                created_at: 1,
                size: 32,
                mime_type: "text/plain",
            },
        ]);
        mockInvoke().mockResolvedValue({
            relative_path: "docs/reference.txt",
            path: "/vault/docs/reference.txt",
            file_name: "reference.txt",
            mime_type: "text/plain",
            content: "reference",
            size_bytes: 32,
            content_truncated: false,
        });

        renderComponent(<MultiPaneWorkspace />);
        await flushPromises();

        const primaryPane = screen
            .getByTestId("pane-content-primary")
            .closest('[data-editor-pane-id="primary"]') as HTMLElement | null;
        expect(primaryPane).not.toBeNull();

        vi.spyOn(primaryPane!, "getBoundingClientRect").mockReturnValue({
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: 300,
            bottom: 300,
            width: 300,
            height: 300,
            toJSON: () => ({}),
        } as DOMRect);

        await act(async () => {
            window.dispatchEvent(
                new CustomEvent(FILE_TREE_NOTE_DRAG_EVENT, {
                    detail: {
                        phase: "end",
                        x: 292,
                        y: 120,
                        notes: [],
                        files: [
                            {
                                filePath: "/vault/docs/reference.txt",
                                fileName: "reference.txt",
                                mimeType: "text/plain",
                            },
                        ],
                    },
                }),
            );
            await flushPromises();
        });

        const state = useEditorStore.getState();
        const focusedPane = state.panes.find(
            (pane) => pane.id === state.focusedPaneId,
        );
        expect(state.panes).toHaveLength(4);
        expect(focusedPane?.tabs).toHaveLength(1);
        expect(focusedPane?.tabs[0]).toMatchObject({
            kind: "file",
            relativePath: "docs/reference.txt",
            title: "reference.txt",
        });
    });

    it("renders a divider between each adjacent pane", () => {
        renderComponent(<MultiPaneWorkspace />);

        expect(screen.getAllByRole("separator")).toHaveLength(2);
        expect(
            screen
                .getAllByRole("separator")
                .map((separator) => separator.getAttribute("aria-orientation")),
        ).toEqual(["vertical", "horizontal"]);
    });

    it("passes an explicit empty-state message to each pane content", () => {
        renderComponent(<MultiPaneWorkspace />);

        expect(
            screen.getAllByText((content) =>
                content.includes("This pane is empty. Open a note here"),
            ),
        ).toHaveLength(3);
    });

    it("publishes a drop zone for detached tab reattachment in split view", async () => {
        renderComponent(<MultiPaneWorkspace />);
        await flushPromises();
        await new Promise((resolve) => window.setTimeout(resolve, 0));

        expect(vi.mocked(publishWindowTabDropZone)).toHaveBeenCalledWith(
            "main",
            expect.objectContaining({
                left: 120,
                top: 40,
                right: 1020,
                bottom: 640,
                vaultPath: "/vaults/main",
            }),
        );
    });

    it("renders mixed layouts like A | (B over C)", () => {
        renderComponent(<MultiPaneWorkspace />);

        const primaryPane = screen
            .getByTestId("pane-content-primary")
            .closest('[data-editor-pane-id="primary"]');
        const secondaryPane = screen
            .getByTestId("pane-content-secondary")
            .closest('[data-editor-pane-id="secondary"]');
        const tertiaryPane = screen
            .getByTestId("pane-content-tertiary")
            .closest('[data-editor-pane-id="tertiary"]');

        expect(primaryPane).not.toBeNull();
        expect(secondaryPane).not.toBeNull();
        expect(tertiaryPane).not.toBeNull();
        expect(
            screen
                .getByTestId("pane-bar-primary")
                .closest('[data-workspace-split-direction="row"]'),
        ).not.toBeNull();
        expect(
            screen
                .getByTestId("pane-bar-secondary")
                .closest('[data-workspace-split-direction="column"]'),
        ).not.toBeNull();
    });

    it("stretches pane containers to fill their split slots", () => {
        renderComponent(<MultiPaneWorkspace />);

        const primaryPane = screen
            .getByTestId("pane-content-primary")
            .closest('[data-editor-pane-id="primary"]');

        expect(primaryPane).not.toBeNull();
        expect(primaryPane?.className).toContain("w-full");
        expect(primaryPane?.className).toContain("flex-1");
    });

    it("stretches the root split container to fill the workspace width", () => {
        renderComponent(<MultiPaneWorkspace />);

        const rootSplit = document.querySelector(
            `[data-workspace-split-id="${useEditorStore.getState().layoutTree.id}"]`,
        );

        expect(rootSplit).not.toBeNull();
        expect(rootSplit?.className).toContain("w-full");
        expect(rootSplit?.className).toContain("flex-1");
    });

    it("renders independent resize handles for each split branch", () => {
        renderComponent(<MultiPaneWorkspace />);

        const separators = screen.getAllByRole("separator");
        const verticalDivider = separators.find(
            (separator) =>
                separator.getAttribute("aria-orientation") === "vertical",
        );
        const horizontalDivider = separators.find(
            (separator) =>
                separator.getAttribute("aria-orientation") === "horizontal",
        );

        expect(verticalDivider).toBeDefined();
        expect(horizontalDivider).toBeDefined();
        expect(verticalDivider).toHaveAttribute(
            "aria-label",
            "Resize split split-1 sections 1 and 2",
        );
        expect(horizontalDivider).toHaveAttribute(
            "aria-label",
            "Resize split split-2 sections 1 and 2",
        );
    });

    it("renders global drop overlays for center, edge and strip previews", () => {
        renderComponent(<MultiPaneWorkspace />);

        act(() => {
            window.dispatchEvent(
                new CustomEvent(CROSS_PANE_TAB_DROP_PREVIEW_EVENT, {
                    detail: {
                        sourcePaneId: "primary",
                        targetPaneId: "secondary",
                        position: "center",
                        insertIndex: null,
                        tabId: "tab-a",
                        overlayRect: {
                            left: 210,
                            top: 40,
                            right: 430,
                            bottom: 220,
                            width: 220,
                            height: 180,
                        },
                        lineRect: null,
                    },
                }),
            );
        });

        expect(
            document.querySelector(
                '[data-workspace-drop-overlay-position="center"]',
            ),
        ).not.toBeNull();

        act(() => {
            window.dispatchEvent(
                new CustomEvent(CROSS_PANE_TAB_DROP_PREVIEW_EVENT, {
                    detail: {
                        sourcePaneId: "primary",
                        targetPaneId: "secondary",
                        position: "left",
                        insertIndex: null,
                        tabId: "tab-a",
                        overlayRect: {
                            left: 210,
                            top: 40,
                            right: 320,
                            bottom: 220,
                            width: 110,
                            height: 180,
                        },
                        lineRect: null,
                    },
                }),
            );
        });

        expect(
            document.querySelector(
                '[data-workspace-drop-overlay-position="left"]',
            ),
        ).not.toBeNull();

        act(() => {
            window.dispatchEvent(
                new CustomEvent(CROSS_PANE_TAB_DROP_PREVIEW_EVENT, {
                    detail: {
                        sourcePaneId: "primary",
                        targetPaneId: "secondary",
                        position: "center",
                        insertIndex: 1,
                        tabId: "tab-a",
                        overlayRect: null,
                        lineRect: {
                            left: 288,
                            top: 52,
                            right: 290,
                            bottom: 76,
                            width: 2,
                            height: 24,
                        },
                    },
                }),
            );
        });

        expect(
            document.querySelector('[data-workspace-drop-line="true"]'),
        ).not.toBeNull();
    });

    it("does not let file attachment events from workspace tab drags clear tab drop previews", () => {
        renderComponent(<MultiPaneWorkspace />);

        act(() => {
            window.dispatchEvent(
                new CustomEvent(CROSS_PANE_TAB_DROP_PREVIEW_EVENT, {
                    detail: {
                        sourcePaneId: "primary",
                        targetPaneId: "primary",
                        position: "right",
                        insertIndex: null,
                        tabId: "tab-a",
                        overlayRect: {
                            left: 220,
                            top: 40,
                            right: 430,
                            bottom: 220,
                            width: 210,
                            height: 180,
                        },
                        lineRect: null,
                    },
                }),
            );
        });

        expect(
            document.querySelector(
                '[data-workspace-drop-overlay-position="right"]',
            ),
        ).not.toBeNull();

        act(() => {
            window.dispatchEvent(
                new CustomEvent(FILE_TREE_NOTE_DRAG_EVENT, {
                    detail: {
                        phase: "move",
                        x: 320,
                        y: 120,
                        notes: [
                            {
                                id: "note-a",
                                title: "Note A",
                                path: "/vault/note-a.md",
                            },
                        ],
                        origin: {
                            kind: "workspace-tab",
                            tabId: "tab-a",
                        },
                    },
                }),
            );
        });

        expect(
            document.querySelector(
                '[data-workspace-drop-overlay-position="right"]',
            ),
        ).not.toBeNull();
    });
});
