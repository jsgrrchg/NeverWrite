import { render, screen, within } from "@testing-library/react";
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

describe("AppLayout bottom panel", () => {
    const originalResizeObserver = globalThis.ResizeObserver;

    beforeAll(() => {
        Object.defineProperty(globalThis, "ResizeObserver", {
            value: MockResizeObserver,
            configurable: true,
        });
    });

    afterAll(() => {
        Object.defineProperty(globalThis, "ResizeObserver", {
            value: originalResizeObserver,
            configurable: true,
        });
    });

    beforeEach(() => {
        useLayoutStore.setState({
            sidebarCollapsed: false,
            sidebarWidth: 240,
            rightPanelCollapsed: false,
            rightPanelExpanded: false,
            rightPanelWidth: 280,
            rightPanelView: "outline",
            bottomPanelCollapsed: false,
            bottomPanelHeight: 240,
            bottomPanelView: "terminal",
        });
    });

    it("renders without a bottom panel", () => {
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
        expect(screen.queryByText("Bottom")).not.toBeInTheDocument();
    });

    it("renders the bottom panel when provided", () => {
        render(
            <AppLayout
                left={<div>Left</div>}
                center={<div>Center</div>}
                right={<div>Right</div>}
                bottom={<div>Bottom</div>}
            />,
        );

        expect(screen.getByText("Bottom")).toBeInTheDocument();
    });

    it("keeps the right panel outside the bottom-panel column", () => {
        render(
            <AppLayout
                left={<div>Left</div>}
                center={<div>Center</div>}
                right={<div>Right</div>}
                bottom={<div>Bottom</div>}
            />,
        );

        const centerColumn = screen.getByTestId("app-layout-center-column");
        const rightPanel = screen.getByTestId("app-layout-right-panel");
        const bottomPanel = screen.getByTestId("app-layout-bottom-panel");

        expect(within(centerColumn).getByText("Bottom")).toBe(
            bottomPanel.firstChild,
        );
        expect(within(rightPanel).getByText("Right")).toBeInTheDocument();
        expect(
            within(rightPanel).queryByText("Bottom"),
        ).not.toBeInTheDocument();
    });
});
