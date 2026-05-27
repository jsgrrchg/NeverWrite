import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
    flushPromises,
    getXtermMockInstances,
    renderComponent,
} from "../../test/test-utils";
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
    it("renders raw output, fires initial PTY resize immediately, and forwards xterm input", async () => {
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

            // First fit fires immediately — no debounce on initial mount.
            expect(resize).toHaveBeenCalledOnce();
            expect(resize).toHaveBeenCalledWith(80, 24);

            // Advancing time triggers the rAF-driven syncSize, but the size
            // is already recorded so the dedup check prevents a second call.
            await act(async () => {
                vi.advanceTimersByTime(100);
            });
            expect(resize).toHaveBeenCalledTimes(1);

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

            // Initial fit fires immediately on mount.
            expect(resize).toHaveBeenCalledOnce();
            expect(resize).toHaveBeenCalledWith(80, 24);

            act(() => {
                MockResizeObserver.notifyAll();
                MockResizeObserver.notifyAll();
                MockResizeObserver.notifyAll();
            });

            // Three noisy ResizeObserver callbacks report the same 80×24 that
            // was already sent, so the dedup check absorbs them with no new
            // debounce timer.
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

    it("can keep the first terminal output scrolled to the top", async () => {
        renderComponent(
            <TerminalViewport
                initialScrollPosition="top"
                session={createSessionView({
                    rawOutput: "first line\nsecond line\nthird line",
                })}
            />,
        );
        await flushPromises();

        expect(getXtermMockInstances()[0]?.scrollToTopCalls).toBe(1);
    });

    it("queues chunks to a local backlog when the xterm write buffer is above the high watermark", async () => {
        const { rerender } = renderComponent(
            <TerminalViewport session={createSessionView({ rawOutput: "" })} />,
        );
        await flushPromises();

        const [term] = getXtermMockInstances();
        if (!term) throw new Error("No xterm instance");

        // Make write async so pendingWriteCharsRef doesn't immediately drain.
        const pendingCallbacks: Array<() => void> = [];
        vi.spyOn(term, "write").mockImplementation(
            (text: string, callback?: () => void) => {
                if (term.screen) {
                    term.screen.textContent =
                        (term.screen.textContent ?? "") + text;
                }
                if (callback) pendingCallbacks.push(callback);
            },
        );

        // Feed a chunk just above HIGH_WATERMARK (256_000). The write is
        // dispatched (pending was 0) but the callback is held, so
        // pendingWriteCharsRef stays at 257_000.
        const bigChunk = "x".repeat(257_000);
        rerender(
            <TerminalViewport
                session={createSessionView({ rawOutput: bigChunk })}
            />,
        );
        await flushPromises();

        expect(pendingCallbacks).toHaveLength(1);

        // Push a second chunk while the first is still in-flight.
        // pendingWriteCharsRef (257_000) > HIGH_WATERMARK (256_000) → backlog.
        const smallChunk = "hello";
        rerender(
            <TerminalViewport
                session={createSessionView({
                    rawOutput: bigChunk + smallChunk,
                })}
            />,
        );
        await flushPromises();

        expect(pendingCallbacks).toHaveLength(1); // no new write call
        expect(term.screen?.textContent).toBe(bigChunk); // "hello" not visible yet

        // Fire the first write's callback → pendingWriteCharsRef drops to 0,
        // queueMicrotask(flushBacklog) drains the "hello" backlog entry.
        await act(async () => {
            pendingCallbacks.shift()?.();
            await Promise.resolve();
            await Promise.resolve(); // let the queueMicrotask(flushBacklog) run
        });

        // "hello" is now visible — backlog was drained.
        expect(term.screen?.textContent).toBe(bigChunk + smallChunk);
        expect(pendingCallbacks).toHaveLength(1); // the backlog write's callback
    });

    it("sends \\n to the PTY on Shift+Enter and does not intercept plain Enter or keyup", async () => {
        const writeInput = vi.fn(async () => undefined);

        renderComponent(
            <TerminalViewport session={createSessionView({ writeInput })} />,
        );
        await flushPromises();

        const terminal = getXtermMockInstances()[0];
        expect(terminal).toBeDefined();

        const makeKey = (
            key: string,
            overrides: Partial<KeyboardEventInit> = {},
        ) =>
            new KeyboardEvent("keydown", {
                key,
                shiftKey: false,
                bubbles: true,
                ...overrides,
            });

        // Shift+Enter keydown → intercepted: writes \n and returns false.
        const shiftEnter = makeKey("Enter", { shiftKey: true });
        const shiftEnterResult = terminal!.triggerKeyEvent(shiftEnter);
        expect(shiftEnterResult).toBe(false);
        expect(writeInput).toHaveBeenCalledWith("\n");

        writeInput.mockClear();

        // Plain Enter → not intercepted: xterm handles it normally.
        const plainEnter = makeKey("Enter");
        const plainEnterResult = terminal!.triggerKeyEvent(plainEnter);
        expect(plainEnterResult).toBe(true);
        expect(writeInput).not.toHaveBeenCalled();

        // Shift+Enter keyup → not intercepted (handler only fires on keydown).
        const shiftEnterKeyUp = new KeyboardEvent("keyup", {
            key: "Enter",
            shiftKey: true,
            bubbles: true,
        });
        const keyUpResult = terminal!.triggerKeyEvent(shiftEnterKeyUp);
        expect(keyUpResult).toBe(true);
        expect(writeInput).not.toHaveBeenCalled();
    });
});
