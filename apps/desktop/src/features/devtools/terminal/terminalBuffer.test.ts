import { describe, expect, it } from "vitest";
import {
    applyTerminalChunk,
    createTerminalBufferState,
    renderTerminalBuffer,
    renderTerminalBufferWithCursor,
} from "./terminalBuffer";

describe("terminalBuffer", () => {
    it("moves cursor left on backspace without deleting", () => {
        const state = applyTerminalChunk(createTerminalBufferState(), "hola\b");

        // \b only moves cursor left — 'a' remains in the buffer
        expect(renderTerminalBuffer(state)).toBe("hola");
        expect(state.col).toBe(3);
    });

    it("overwrites character after backspace when new char is written", () => {
        const state = applyTerminalChunk(
            createTerminalBufferState(),
            "hola\bX",
        );

        // \b moves cursor to col 3, then X overwrites 'a'
        expect(renderTerminalBuffer(state)).toBe("holX");
    });

    it("renders the cursor at the current column after backspace", () => {
        const state = applyTerminalChunk(createTerminalBufferState(), "hola\b");

        expect(renderTerminalBufferWithCursor(state)).toEqual({
            before: "hol",
            cursor: "a",
            after: "",
        });
    });

    it("supports carriage return and erase-to-end-of-line", () => {
        const state = applyTerminalChunk(
            createTerminalBufferState(),
            "prompt old\rprompt \u001b[K",
        );

        expect(renderTerminalBuffer(state)).toBe("prompt ");
    });

    it("handles escape sequences split across chunks", () => {
        const first = applyTerminalChunk(
            createTerminalBufferState(),
            "prompt old\rprompt \u001b[",
        );
        const second = applyTerminalChunk(first, "K");

        expect(renderTerminalBuffer(second)).toBe("prompt ");
    });

    it("moves the cursor left before overwriting characters", () => {
        const state = applyTerminalChunk(
            createTerminalBufferState(),
            "abcd\u001b[2DXY",
        );

        expect(renderTerminalBuffer(state)).toBe("abXY");
    });

    it("expands tabs to the next stop", () => {
        const state = applyTerminalChunk(createTerminalBufferState(), "a\tb");

        expect(renderTerminalBuffer(state)).toBe("a       b");
    });

    it("wraps long lines using the terminal column count", () => {
        const state = applyTerminalChunk(
            createTerminalBufferState(),
            "123456789",
        );

        expect(renderTerminalBuffer(state, 4)).toBe("1234\n5678\n9");
    });

    it("restores the cursor after save and restore sequences", () => {
        const state = applyTerminalChunk(
            createTerminalBufferState(),
            "abc\u001b[sXX\u001b[uZ",
        );

        expect(renderTerminalBuffer(state)).toBe("abcZX");
    });

    it("handles double-width characters during wrapping", () => {
        const state = applyTerminalChunk(createTerminalBufferState(), "ab🙂cd");

        expect(renderTerminalBuffer(state, 4)).toBe("ab🙂\ncd");
    });

    it("renders the cursor at the end of a wrapped line", () => {
        const state = applyTerminalChunk(createTerminalBufferState(), "123456");

        expect(renderTerminalBufferWithCursor(state, 4)).toEqual({
            before: "1234\n56",
            cursor: " ",
            after: "",
        });
    });
});
