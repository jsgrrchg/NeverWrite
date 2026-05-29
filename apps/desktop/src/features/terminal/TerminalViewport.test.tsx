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

    it("does not reset xterm when rawOutput is truncated at the buffer cap", async () => {
        // Simulate what appendTerminalRawOutput does once rawOutput exceeds
        // MAX_RAW_OUTPUT_CHARS: the front is trimmed so rawOutput no longer
        // starts with the previous value.  The probe-based truncation detector
        // must recognise this and avoid calling terminal.reset(), which would
        // blank the screen on every subsequent write.
        //
        // OVERLAP must be >= PROBE_LEN * 2 (64 chars) so the 32-byte probe
        // AND the 32-byte verification window both land inside the shared
        // portion of lastRef and rawOutput.
        const OVERLAP =
            // 32 chars for the probe window — keep them unique so indexOf
            // returns the correct position and not an earlier false hit.
            "1234567890ABCDEFGHIJKLMNOPQRSTUV" +
            // 48 more chars for the verification window.
            "WXYZabcdefghijklmnopqrstuvwxyz!@#$%^&*()-_+=[]{}";
        const PREFIX = "AAA"; // bytes trimmed from the front
        const initial = PREFIX + OVERLAP;
        // postTruncation = initial.slice(PREFIX.length) + newChunk
        // — same length, does not start with initial.
        const postTruncation = OVERLAP + "XYZ";

        const { rerender } = renderComponent(
            <TerminalViewport
                session={createSessionView({ rawOutput: initial })}
            />,
        );
        await flushPromises();

        const [term] = getXtermMockInstances();
        if (!term) throw new Error("No xterm instance");

        // Spy after the initial render — which legitimately calls reset once
        // for the new session — so we only count resets during truncation.
        const resetSpy = vi.spyOn(term, "reset");

        rerender(
            <TerminalViewport
                session={createSessionView({ rawOutput: postTruncation })}
            />,
        );
        await flushPromises();

        expect(resetSpy).not.toHaveBeenCalled();
        // The new tail must reach xterm without a full rewrite.
        expect(term.screen?.textContent).toContain("XYZ");
    });

    it("writes the new tail to xterm when output stops exactly at the truncation boundary", async () => {
        // Verify the tail bytes ("ENDOFOUTPUT") reach xterm even if no further
        // output arrives after the truncating write — ruling out any approach
        // that would skip writing the new chunk on truncation.
        const OVERLAP =
            "1234567890ABCDEFGHIJKLMNOPQRSTUV" +
            "WXYZabcdefghijklmnopqrstuvwxyz!@#$%^&*()-_+=[]{}";
        const PREFIX = "AAA";
        const TAIL = "ENDOFOUTPUT";
        const initial = PREFIX + OVERLAP;
        const postTruncation = OVERLAP + TAIL;

        const { rerender } = renderComponent(
            <TerminalViewport
                session={createSessionView({ rawOutput: initial })}
            />,
        );
        await flushPromises();

        rerender(
            <TerminalViewport
                session={createSessionView({ rawOutput: postTruncation })}
            />,
        );
        await flushPromises();

        const [term] = getXtermMockInstances();
        if (!term) throw new Error("No xterm instance");

        expect(term.screen?.textContent).toContain(TAIL);
    });

    it("writes the new tail without reset when the overlap region is plain repeated characters", async () => {
        // Covers the case where a terminal outputs monotonous content (progress
        // bars, spinner lines, repeated padding) so the overlap between lastRef
        // and rawOutput is all the same character.  The unique prefix before the
        // repeated block ensures the probe's first indexOf hit lands at the true
        // truncation offset, not at a false-positive earlier position.
        //
        // Geometry assumes PROBE_LEN=32.  The probe is "a"*32; PREFIX has no
        // 'a', so the first indexOf hit in searchArea is at the true offset.
        //
        // Length invariant: postTruncation.length must be >= initial.length so
        // the rawOutput.length >= lastRef.length gate is satisfied and the probe
        // path is entered.  We preserve length by adding as many tail chars as
        // were trimmed from the front.
        const PREFIX = "UNIQUE_PREF"; // 11 unique non-'a' chars, trimmed by the cap
        const OVERLAP = "a".repeat(200); // repeated content — the probe "a"*32 lives here
        const TAIL = "N".repeat(PREFIX.length); // same length as PREFIX to keep total length equal
        const initial = PREFIX + OVERLAP; // 211 chars
        const postTruncation = OVERLAP + TAIL; // 211 chars — does not start with initial

        const { rerender } = renderComponent(
            <TerminalViewport
                session={createSessionView({ rawOutput: initial })}
            />,
        );
        await flushPromises();

        const [term] = getXtermMockInstances();
        if (!term) throw new Error("No xterm instance");

        // Spy after the initial render (which legitimately resets for the new
        // session) so we only count resets that happen during truncation.
        const resetSpy = vi.spyOn(term, "reset");

        rerender(
            <TerminalViewport
                session={createSessionView({ rawOutput: postTruncation })}
            />,
        );
        await flushPromises();

        expect(resetSpy).not.toHaveBeenCalled();
        // Exact screen state: initial content (written on first render) followed
        // by only the delta tail — not a full reset+rewrite of postTruncation.
        // If reset+replay had fired, PREFIX would be absent (reset clears screen,
        // then the full replay starts with OVERLAP).
        expect(term.screen?.textContent).toBe(initial + TAIL);
    });

    it("falls back to full reset when the probe hits an earlier repeated-content position and verification rejects it", async () => {
        // When rawOutput starts with a repeated pattern that also appears
        // earlier in lastRef, indexOf finds the wrong (earlier) offset.  The
        // 32-char verification window catches the mismatch and the code falls
        // through to terminal.reset() + full replay — no silent output drop.
        //
        // Geometry assumes PROBE_LEN=32.
        //
        // Layout (all lengths preserved so the length gate is satisfied):
        //   initial     = "a"*100  +  SEPARATOR  +  "a"*100   (213 chars)
        //   postTrunc   = "a"*40   +  SEPARATOR  +  "a"*100  +  "N"*60  (213 chars)
        //
        // Probe = "a"*32.  searchArea = initial[1:] starts with "a"*99 so the
        // first indexOf hit is at index 0 → delta = 1 (wrong; true offset = 60).
        // Verification: initial[33:65] = "a"*32 but postTrunc[32:64] contains
        // SEPARATOR (which starts at index 40), so the windows differ and the
        // verification step rejects the early hit.
        //
        // SEPARATOR must appear within postTrunc[32:64] (starts at 40, ends at
        // 52) — i.e. it must start after the 32-char probe window AND end before
        // index 64.  Shifting it entirely before index 32 would put it inside the
        // probe (changing the probe content), and shifting it past index 64 would
        // place it outside the verification window and allow a false acceptance.
        const SEPARATOR = "SEP_UNIQUE_XZ"; // 13 chars, no 'a', starts at postTrunc[40]
        const initial =
            "a".repeat(100) + SEPARATOR + "a".repeat(100); // 213 chars
        const postTruncation =
            initial.slice(60) + "N".repeat(60); // 153 + 60 = 213 chars

        const { rerender } = renderComponent(
            <TerminalViewport
                session={createSessionView({ rawOutput: initial })}
            />,
        );
        await flushPromises();

        const [term] = getXtermMockInstances();
        if (!term) throw new Error("No xterm instance");

        const resetSpy = vi.spyOn(term, "reset");

        rerender(
            <TerminalViewport
                session={createSessionView({ rawOutput: postTruncation })}
            />,
        );
        await flushPromises();

        // Verification rejected the early probe hit → graceful reset fallback.
        expect(resetSpy).toHaveBeenCalledOnce();
        // Exact screen state after reset+full replay: postTruncation in full.
        // toContain alone would miss a regression where only part of the output
        // was replayed after the reset.
        expect(term.screen?.textContent).toBe(postTruncation);
    });
});
