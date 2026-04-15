import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import {
    flushPromises,
    mockInvoke,
    renderComponent,
    setVaultEntries,
} from "../../test/test-utils";
import { publishWindowTabDropZone } from "../../app/detachedWindows";
import { useEditorStore } from "../../app/store/editorStore";
import {
    createInitialLayout,
    splitPane,
} from "../../app/store/workspaceLayoutTree";
import { useVaultStore } from "../../app/store/vaultStore";
import { FILE_TREE_NOTE_DRAG_EVENT } from "../ai/dragEvents";
import { MultiPaneWorkspace } from "./MultiPaneWorkspace";
import { CROSS_PANE_TAB_DROP_PREVIEW_EVENT } from "./workspaceTabDropPreview";

const innerPositionMock = vi.fn();
const scaleFactorMock = vi.fn();
const onDragDropEventMock = vi.fn();

vi.mock("@tauri-apps/api/window", () => ({
    getCurrentWindow: () => ({
        listen: vi.fn(),
        once: vi.fn(),
        onCloseRequested: vi.fn(),
        onMoved: vi.fn().mockResolvedValue(vi.fn()),
        onResized: vi.fn().mockResolvedValue(vi.fn()),
        onScaleChanged: vi.fn().mockResolvedValue(vi.fn()),
        innerPosition: innerPositionMock,
        scaleFactor: scaleFactorMock,
        setFocus: vi.fn(),
        startDragging: vi.fn(),
        emitTo: vi.fn(),
        close: vi.fn(),
        label: "main",
    }),
}));

vi.mock("@tauri-apps/api/webview", () => ({
    getCurrentWebview: () => ({
        onDragDropEvent: onDragDropEventMock,
    }),
}));

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

    beforeEach(() => {
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
                    activeTabId: null,
                    activationHistory: [],
                    tabNavigationHistory: [],
                    tabNavigationIndex: -1,
                },
                {
                    id: "secondary",
                    tabs: [],
                    activeTabId: null,
                    activationHistory: [],
                    tabNavigationHistory: [],
                    tabNavigationIndex: -1,
                },
                {
                    id: "tertiary",
                    tabs: [],
                    activeTabId: null,
                    activationHistory: [],
                    tabNavigationHistory: [],
                    tabNavigationIndex: -1,
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
});
