import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTabDragReorder } from "./useTabDragReorder";

type PointerListener = (event: PointerEvent) => void;

function setElementLayout(
    element: HTMLElement,
    {
        left,
        top,
        width,
        height,
    }: {
        left: number;
        top: number;
        width: number;
        height: number;
    },
) {
    Object.defineProperty(element, "offsetLeft", {
        configurable: true,
        get: () => left,
    });
    Object.defineProperty(element, "offsetWidth", {
        configurable: true,
        get: () => width,
    });
    Object.defineProperty(element, "offsetHeight", {
        configurable: true,
        get: () => height,
    });
    Object.defineProperty(element, "scrollLeft", {
        configurable: true,
        writable: true,
        value: 0,
    });
    element.getBoundingClientRect = () =>
        ({
            x: left,
            y: top,
            left,
            top,
            right: left + width,
            bottom: top + height,
            width,
            height,
            toJSON: () => ({}),
        }) as DOMRect;
}

function createPointerDownEvent(
    target: HTMLDivElement,
    coords: {
        pointerId: number;
        clientX: number;
        clientY: number;
        screenX: number;
        screenY: number;
    },
) {
    return {
        button: 0,
        target,
        currentTarget: target,
        pointerId: coords.pointerId,
        clientX: coords.clientX,
        clientY: coords.clientY,
        screenX: coords.screenX,
        screenY: coords.screenY,
        preventDefault: vi.fn(),
    };
}

describe("useTabDragReorder", () => {
    const pointerListeners = new Map<string, Set<PointerListener>>();
    let windowAddEventListenerSpy: ReturnType<typeof vi.spyOn>;
    let windowRemoveEventListenerSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        pointerListeners.clear();

        const originalAddEventListener = window.addEventListener.bind(window);
        const originalRemoveEventListener =
            window.removeEventListener.bind(window);

        windowAddEventListenerSpy = vi
            .spyOn(window, "addEventListener")
            .mockImplementation((type, listener, options) => {
                if (
                    type === "pointermove" ||
                    type === "pointerup" ||
                    type === "pointercancel"
                ) {
                    const listeners = pointerListeners.get(type) ?? new Set();
                    listeners.add(listener as PointerListener);
                    pointerListeners.set(type, listeners);
                    return;
                }

                originalAddEventListener(type, listener, options);
            });

        windowRemoveEventListenerSpy = vi
            .spyOn(window, "removeEventListener")
            .mockImplementation((type, listener, options) => {
                if (
                    type === "pointermove" ||
                    type === "pointerup" ||
                    type === "pointercancel"
                ) {
                    pointerListeners.get(type)?.delete(
                        listener as PointerListener,
                    );
                    return;
                }

                originalRemoveEventListener(type, listener, options);
            });
    });

    afterEach(() => {
        windowAddEventListenerSpy.mockRestore();
        windowRemoveEventListenerSpy.mockRestore();
    });

    it("keeps tracking the gesture after the pointer leaves the tab before drag starts", () => {
        const onCommitReorder = vi.fn();
        const onDragStart = vi.fn();

        const { result } = renderHook(() =>
            useTabDragReorder({
                tabs: [{ id: "tab-a" }, { id: "tab-b" }],
                onCommitReorder,
                onDragStart,
                liveReorder: false,
            }),
        );

        const strip = document.createElement("div");
        const tabA = document.createElement("div");
        const tabB = document.createElement("div");

        setElementLayout(strip, { left: 0, top: 0, width: 120, height: 28 });
        setElementLayout(tabA, { left: 0, top: 0, width: 60, height: 28 });
        setElementLayout(tabB, { left: 60, top: 0, width: 60, height: 28 });
        tabA.setPointerCapture = vi.fn();

        act(() => {
            result.current.tabStripRef.current = strip;
            result.current.registerTabNode("tab-a", tabA);
            result.current.registerTabNode("tab-b", tabB);
        });

        act(() => {
            result.current.handlePointerDown(
                "tab-a",
                0,
                createPointerDownEvent(tabA, {
                    pointerId: 7,
                    clientX: 12,
                    clientY: 10,
                    screenX: 112,
                    screenY: 10,
                }) as never,
            );
        });

        const moveListeners = pointerListeners.get("pointermove");
        const upListeners = pointerListeners.get("pointerup");
        expect(moveListeners?.size).toBeGreaterThan(0);
        expect(upListeners?.size).toBeGreaterThan(0);

        act(() => {
            moveListeners?.forEach((listener) =>
                listener({
                    pointerId: 7,
                    clientX: 92,
                    clientY: 12,
                    screenX: 192,
                    screenY: 12,
                    buttons: 1,
                } as PointerEvent),
            );
        });

        act(() => {
            upListeners?.forEach((listener) =>
                listener({
                    pointerId: 7,
                    clientX: 92,
                    clientY: 12,
                    screenX: 192,
                    screenY: 12,
                } as PointerEvent),
            );
        });

        expect(onDragStart).toHaveBeenCalledTimes(1);
        expect(onCommitReorder).toHaveBeenCalledWith(0, 1);
    });

    it("does not activate the tab when the pending gesture ends outside its bounds", () => {
        const onActivate = vi.fn();

        const { result } = renderHook(() =>
            useTabDragReorder({
                tabs: [{ id: "tab-a" }, { id: "tab-b" }],
                onCommitReorder: vi.fn(),
                onActivate,
                liveReorder: false,
            }),
        );

        const strip = document.createElement("div");
        const tabA = document.createElement("div");
        const tabB = document.createElement("div");

        setElementLayout(strip, { left: 0, top: 0, width: 120, height: 28 });
        setElementLayout(tabA, { left: 0, top: 0, width: 60, height: 28 });
        setElementLayout(tabB, { left: 60, top: 0, width: 60, height: 28 });

        act(() => {
            result.current.tabStripRef.current = strip;
            result.current.registerTabNode("tab-a", tabA);
            result.current.registerTabNode("tab-b", tabB);
        });

        act(() => {
            result.current.handlePointerDown(
                "tab-a",
                0,
                createPointerDownEvent(tabA, {
                    pointerId: 9,
                    clientX: 12,
                    clientY: 10,
                    screenX: 112,
                    screenY: 10,
                }) as never,
            );
        });

        const upListeners = pointerListeners.get("pointerup");
        expect(upListeners?.size).toBeGreaterThan(0);

        act(() => {
            upListeners?.forEach((listener) =>
                listener({
                    pointerId: 9,
                    clientX: 180,
                    clientY: 90,
                    screenX: 280,
                    screenY: 90,
                } as PointerEvent),
            );
        });

        expect(onActivate).not.toHaveBeenCalled();
    });
});
