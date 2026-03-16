const ESC = "\u001b";
const BEL = "\u0007";
const MAX_OUTPUT_CHARS = 200_000;
const TAB_WIDTH = 8;
const COMBINING_MARK_PATTERN = /\p{Mark}/u;

export interface TerminalBufferState {
    lines: string[];
    row: number;
    col: number;
    pending: string;
    savedRow: number;
    savedCol: number;
}

export function createTerminalBufferState(): TerminalBufferState {
    return {
        lines: [""],
        row: 0,
        col: 0,
        pending: "",
        savedRow: 0,
        savedCol: 0,
    };
}

export function applyTerminalChunk(
    previous: TerminalBufferState,
    chunk: string,
): TerminalBufferState {
    const state: TerminalBufferState = {
        lines: [...previous.lines],
        row: previous.row,
        col: previous.col,
        pending: "",
        savedRow: previous.savedRow,
        savedCol: previous.savedCol,
    };
    const input = previous.pending + chunk;
    let index = 0;

    while (index < input.length) {
        const char = input[index] === ESC ? ESC : readCodePoint(input, index);

        if (char === ESC) {
            const parsed = parseEscapeSequence(input, index, state);
            if (parsed === null) {
                state.pending = input.slice(index);
                break;
            }
            index = parsed;
            continue;
        }

        index += char.length;

        switch (char) {
            case "\r":
                state.col = 0;
                break;
            case "\n":
                state.row += 1;
                state.col = 0;
                ensureLine(state);
                break;
            case "\t":
                writeTab(state);
                break;
            case "\b":
            case "\u007f":
                if (state.col > 0) {
                    state.col -= 1;
                }
                break;
            default:
                if (isPrintable(char)) {
                    writeChar(state, char);
                }
                break;
        }
    }

    return trimBuffer(state);
}

export function renderTerminalBuffer(
    state: TerminalBufferState,
    cols = Number.MAX_SAFE_INTEGER,
): string {
    const wrappedLines: string[] = [];
    for (const line of state.lines) {
        wrappedLines.push(...wrapLine(line, cols));
    }
    return wrappedLines.join("\n");
}

export function renderTerminalBufferWithCursor(
    state: TerminalBufferState,
    cols = Number.MAX_SAFE_INTEGER,
): { before: string; cursor: string; after: string } {
    const wrappedLines: string[] = [];
    let cursorWrappedRow = 0;
    let cursorWrappedCol = 0;
    let wrappedRowOffset = 0;

    for (let lineIndex = 0; lineIndex < state.lines.length; lineIndex += 1) {
        const line = state.lines[lineIndex];
        const { lines, cursorRow, cursorCol } = wrapLineWithCursor(
            line,
            lineIndex === state.row ? state.col : null,
            cols,
        );
        wrappedLines.push(...lines);
        if (lineIndex === state.row) {
            cursorWrappedRow = wrappedRowOffset + cursorRow;
            cursorWrappedCol = cursorCol;
        }
        wrappedRowOffset += lines.length;
    }

    const safeRow = Math.max(
        0,
        Math.min(cursorWrappedRow, Math.max(0, wrappedLines.length - 1)),
    );
    const targetLine = wrappedLines[safeRow] ?? "";
    const targetChars = Array.from(targetLine);
    const safeCol = Math.max(0, Math.min(cursorWrappedCol, targetChars.length));
    const beforeLines = wrappedLines.slice(0, safeRow);
    const afterLines = wrappedLines.slice(safeRow + 1);
    const beforeCurrentLine = targetChars.slice(0, safeCol).join("");
    const cursor =
        targetChars[safeCol] ??
        (safeCol === 0 && targetLine.length === 0 ? " " : " ");
    const afterCurrentLine = targetChars.slice(safeCol + 1).join("");
    const before =
        (beforeLines.length > 0 ? `${beforeLines.join("\n")}\n` : "") +
        beforeCurrentLine;
    const after =
        afterCurrentLine +
        (afterLines.length > 0 ? `\n${afterLines.join("\n")}` : "");

    return { before, cursor, after };
}

