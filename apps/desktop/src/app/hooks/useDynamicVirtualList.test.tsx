import { act, renderHook, waitFor } from "@testing-library/react";
import type { RefObject } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useDynamicVirtualList } from "./useDynamicVirtualList";

class TestResizeObserver {
    static instances: TestResizeObserver[] = [];

    private callback: ResizeObserverCallback;
    private elements = new Set<Element>();

    constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        TestResizeObserver.instances.push(this);
    }

    observe(element: Element) {
        this.elements.add(element);
    }

    unobserve(element: Element) {
        this.elements.delete(element);
    }

    disconnect() {
        this.elements.clear();
    }

    static reset() {
        TestResizeObserver.instances = [];
    }

    static notify(element: Element) {
        for (const instance of TestResizeObserver.instances) {
            if (!instance.elements.has(element)) {
                continue;
            }

            instance.callback(
                [
                    {
                        target: element,
                        contentRect: element.getBoundingClientRect(),
                    } as ResizeObserverEntry,
                ],
                instance as unknown as ResizeObserver,
            );
        }
    }
}

describe("useDynamicVirtualList", () => {
    const originalResizeObserver = globalThis.ResizeObserver;

    afterEach(() => {
        TestResizeObserver.reset();
        Object.defineProperty(globalThis, "ResizeObserver", {
            configurable: true,
            writable: true,
            value: originalResizeObserver,
        });
    });

    it("recomputes the virtual window when the container height changes without scrolling", async () => {
        Object.defineProperty(globalThis, "ResizeObserver", {
            configurable: true,
            writable: true,
            value: TestResizeObserver,
        });

        let viewportHeight = 120;
        const container = document.createElement("div");
        Object.defineProperty(container, "clientHeight", {
            configurable: true,
            get: () => viewportHeight,
        });
        Object.defineProperty(container, "scrollTop", {
            configurable: true,
            get: () => 0,
        });

        const containerRef = {
            current: container,
        } as RefObject<HTMLElement | null>;
        const items = Array.from({ length: 20 }, (_, index) => ({
            id: `row-${index}`,
        }));

        const { result } = renderHook(() =>
            useDynamicVirtualList({
                container: containerRef,
                items,
                getItemKey: (item) => item.id,
                estimateSize: () => 50,
                overscan: 0,
            }),
        );

        await waitFor(() => {
            expect(result.current.endIndex).toBe(3);
        });

        viewportHeight = 260;
        act(() => {
            TestResizeObserver.notify(container);
        });

        expect(result.current.endIndex).toBe(6);
        expect(result.current.items).toHaveLength(6);
    });

    it("drops cached measurements when the measurement version changes", async () => {
        Object.defineProperty(globalThis, "ResizeObserver", {
            configurable: true,
            writable: true,
            value: TestResizeObserver,
        });

        const container = document.createElement("div");
        Object.defineProperty(container, "clientHeight", {
            configurable: true,
            get: () => 200,
        });
        Object.defineProperty(container, "scrollTop", {
            configurable: true,
            get: () => 0,
        });

        const containerRef = {
            current: container,
        } as RefObject<HTMLElement | null>;
        const items = [{ id: "row-1" }];
        const measuredNode = document.createElement("div");
        Object.defineProperty(measuredNode, "getBoundingClientRect", {
            configurable: true,
            value: () => ({
                height: 180,
                width: 0,
                top: 0,
                left: 0,
                right: 0,
                bottom: 180,
                x: 0,
                y: 0,
                toJSON: () => ({}),
            }),
        });
        Object.defineProperty(measuredNode, "offsetHeight", {
            configurable: true,
            get: () => 180,
        });

        let measurementVersion = 1;
        const { result, rerender } = renderHook(() =>
            useDynamicVirtualList({
                container: containerRef,
                items,
                getItemKey: (item) => item.id,
                estimateSize: () => 50,
                overscan: 0,
                measurementVersion,
            }),
        );

        act(() => {
            result.current.getMeasureRef("row-1")(measuredNode);
        });

        await waitFor(() => {
            expect(result.current.items[0]?.size).toBe(180);
        });

        measurementVersion = 2;
        rerender();

        await waitFor(() => {
            expect(result.current.items[0]?.size).toBe(50);
        });
    });
});
