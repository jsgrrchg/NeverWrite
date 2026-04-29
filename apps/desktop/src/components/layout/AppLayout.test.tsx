import { fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import {
    beforeAll,
    afterAll,
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { AppLayout } from "./AppLayout";
import { useLayoutStore } from "../../app/store/layoutStore";
import {
    FILE_TREE_NOTE_DRAG_EVENT,
    type FileTreeNoteDragDetail,
} from "../../features/ai/dragEvents";

class MockResizeObserver {
    static instances: MockResizeObserver[] = [];

    private callback: ResizeObserverCallback;
    private target: Element | null = null;

    constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        MockResizeObserver.instances.push(this);
    }

    observe(target: Element) {
        this.target = target;
        this.resizeTo(1200, 800);
    }

    resizeTo(width: number, height: number) {
        if (!this.target) return;
        this.callback(
            [
                {
                    target: this.target,
                    contentRect: {
                        width,
                        height,
                        x: 0,
                        y: 0,
                        top: 0,
                        right: width,
                        bottom: height,
                        left: 0,
                        toJSON: () => ({}),
                    } as DOMRectReadOnly,
                } as ResizeObserverEntry,
            ],
            this as unknown as ResizeObserver,
        );
    }

    unobserve() {}

    disconnect() {
        this.target = null;
    }
}

function firePointer(
    target: Element,
    type: string,
    init: {
        button?: number;
        buttons?: number;
        clientX: number;
        pointerId: number;
    },
) {
    const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: init.button ?? 0,
        buttons: init.buttons ?? 0,
        clientX: init.clientX,
    });
    Object.defineProperty(event, "pointerId", { value: init.pointerId });
    fireEvent(target, event);
}

