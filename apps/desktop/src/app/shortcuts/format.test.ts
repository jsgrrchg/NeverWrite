import { describe, expect, it } from "vitest";
import { formatShortcutAction, matchesShortcutAction } from "./format";
import {
    formatPrimaryShortcut,
    getCodeMirrorShortcut,
    getShortcutSettingsEntries,
} from "./registry";

describe("shortcut registry formatting", () => {
    it("formats platform-specific labels from the shared registry", () => {
        expect(formatShortcutAction("command_palette", "macos")).toBe("⌘K");
        expect(formatShortcutAction("command_palette", "windows")).toBe(
            "Ctrl+Shift+P",
        );
        expect(formatShortcutAction("quick_switcher", "windows")).toBe(
            "Ctrl+O",
        );
        expect(formatShortcutAction("open_settings", "windows")).toBe("Ctrl+,");
    });

    it("builds Settings entries from the same registry for Windows", () => {
        const entries = getShortcutSettingsEntries("windows");
        expect(
            entries.find((entry) => entry.id === "quick_switcher"),
        ).toMatchObject({
            label: "Quick Switcher",
            category: "Navigation",
            shortcut: "Ctrl+O",
        });
        expect(
            entries.find((entry) => entry.id === "open_settings"),
        ).toMatchObject({
            label: "Open Settings",
            category: "View",
            shortcut: "Ctrl+,",
        });
    });

    it("keeps editor bindings compatible with CodeMirror on both platforms", () => {
        expect(getCodeMirrorShortcut("bold_selection", "macos")).toBe("Mod-b");
        expect(getCodeMirrorShortcut("bold_selection", "windows")).toBe(
            "Mod-b",
        );
        expect(getCodeMirrorShortcut("highlight_selection", "macos")).toBe(
            "Mod-Shift-h",
        );
    });

    it("formats platform-specific local hints from the same helper layer", () => {
        expect(formatPrimaryShortcut("L", "macos")).toBe("⌘L");
        expect(formatPrimaryShortcut("L", "windows")).toBe("Ctrl+L");
        expect(formatPrimaryShortcut("Enter", "windows")).toBe("Ctrl+Enter");
    });
});

describe("shortcut registry matching", () => {
    it("matches the primary command palette shortcut on macOS", () => {
        const macPaletteEvent = new KeyboardEvent("keydown", {
            key: "k",
            metaKey: true,
        });
        const windowsPaletteEvent = new KeyboardEvent("keydown", {
            key: "p",
            ctrlKey: true,
            shiftKey: true,
        });

        expect(
            matchesShortcutAction(macPaletteEvent, "command_palette", "macos"),
        ).toBe(true);
        expect(
            matchesShortcutAction(
                windowsPaletteEvent,
                "command_palette",
                "macos",
            ),
        ).toBe(false);
    });

    it("matches Windows bindings without accepting macOS-only alternatives", () => {
        const paletteEvent = new KeyboardEvent("keydown", {
            key: "P",
            ctrlKey: true,
            shiftKey: true,
        });
        const quickSwitcherEvent = new KeyboardEvent("keydown", {
            key: "o",
            ctrlKey: true,
        });
        const legacyMacStyleEvent = new KeyboardEvent("keydown", {
            key: "k",
            ctrlKey: true,
        });
        const legacyQuickSwitcherEvent = new KeyboardEvent("keydown", {
            key: "p",
            ctrlKey: true,
        });

        expect(
            matchesShortcutAction(paletteEvent, "command_palette", "windows"),
        ).toBe(true);
        expect(
            matchesShortcutAction(
                quickSwitcherEvent,
                "quick_switcher",
                "windows",
            ),
        ).toBe(true);
        expect(
            matchesShortcutAction(
                legacyMacStyleEvent,
                "command_palette",
                "windows",
            ),
        ).toBe(false);
        expect(
            matchesShortcutAction(
                legacyQuickSwitcherEvent,
                "quick_switcher",
                "windows",
            ),
        ).toBe(false);
    });

    it("keeps the legacy macOS alias for previous tab while exposing the primary label", () => {
        const primaryEvent = new KeyboardEvent("keydown", {
            key: "t",
            metaKey: true,
            altKey: true,
        });
        const aliasEvent = new KeyboardEvent("keydown", {
            key: "Tab",
            ctrlKey: true,
            shiftKey: true,
        });

        expect(formatShortcutAction("previous_tab", "macos")).toBe("⌘⌥T");
        expect(
            matchesShortcutAction(primaryEvent, "previous_tab", "macos"),
        ).toBe(true);
        expect(matchesShortcutAction(aliasEvent, "previous_tab", "macos")).toBe(
            true,
        );
    });
});
