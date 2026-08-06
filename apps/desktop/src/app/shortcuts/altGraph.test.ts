import { describe, expect, it, vi } from "vitest";
import { AltGraphTracker } from "./altGraph";

function keyboardEvent(
    overrides: Partial<
        Pick<
            KeyboardEvent,
            "key" | "code" | "ctrlKey" | "altKey" | "getModifierState"
        >
    > = {},
) {
    return {
        key: "q",
        code: "KeyQ",
        ctrlKey: false,
        altKey: false,
        getModifierState: vi.fn(() => false),
        ...overrides,
    };
}

describe("AltGraphTracker", () => {
    it("ignores AltGraph reported by Windows and Linux keyboard events", () => {
        for (const platform of ["windows", "linux"] as const) {
            const tracker = new AltGraphTracker();
            expect(
                tracker.shouldIgnoreKeyDown(
                    keyboardEvent({
                        key: "@",
                        ctrlKey: true,
                        altKey: true,
                        getModifierState: vi.fn(
                            (modifier) => modifier === "AltGraph",
                        ),
                    }),
                    platform,
                ),
            ).toBe(true);
        }
    });

    it("tracks explicit AltGraph until the modifier is released", () => {
        const tracker = new AltGraphTracker();
        expect(
            tracker.shouldIgnoreKeyDown(
                keyboardEvent({
                    key: "AltGraph",
                    code: "AltRight",
                    ctrlKey: true,
                    altKey: true,
                }),
                "windows",
            ),
        ).toBe(true);
        expect(
            tracker.shouldIgnoreKeyDown(
                keyboardEvent({ key: "@", ctrlKey: true, altKey: true }),
                "windows",
            ),
        ).toBe(true);

        tracker.handleKeyUp(
            keyboardEvent({ key: "Alt", code: "AltRight" }),
            "windows",
        );
        expect(
            tracker.shouldIgnoreKeyDown(
                keyboardEvent({ ctrlKey: true, altKey: true }),
                "windows",
            ),
        ).toBe(false);
    });

    it("keeps physical Ctrl+Right Alt available for shortcuts", () => {
        const tracker = new AltGraphTracker();
        expect(
            tracker.shouldIgnoreKeyDown(
                keyboardEvent({
                    key: "Alt",
                    code: "AltRight",
                    ctrlKey: true,
                    altKey: true,
                }),
                "windows",
            ),
        ).toBe(false);
        expect(
            tracker.shouldIgnoreKeyDown(
                keyboardEvent({ ctrlKey: true, altKey: true }),
                "windows",
            ),
        ).toBe(false);
    });

    it("keeps physical left Ctrl+Alt available for shortcuts", () => {
        const tracker = new AltGraphTracker();
        expect(
            tracker.shouldIgnoreKeyDown(
                keyboardEvent({ ctrlKey: true, altKey: true }),
                "linux",
            ),
        ).toBe(false);
    });

    it("does not treat Option events as AltGraph on macOS", () => {
        const tracker = new AltGraphTracker();
        expect(
            tracker.shouldIgnoreKeyDown(
                keyboardEvent({
                    key: "@",
                    code: "AltRight",
                    ctrlKey: true,
                    altKey: true,
                    getModifierState: vi.fn(() => true),
                }),
                "macos",
            ),
        ).toBe(false);
    });

    it("clears tracked state explicitly", () => {
        const tracker = new AltGraphTracker();
        tracker.shouldIgnoreKeyDown(
            keyboardEvent({ key: "AltGraph", code: "AltRight" }),
            "windows",
        );
        tracker.reset();

        expect(
            tracker.shouldIgnoreKeyDown(keyboardEvent(), "windows"),
        ).toBe(false);
    });
});
