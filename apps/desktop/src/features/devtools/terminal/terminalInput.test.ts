import { describe, expect, it } from "vitest";
import { translateTerminalKeyEvent } from "./terminalInput";

function eventFor(
    overrides: Partial<Parameters<typeof translateTerminalKeyEvent>[0]>,
) {
    return {
        key: "",
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
        ...overrides,
    };
}

describe("translateTerminalKeyEvent", () => {
    it("maps arrow keys without modifiers to standard escape codes", () => {
        expect(translateTerminalKeyEvent(eventFor({ key: "ArrowUp" }))).toBe(
            "\u001b[A",
        );
        expect(
            translateTerminalKeyEvent(eventFor({ key: "ArrowRight" })),
        ).toBe("\u001b[C");
    });

    it("maps navigation keys with modifiers", () => {
        expect(
            translateTerminalKeyEvent(
                eventFor({ key: "ArrowLeft", ctrlKey: true }),
            ),
        ).toBe("\u001b[1;5D");
        expect(
            translateTerminalKeyEvent(
                eventFor({ key: "Delete", altKey: true }),
            ),
        ).toBe("\u001b[3;3~");
    });

    it("supports common ctrl combinations", () => {
        expect(
            translateTerminalKeyEvent(eventFor({ key: "c", ctrlKey: true })),
        ).toBe("\u0003");
        expect(
            translateTerminalKeyEvent(eventFor({ key: "2", ctrlKey: true })),
        ).toBe("\u0000");
    });

    it("prefixes printable alt combinations with escape", () => {
        expect(
            translateTerminalKeyEvent(eventFor({ key: "f", altKey: true })),
        ).toBe("\u001bf");
    });

    it("ignores meta-modified shortcuts", () => {
        expect(
            translateTerminalKeyEvent(eventFor({ key: "k", metaKey: true })),
        ).toBeNull();
    });
});
