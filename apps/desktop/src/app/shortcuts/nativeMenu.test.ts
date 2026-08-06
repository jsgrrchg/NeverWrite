import { beforeEach, describe, expect, it } from "vitest";
import { setShortcutOverride } from "./preferences";
import {
    formatNativeMenuAccelerator,
    getNativeMenuShortcutAccelerators,
} from "./nativeMenu";

beforeEach(() => {
    localStorage.clear();
});

describe("native menu shortcut accelerators", () => {
    it("formats effective macOS bindings for configurable menu commands", () => {
        expect(getNativeMenuShortcutAccelerators("macos")).toMatchObject({
            "nav:command-palette": "Command+K",
            "nav:next-tab": "Control+Tab",
            "nav:previous-tab": "Command+Alt+T",
            "vault:search": "Command+Shift+F",
        });

        setShortcutOverride("command_palette", "macos", {
            key: "Y",
            modifiers: ["meta", "alt"],
        });

        expect(
            getNativeMenuShortcutAccelerators("macos")[
                "nav:command-palette"
            ],
        ).toBe("Command+Alt+Y");
    });

    it("returns no native accelerator for keys Electron cannot represent", () => {
        expect(
            formatNativeMenuAccelerator({
                key: "AudioVolumeUp",
                modifiers: ["meta"],
            }),
        ).toBeNull();
        expect(
            formatNativeMenuAccelerator({
                key: "é",
                modifiers: ["meta"],
            }),
        ).toBeNull();
    });

    it("uses Electron's Plus key name instead of an empty accelerator token", () => {
        expect(
            formatNativeMenuAccelerator({
                key: "+",
                modifiers: ["meta", "shift"],
            }),
        ).toBe("Command+Shift+Plus");
    });
});