function parseEscapeSequence(
    input: string,
    start: number,
    state: TerminalBufferState,
): number | null {
    const nextIndex = start + 1;
    if (nextIndex >= input.length) {
        return null;
    }

    const marker = input[nextIndex];
    if (marker === "[") {
        return parseCsiSequence(input, start, state);
    }
    if (marker === "]") {
        return parseOscSequence(input, start);
    }
    if (marker === "7") {
        saveCursor(state);
        return start + 2;
    }
    if (marker === "8") {
        restoreCursor(state);
        return start + 2;
    }

    return Math.min(input.length, start + 2);
}

function parseCsiSequence(
    input: string,
    start: number,
    state: TerminalBufferState,
): number | null {
    let cursor = start + 2;
    while (cursor < input.length) {
        const code = input.charCodeAt(cursor);
        if (code >= 0x40 && code <= 0x7e) {
            const finalChar = input[cursor];
            const rawParams = input.slice(start + 2, cursor);
            applyCsiSequence(state, rawParams, finalChar);
            return cursor + 1;
        }
        cursor += 1;
    }

    return null;
}

function parseOscSequence(input: string, start: number): number | null {
    let cursor = start + 2;
    while (cursor < input.length) {
        const char = input[cursor];
        if (char === BEL) {
            return cursor + 1;
        }
        if (
            char === ESC &&
            cursor + 1 < input.length &&
            input[cursor + 1] === "\\"
        ) {
            return cursor + 2;
        }
        cursor += 1;
    }

    return null;
}

function applyCsiSequence(
    state: TerminalBufferState,
    rawParams: string,
    finalChar: string,
) {
    const normalized = rawParams.replace(/^\?/, "");
    const params = normalized
        .split(";")
        .filter((part) => part.length > 0)
        .map((part) => Number.parseInt(part, 10))
        .filter((value) => Number.isFinite(value));

    switch (finalChar) {
        case "A":
            state.row = Math.max(0, state.row - getParam(params, 0, 1));
            ensureLine(state);
            return;
        case "B":
            state.row += getParam(params, 0, 1);
            ensureLine(state);
            return;
        case "C":
            state.col += getParam(params, 0, 1);
            clampCursor(state);
            return;
        case "D":
            state.col = Math.max(0, state.col - getParam(params, 0, 1));
            return;
        case "E":
            state.row += getParam(params, 0, 1);
            state.col = 0;
            ensureLine(state);
            return;
        case "F":
            state.row = Math.max(0, state.row - getParam(params, 0, 1));
            state.col = 0;
            ensureLine(state);
            return;
        case "G":
            state.col = Math.max(0, getParam(params, 0, 1) - 1);
            clampCursor(state);
            return;
        case "H":
        case "f":
            state.row = Math.max(0, getParam(params, 0, 1) - 1);
            state.col = Math.max(0, getParam(params, 1, 1) - 1);
            ensureLine(state);
            clampCursor(state);
            return;
        case "J":
            eraseInDisplay(state, getParam(params, 0, 0));
            return;
        case "K":
            eraseInLine(state, getParam(params, 0, 0));
            return;
        case "P":
            deleteChars(state, getParam(params, 0, 1));
            return;
        case "X":
            eraseChars(state, getParam(params, 0, 1));
            return;
        case "d":
            state.row = Math.max(0, getParam(params, 0, 1) - 1);
            ensureLine(state);
            clampCursor(state);
            return;
        case "m":
            return;
        case "s":
            saveCursor(state);
            return;
        case "u":
            restoreCursor(state);
            return;
        default:
            return;
    }
}

