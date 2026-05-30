import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
    flushPromises,
    getXtermMockInstances,
    renderComponent,
} from "../../test/test-utils";
import { TerminalViewport } from "./TerminalViewport";
import type {
    TerminalOutputCommand,
    TerminalSessionView,
} from "./terminalTypes";

const DICTATION_PLACEHOLDER = "Speak or type — Enter to send";

// Build a session view backed by a controllable output channel that mirrors the
// runtime store's emitter: commands buffered before the viewport subscribes are
// flushed on subscribe, exactly like production.
function createSession(overrides: Partial<TerminalSessionView> = {}) {
    const listeners = new Set<(command: TerminalOutputCommand) => void>();
    const backlog: TerminalOutputCommand[] = [];
    let replaySnapshot: string | null = null;

    const emit = (command: TerminalOutputCommand) => {
        if (listeners.size === 0) {
            backlog.push(command);
            return;
        }
        for (const listener of listeners) listener(command);
    };

    const session: TerminalSessionView = {
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
        hasOutput: true,
        busy: false,
        writeInput: vi.fn(async () => undefined),
        resize: vi.fn(async () => undefined),
        restart: vi.fn(async () => undefined),
        clearViewport: vi.fn(),
        subscribeOutput: (listener) => {
            if (listeners.size === 0 && backlog.length > 0) {
                const pending = backlog.splice(0, backlog.length);
                for (const command of pending) listener(command);
            }
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        getReplaySnapshot: () => replaySnapshot,
        saveReplaySnapshot: (serialized) => {
            replaySnapshot = serialized;
        },
        ...overrides,
    };

    return { session, emit };
}

// Thin wrapper for tests that only need the session view itself (e.g. the
// dictation UI), not the output channel.
function createSessionView(
    overrides: Partial<TerminalSessionView> = {},
): TerminalSessionView {
    return createSession(overrides).session;
}

describe("TerminalViewport", () => {
    it("writes piped output to xterm, fires initial PTY resize immediately, and forwards xterm input", async () => {
        const writeInput = vi.fn(async () => undefined);
        const resize = vi.fn(async () => undefined);
        vi.useFakeTimers();

        try {
            const { session, emit } = createSession({ writeInput, resize });
            renderComponent(<TerminalViewport session={session} />);
            await flushPromises();

            act(() => {
                emit({ type: "write", data: "hello from terminal\nready" });
            });

            expect(
                screen.getByText(/hello from terminal/i),
            ).toBeInTheDocument();
            expect(screen.getByText(/ready/i)).toBeInTheDocument();

            // First fit fires immediately — no debounce on initial mount.
            expect(resize).toHaveBeenCalledOnce();
            expect(resize).toHaveBeenCalledWith(80, 24);

            // Advancing time triggers the rAF-driven syncSize, but the size is
            // already recorded so the dedup check prevents a second call.
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

    it("flushes output buffered before the viewport subscribes", async () => {
        const { session, emit } = createSession();

        // Emitted before render → goes to the backlog, then flushed on subscribe.
        emit({ type: "write", data: "buffered output\n" });

        renderComponent(<TerminalViewport session={session} />);
        await flushPromises();

        expect(screen.getByText(/buffered output/i)).toBeInTheDocument();
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
            const { session } = createSession({ resize });
            renderComponent(<TerminalViewport session={session} />);
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
        const { session, emit } = createSession();
        renderComponent(
            <TerminalViewport initialScrollPosition="top" session={session} />,
        );
        await flushPromises();

        act(() => {
            emit({
                type: "write",
                data: "first line\nsecond line\nthird line",
            });
        });

        expect(getXtermMockInstances()[0]?.scrollToTopCalls).toBe(1);
    });

    it("restores the replay snapshot on mount before live output", async () => {
        const { session, emit } = createSession();
        session.saveReplaySnapshot("restored screen state");

        renderComponent(<TerminalViewport session={session} />);
        await flushPromises();

        act(() => {
            emit({ type: "write", data: " + live tail" });
        });

        const [term] = getXtermMockInstances();
        expect(term?.screen?.textContent).toBe(
            "restored screen state + live tail",
        );
    });

    it("saves a serialized snapshot when unmounting", async () => {
        const saveReplaySnapshot = vi.fn();
        const { session, emit } = createSession({ saveReplaySnapshot });
        const { unmount } = renderComponent(
            <TerminalViewport session={session} />,
        );
        await flushPromises();

        act(() => {
            emit({ type: "write", data: "persist me" });
        });

        unmount();

        // The serialize addon mock returns the xterm screen content, so the
        // final snapshot captures what was on screen at teardown.
        expect(saveReplaySnapshot).toHaveBeenLastCalledWith("persist me");
    });

    it("clears the xterm screen on a clear command", async () => {
        const { session, emit } = createSession();
        renderComponent(<TerminalViewport session={session} />);
        await flushPromises();

        const [term] = getXtermMockInstances();
        if (!term) throw new Error("No xterm instance");

        act(() => {
            emit({ type: "write", data: "some output" });
        });
        expect(term.screen?.textContent).toBe("some output");

        const resetSpy = vi.spyOn(term, "reset");
        act(() => {
            emit({ type: "clear" });
        });

        expect(resetSpy).toHaveBeenCalledOnce();
        expect(term.screen?.textContent).toBe("");
    });

    it("sends \\n to the PTY on Shift+Enter and does not intercept plain Enter or keyup", async () => {
        const writeInput = vi.fn(async () => undefined);

        const { session } = createSession({ writeInput });
        renderComponent(<TerminalViewport session={session} />);
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

    it("opens dictation from the context menu, cancels cleanly, and sends entered text", async () => {
        const writeInput = vi.fn(async () => undefined);
        const { container } = renderComponent(
            <TerminalViewport session={createSessionView({ writeInput })} />,
        );
        await flushPromises();

        fireEvent.contextMenu(container.firstElementChild!);
        fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
        await flushPromises();

        const cancelledInput =
            screen.getByPlaceholderText(DICTATION_PLACEHOLDER);
        fireEvent.change(cancelledInput, { target: { value: "draft command" } });
        fireEvent.keyDown(cancelledInput, { key: "Escape" });

        expect(writeInput).not.toHaveBeenCalled();
        expect(
            screen.queryByPlaceholderText(DICTATION_PLACEHOLDER),
        ).not.toBeInTheDocument();

        fireEvent.contextMenu(container.firstElementChild!);
        fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
        await flushPromises();

        const input = screen.getByPlaceholderText(DICTATION_PLACEHOLDER);
        fireEvent.change(input, { target: { value: "pwd" } });
        fireEvent.click(screen.getByRole("button", { name: "Send" }));

        expect(writeInput).toHaveBeenCalledWith("pwd");
        expect(
            screen.queryByPlaceholderText(DICTATION_PLACEHOLDER),
        ).not.toBeInTheDocument();
    });

    it("clears dictation when the terminal session changes or stops running", async () => {
        const writeInput = vi.fn(async () => undefined);
        const { container, rerender } = renderComponent(
            <TerminalViewport session={createSessionView({ writeInput })} />,
        );
        await flushPromises();

        fireEvent.contextMenu(container.firstElementChild!);
        fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
        await flushPromises();

        const staleInput = screen.getByPlaceholderText(DICTATION_PLACEHOLDER);
        fireEvent.change(staleInput, { target: { value: "stale command" } });

        rerender(
            <TerminalViewport
                session={createSessionView({
                    writeInput,
                    snapshot: {
                        ...createSessionView().snapshot,
                        sessionId: "devterm-2",
                    },
                })}
            />,
        );
        await flushPromises();

        expect(
            screen.queryByPlaceholderText(DICTATION_PLACEHOLDER),
        ).not.toBeInTheDocument();
        expect(writeInput).not.toHaveBeenCalled();

        fireEvent.contextMenu(container.firstElementChild!);
        fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
        await flushPromises();

        expect(screen.getByPlaceholderText(DICTATION_PLACEHOLDER)).toHaveValue(
            "",
        );

        rerender(
            <TerminalViewport
                session={createSessionView({
                    writeInput,
                    snapshot: {
                        ...createSessionView().snapshot,
                        status: "exited",
                        exitCode: 0,
                    },
                })}
            />,
        );
        await flushPromises();

        expect(
            screen.queryByPlaceholderText(DICTATION_PLACEHOLDER),
        ).not.toBeInTheDocument();
    });
});
