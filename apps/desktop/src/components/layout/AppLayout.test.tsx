import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { AppLayout } from "./AppLayout";
import { useLayoutStore } from "../../app/store/layoutStore";

class MockResizeObserver {
    private callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
    }

    observe(target: Element) {
        this.callback(
            [
                {
                    target,
                    contentRect: {
                        width: 1200,
                        height: 800,
                        x: 0,
                        y: 0,
                        top: 0,
                        right: 1200,
                        bottom: 800,
                        left: 0,
                        toJSON: () => ({}),
                    } as DOMRectReadOnly,
                } as ResizeObserverEntry,
            ],
            this as unknown as ResizeObserver,
        );
    }

    unobserve() {}

    disconnect() {}
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

    beforeEach(() => {
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

        const leftPanel = screen.getByText("Left").parentElement;
        const leftResizer = leftPanel?.nextElementSibling;

        expect(leftPanel).toBeInstanceOf(HTMLElement);
        expect(leftResizer).toBeInstanceOf(HTMLElement);

        fireEvent.pointerDown(leftResizer as Element, {
            button: 0,
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
});