describe("AppLayout", () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    const originalSetPointerCapture = HTMLElement.prototype.setPointerCapture;
    const originalReleasePointerCapture =
        HTMLElement.prototype.releasePointerCapture;
    const originalHasPointerCapture = HTMLElement.prototype.hasPointerCapture;

    beforeAll(() => {
        Object.defineProperty(globalThis, "ResizeObserver", {
            value: MockResizeObserver,
            configurable: true,
        });
        HTMLElement.prototype.setPointerCapture = () => {};
        HTMLElement.prototype.releasePointerCapture = () => {};
        HTMLElement.prototype.hasPointerCapture = () => true;
    });

    afterAll(() => {
        Object.defineProperty(globalThis, "ResizeObserver", {
            value: originalResizeObserver,
            configurable: true,
        });
        HTMLElement.prototype.setPointerCapture = originalSetPointerCapture;
        HTMLElement.prototype.releasePointerCapture =
            originalReleasePointerCapture;
        HTMLElement.prototype.hasPointerCapture = originalHasPointerCapture;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    beforeEach(() => {
        MockResizeObserver.instances = [];
        useLayoutStore.setState({
            sidebarCollapsed: false,
            sidebarWidth: 280,
            rightPanelCollapsed: false,
            rightPanelExpanded: false,
            rightPanelWidth: 280,
            rightPanelView: "outline",
        });
    });

    it("renders the left, center, and right regions", () => {
        render(
            <AppLayout
                left={<div>Left</div>}
                center={<div>Center</div>}
                right={<div>Right</div>}
            />,
        );

        expect(screen.getByText("Left")).toBeInTheDocument();
        expect(screen.getByText("Center")).toBeInTheDocument();
        expect(screen.getByText("Right")).toBeInTheDocument();
    });

    it("keeps the right panel outside the center column", () => {
        render(
            <AppLayout
                left={<div>Left</div>}
                center={<div>Center</div>}
                right={<div>Right</div>}
            />,
        );

        const centerColumn = screen.getByTestId("app-layout-center-column");
        const rightPanel = screen.getByTestId("app-layout-right-panel");

        expect(centerColumn).toContainElement(screen.getByText("Center"));
        expect(rightPanel).toContainElement(screen.getByText("Right"));
        expect(rightPanel).not.toContainElement(screen.getByText("Center"));
    });

    it("clamps left resize to the minimum width without collapsing", () => {
        render(
            <AppLayout
                left={<div>Left</div>}
                center={<div>Center</div>}
                right={<div>Right</div>}
            />,
        );

        const leftPanel = screen.getByTestId("app-layout-left-panel");
        const leftResizer = leftPanel?.nextElementSibling;

        expect(leftPanel).toBeInstanceOf(HTMLElement);
        expect(leftResizer).toBeInstanceOf(HTMLElement);

        fireEvent.pointerDown(leftResizer as Element, {
            button: 0,
            buttons: 1,
            clientX: 280,
            pointerId: 1,
        });
        fireEvent.pointerMove(leftResizer as Element, {
            clientX: 10,
            pointerId: 1,
        });

        expect((leftPanel as HTMLElement).style.width).toBe("280px");

        fireEvent.pointerUp(leftResizer as Element, {
            pointerId: 1,
        });

        expect(useLayoutStore.getState().sidebarCollapsed).toBe(false);
        expect(useLayoutStore.getState().sidebarWidth).toBe(280);
    });

    it("updates the left sidebar width while the drag is still active", async () => {
        vi.useFakeTimers();

        render(
            <AppLayout
                left={<div>Left</div>}
                center={<div>Center</div>}
                right={<div>Right</div>}
            />,
        );

        await act(async () => {
            MockResizeObserver.instances.forEach((observer) => {
                observer.resizeTo(1200, 800);
            });
        });

        const leftPanel = screen.getByTestId("app-layout-left-panel");
        const leftInner = leftPanel.querySelector("[data-sidebar-dock-inner]");
        const leftResizer = screen.getByTestId("app-layout-left-resizer");

        expect(leftInner).toBeInstanceOf(HTMLElement);
        expect(leftResizer).toBeInstanceOf(HTMLElement);

        firePointer(leftResizer as Element, "pointerdown", {
            button: 0,
            buttons: 1,
            clientX: 280,
            pointerId: 1,
        });
        expect(document.body).toHaveClass("resizing-sidebar");
        firePointer(leftResizer as Element, "pointermove", {
            buttons: 1,
            clientX: 420,
            pointerId: 1,
        });

        act(() => {
            vi.runOnlyPendingTimers();
        });

        expect((leftPanel as HTMLElement).style.width).toBe("420px");
        expect((leftInner as HTMLElement).style.width).toBe("420px");
        expect(useLayoutStore.getState().sidebarWidth).toBe(280);

        firePointer(leftResizer as Element, "pointerup", {
            clientX: 420,
            pointerId: 1,
        });

        expect(useLayoutStore.getState().sidebarWidth).toBe(420);
    });

    it("keeps the docked sidebar mounted until the collapse animation finishes", () => {
        vi.useFakeTimers();

        render(
            <AppLayout
                left={<div>Left</div>}
                center={<div>Center</div>}
                right={<div>Right</div>}
            />,
        );

        act(() => {
            useLayoutStore.getState().toggleSidebar();
        });

        expect(screen.getByTestId("app-layout-left-panel")).toBeInTheDocument();
        expect(
            screen.queryByTestId("sidebar-peek-hotspot"),
        ).not.toBeInTheDocument();

        act(() => {
            vi.advanceTimersByTime(190);
        });

        expect(
            screen.queryByTestId("app-layout-left-panel"),
        ).not.toBeInTheDocument();
        expect(screen.getByTestId("sidebar-peek-hotspot")).toBeInTheDocument();
    });

    it("mounts the docked sidebar immediately when expanding from collapsed", () => {
        useLayoutStore.setState({ sidebarCollapsed: true });

        render(
            <AppLayout
                left={<div>Left</div>}
                center={<div>Center</div>}
                right={<div>Right</div>}
            />,
        );

        expect(
            screen.queryByTestId("app-layout-left-panel"),
        ).not.toBeInTheDocument();

        act(() => {
            useLayoutStore.getState().toggleSidebar();
        });

        expect(screen.getByTestId("app-layout-left-panel")).toBeInTheDocument();
    });

    it("keeps the collapsed sidebar peek overlay mounted during file-tree drags", () => {
        vi.useFakeTimers();
        useLayoutStore.setState({ sidebarCollapsed: true });

        render(
            <AppLayout
                left={<div>Left</div>}
                center={<div>Center</div>}
                right={<div>Right</div>}
            />,
        );

        fireEvent.mouseEnter(screen.getByTestId("sidebar-peek-hotspot"));
        const overlay = screen.getByTestId("sidebar-peek-overlay");
        expect(overlay).toContainElement(screen.getByText("Left"));

        act(() => {
            window.dispatchEvent(
                new CustomEvent<FileTreeNoteDragDetail>(
                    FILE_TREE_NOTE_DRAG_EVENT,
                    {
                        detail: {
                            phase: "start",
                            x: 40,
                            y: 40,
                            notes: [
                                {
                                    id: "note-1",
                                    title: "Dragged note",
                                    path: "Dragged note.md",
                                },
                            ],
                        },
                    },
                ),
            );
        });

        fireEvent.mouseLeave(overlay);
        act(() => {
            vi.advanceTimersByTime(250);
        });

        expect(screen.getByTestId("sidebar-peek-overlay")).toBeInTheDocument();

        act(() => {
            window.dispatchEvent(
                new CustomEvent<FileTreeNoteDragDetail>(
                    FILE_TREE_NOTE_DRAG_EVENT,
                    {
                        detail: {
                            phase: "end",
                            x: 600,
                            y: 400,
                            notes: [
                                {
                                    id: "note-1",
                                    title: "Dragged note",
                                    path: "Dragged note.md",
                                },
                            ],
                        },
                    },
                ),
            );
            vi.advanceTimersByTime(200);
        });

        expect(
            screen.queryByTestId("sidebar-peek-overlay"),
        ).not.toBeInTheDocument();
    });
});