function eraseInDisplay(state: TerminalBufferState, mode: number) {
    ensureLine(state);
    if (mode === 2 || mode === 3) {
        state.lines = [""];
        state.row = 0;
        state.col = 0;
        return;
    }

    if (mode === 1) {
        for (let index = 0; index < state.row; index += 1) {
            state.lines[index] = "";
        }
        const chars = Array.from(state.lines[state.row] ?? "");
        const eraseUpTo = Math.min(chars.length, state.col + 1);
        state.lines[state.row] =
            " ".repeat(eraseUpTo) + chars.slice(eraseUpTo).join("");
        return;
    }

    const chars = Array.from(state.lines[state.row] ?? "");
    state.lines[state.row] = chars
        .slice(0, toCharIndex(chars, state.col))
        .join("");
    state.lines = state.lines.slice(0, state.row + 1);
}

function eraseInLine(state: TerminalBufferState, mode: number) {
    ensureLine(state);
    const chars = Array.from(state.lines[state.row] ?? "");
    const splitIndex = toCharIndex(chars, state.col);

    if (mode === 2) {
        state.lines[state.row] = "";
        return;
    }

    if (mode === 1) {
        const eraseUpTo = Math.min(chars.length, splitIndex + 1);
        state.lines[state.row] =
            " ".repeat(eraseUpTo) + chars.slice(eraseUpTo).join("");
        return;
    }

    state.lines[state.row] = chars.slice(0, splitIndex).join("");
}

function deleteChars(state: TerminalBufferState, count: number) {
    ensureLine(state);
    const line = state.lines[state.row] ?? "";
    const chars = Array.from(line);
    const start = Math.min(chars.length, state.col);
    if (start >= chars.length) {
        return;
    }

    chars.splice(start, Math.max(1, count));
    state.lines[state.row] = chars.join("");
}

function eraseChars(state: TerminalBufferState, count: number) {
    ensureLine(state);
    const line = state.lines[state.row] ?? "";
    const chars = Array.from(line);
    const start = Math.min(chars.length, state.col);
    if (start >= chars.length) {
        return;
    }

    for (
        let index = 0;
        index < Math.max(1, count) && start + index < chars.length;
        index += 1
    ) {
        chars[start + index] = " ";
    }
    state.lines[state.row] = chars.join("");
}

function writeChar(state: TerminalBufferState, char: string) {
    ensureLine(state);
    const line = state.lines[state.row] ?? "";
    const chars = Array.from(line);
    while (chars.length < state.col) {
        chars.push(" ");
    }

    chars[state.col] = char;
    state.lines[state.row] = chars.join("");
    state.col += 1;
}

function writeTab(state: TerminalBufferState) {
    const spaces = TAB_WIDTH - (state.col % TAB_WIDTH || 0);
    for (let index = 0; index < spaces; index += 1) {
        writeChar(state, " ");
    }
}

function saveCursor(state: TerminalBufferState) {
    state.savedRow = state.row;
    state.savedCol = state.col;
}

function restoreCursor(state: TerminalBufferState) {
    state.row = Math.max(0, state.savedRow);
    state.col = Math.max(0, state.savedCol);
    ensureLine(state);
    clampCursor(state);
}

function wrapLine(line: string, cols: number): string[] {
    return wrapLineWithCursor(line, null, cols).lines;
}

