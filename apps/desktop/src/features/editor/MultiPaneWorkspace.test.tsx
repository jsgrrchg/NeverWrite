import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { flushPromises, renderComponent } from "../../test/test-utils";
import { publishWindowTabDropZone } from "../../app/detachedWindows";
import { useEditorStore } from "../../app/store/editorStore";
import {
    createInitialLayout,
    splitPane,
} from "../../app/store/workspaceLayoutTree";
import { useVaultStore } from "../../app/store/vaultStore";
import { MultiPaneWorkspace } from "./MultiPaneWorkspace";
import { CROSS_PANE_TAB_DROP_PREVIEW_EVENT } from "./workspaceTabDropPreview";

const innerPositionMock = vi.fn();
const scaleFactorMock = vi.fn();

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

    it("renders pane drop overlays for center and edge previews", () => {
        renderComponent(<MultiPaneWorkspace />);

        act(() => {
            window.dispatchEvent(
                new CustomEvent(CROSS_PANE_TAB_DROP_PREVIEW_EVENT, {
                    detail: {
                        sourcePaneId: "primary",
                        targetPaneId: "secondary",
                        position: "center",
                        insertIndex: 0,
                        tabId: "tab-a",
                    },
                }),
            );
        });

        expect(
            screen
                .getByTestId("pane-content-secondary")
                .closest('[data-editor-pane-id="secondary"]')
                ?.querySelector('[data-pane-drop-overlay-position="center"]'),
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
                    },
                }),
            );
        });

        expect(
            screen
                .getByTestId("pane-content-secondary")
                .closest('[data-editor-pane-id="secondary"]')
                ?.querySelector('[data-pane-drop-overlay-position="left"]'),
        ).not.toBeNull();
    });
});
