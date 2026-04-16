import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
    flushPromises,
    getXtermMockInstances,
    renderComponent,
} from "../../../test/test-utils";
import { TerminalViewport } from "./TerminalViewport";
import type { TerminalSessionView } from "./terminalTypes";

function createSessionView(
    overrides: Partial<TerminalSessionView> = {},
): TerminalSessionView {
    return {
        snapshot: {
            sessionId: "devterm-1",
            program: "/bin/zsh",
            status: "running",
            displayName: "zsh",
            cwd: "/vault",
            cols: 120,
            rows: 24,
            exitCode: null,
            errorMessage: null,
        },
        rawOutput: "hello from terminal\nready",
        busy: false,
        writeInput: vi.fn(async () => undefined),
        resize: vi.fn(async () => undefined),
        restart: vi.fn(async () => undefined),
        clearViewport: vi.fn(),
        ...overrides,
    };
}

describe("TerminalViewport", () => {
    it("renders raw output and forwards xterm input and settled resize events", async () => {
        const writeInput = vi.fn(async () => undefined);
        const resize = vi.fn(async () => undefined);
        vi.useFakeTimers();

        try {
            renderComponent(
                <TerminalViewport
                    session={createSessionView({
                        writeInput,
                        resize,
                    })}
                />,
            );
            await flushPromises();

            expect(screen.getByText(/hello from terminal/i)).toBeInTheDocument();
            expect(screen.getByText(/ready/i)).toBeInTheDocument();
            expect(resize).not.toHaveBeenCalled();

            await act(async () => {
                vi.advanceTimersByTime(100);
            });

            expect(resize).toHaveBeenCalledWith(80, 24);

            act(() => {
                getXtermMockInstances()[0]?.emitData("pwd\r");
            });

            expect(writeInput).toHaveBeenCalledWith("pwd\r");
        } finally {
            vi.useRealTimers();
        }
    });

    it("coalesces noisy resize observer updates into a single PTY resize", async () => {
        const resize = vi.fn(async () => undefined);
        const originalResizeObserver = globalThis.ResizeObserver;

        class MockResizeObserver {
            static callbacks: ResizeObserverCallback[] = [];

            constructor(callback: ResizeObserverCallback) {
                MockResizeObserver.callbacks.push(callback);
            }

            observe() {}

            unobserve() {}

            disconnect() {}

            static notifyAll() {
                for (const callback of MockResizeObserver.callbacks) {
                    callback([], {} as ResizeObserver);
                }
            }

            static reset() {
                MockResizeObserver.callbacks = [];
            }
        }

        vi.useFakeTimers();
        Object.defineProperty(globalThis, "ResizeObserver", {
            configurable: true,
            writable: true,
            value: MockResizeObserver,
        });

        try {
            renderComponent(
                <TerminalViewport
                    session={createSessionView({
                        resize,
                    })}
                />,
            );
            await flushPromises();

            act(() => {
                MockResizeObserver.notifyAll();
                MockResizeObserver.notifyAll();
                MockResizeObserver.notifyAll();
            });

            expect(resize).not.toHaveBeenCalled();

            await act(async () => {
                vi.advanceTimersByTime(100);
            });

            expect(resize).toHaveBeenCalledTimes(1);
            expect(resize).toHaveBeenLastCalledWith(80, 24);
        } finally {
            MockResizeObserver.reset();
            Object.defineProperty(globalThis, "ResizeObserver", {
                configurable: true,
                writable: true,
                value: originalResizeObserver,
            });
            vi.useRealTimers();
        }
    });
});