function wrapLineWithCursor(
    line: string,
    cursorCol: number | null,
    cols: number,
): { lines: string[]; cursorRow: number; cursorCol: number } {
    if (line.length === 0) {
        return {
            lines: [""],
            cursorRow: 0,
            cursorCol: 0,
        };
    }

    if (!Number.isFinite(cols) || cols < 1) {
        return {
            lines: [line],
            cursorRow: 0,
            cursorCol:
                cursorCol === null
                    ? 0
                    : Math.min(cursorCol, Array.from(line).length),
        };
    }

    const wrapped: string[] = [];
    const chars = Array.from(line);
    const targetCursorCol =
        cursorCol === null
            ? null
            : Math.max(0, Math.min(cursorCol, chars.length));
    let segmentChars: string[] = [];
    let width = 0;
    let cursorRow = 0;
    let cursorColInRow = 0;

    const commitSegment = () => {
        wrapped.push(segmentChars.join(""));
        segmentChars = [];
        width = 0;
    };

    for (let charIndex = 0; charIndex < chars.length; charIndex += 1) {
        if (targetCursorCol === charIndex) {
            cursorRow = wrapped.length;
            cursorColInRow = segmentChars.length;
        }

        const char = chars[charIndex];
        const charWidth = getCharWidth(char);

        if (charWidth > 0 && width > 0 && width + charWidth > cols) {
            commitSegment();
            if (targetCursorCol === charIndex) {
                cursorRow = wrapped.length;
                cursorColInRow = 0;
            }
        }

        segmentChars.push(char);
        width += charWidth;

        if (width >= cols) {
            commitSegment();
        }
    }

    if (targetCursorCol === chars.length) {
        cursorRow = wrapped.length;
        cursorColInRow = segmentChars.length;
    }

    if (segmentChars.length > 0 || wrapped.length === 0) {
        wrapped.push(segmentChars.join(""));
    } else if (targetCursorCol === chars.length) {
        cursorRow = Math.max(0, wrapped.length - 1);
        cursorColInRow = Array.from(wrapped[cursorRow] ?? "").length;
    }

    return {
        lines: wrapped,
        cursorRow,
        cursorCol: cursorColInRow,
    };
}

function ensureLine(state: TerminalBufferState) {
    while (state.lines.length <= state.row) {
        state.lines.push("");
    }
}

function clampCursor(state: TerminalBufferState) {
    ensureLine(state);
    const maxCol = Array.from(state.lines[state.row] ?? "").length;
    state.col = Math.max(0, Math.min(state.col, maxCol));
}

function getParam(params: number[], index: number, fallback: number) {
    return params[index] && params[index] > 0 ? params[index] : fallback;
}

function isZeroWidthCodePoint(codePoint: number) {
    return (
        (codePoint >= 0x200b && codePoint <= 0x200f) ||
        codePoint === 0x2060 ||
        (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
    );
}

function isPrintable(char: string) {
    return char >= " " && char !== "\u007f";
}

function getCharWidth(char: string) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (isZeroWidthCodePoint(codePoint) || COMBINING_MARK_PATTERN.test(char)) {
        return 0;
    }

    if (
        codePoint >= 0x1100 &&
        (codePoint <= 0x115f ||
            codePoint === 0x2329 ||
            codePoint === 0x232a ||
            (codePoint >= 0x2e80 &&
                codePoint <= 0xa4cf &&
                codePoint !== 0x303f) ||
            (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
            (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
            (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
            (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
            (codePoint >= 0xff00 && codePoint <= 0xff60) ||
            (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
            (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
            (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
            (codePoint >= 0x20000 && codePoint <= 0x3fffd))
    ) {
        return 2;
    }

    return 1;
}

function toCharIndex(chars: string[], col: number) {
    return Math.min(chars.length, Math.max(0, col));
}

function trimBuffer(state: TerminalBufferState): TerminalBufferState {
    let totalChars = state.lines.reduce(
        (sum, line) => sum + Array.from(line).length + 1,
        0,
    );

    while (state.lines.length > 1 && totalChars > MAX_OUTPUT_CHARS) {
        const removed = state.lines.shift() ?? "";
        totalChars -= Array.from(removed).length + 1;
        state.row = Math.max(0, state.row - 1);
        state.savedRow = Math.max(0, state.savedRow - 1);
    }

    if (state.lines.length === 0) {
        state.lines = [""];
        state.row = 0;
        state.col = 0;
    }

    ensureLine(state);
    clampCursor(state);
    return state;
}

function readCodePoint(input: string, index: number) {
    const codePoint = input.codePointAt(index);
    return codePoint === undefined
        ? (input[index] ?? "")
        : String.fromCodePoint(codePoint);
}
