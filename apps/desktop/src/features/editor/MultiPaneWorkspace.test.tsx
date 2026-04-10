import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderComponent } from "../../test/test-utils";
import { useEditorStore } from "../../app/store/editorStore";
import { useLayoutStore } from "../../app/store/layoutStore";
import { MultiPaneWorkspace } from "./MultiPaneWorkspace";

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
        });
        useLayoutStore.setState({
            editorPaneSizes: [1 / 3, 1 / 3, 1 / 3],
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
    });

    it("passes an explicit empty-state message to each pane content", () => {
        renderComponent(<MultiPaneWorkspace />);

        expect(
            screen.getAllByText((content) =>
                content.includes("This pane is empty. Open a note here"),
            ),
        ).toHaveLength(3);
    });
});
