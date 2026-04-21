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
        expect(formatShortcutAction("new_agent", "macos")).toBe("⌘⇧N");
        expect(formatShortcutAction("new_agent", "windows")).toBe(
            "Ctrl+Shift+N",
        );
        expect(formatShortcutAction("zoom_in", "macos")).toBe("⌘=");
        expect(formatShortcutAction("zoom_out", "windows")).toBe("Ctrl+-");
        expect(formatShortcutAction("reset_zoom", "macos")).toBe("⌘0");
        expect(formatShortcutAction("open_settings", "windows")).toBe("Ctrl+,");
        expect(formatShortcutAction("reopen_closed_tab", "macos")).toBe("⌘⇧T");
        expect(formatShortcutAction("reopen_closed_tab", "windows")).toBe(
            "Ctrl+Shift+T",
        );
        expect(formatShortcutAction("find_in_note", "windows")).toBe("Ctrl+F");
        expect(formatShortcutAction("go_back", "windows")).toBe("Ctrl+[");
        expect(formatShortcutAction("go_forward", "macos")).toBe("⌘]");
        expect(formatShortcutAction("heading_1", "windows")).toBe("Ctrl+1");
        expect(formatShortcutAction("remove_heading", "windows")).toBe(
            "Ctrl+Shift+0",
        );
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
        expect(entries.find((entry) => entry.id === "new_agent")).toMatchObject(
            {
                label: "New Agent",
                category: "AI",
                shortcut: "Ctrl+Shift+N",
            },
        );
        expect(entries.find((entry) => entry.id === "zoom_in")).toMatchObject({
            label: "Zoom In",
            category: "View",
            shortcut: "Ctrl+=",
        });
        expect(
            entries.find((entry) => entry.id === "find_in_note"),
        ).toMatchObject({
            label: "Find in Note",
            category: "Editor",
            shortcut: "Ctrl+F",
        });
        expect(
            entries.find((entry) => entry.id === "remove_heading"),
        ).toMatchObject({
            label: "Remove Heading",
            category: "Editor",
            shortcut: "Ctrl+Shift+0",
        });
        expect(
            entries.find((entry) => entry.id === "add_selection_to_chat"),
        ).toMatchObject({
            label: "Add Selection to Chat",
            category: "AI",
            shortcut: "Ctrl+L",
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
        expect(getCodeMirrorShortcut("find_in_note", "windows")).toBe("Mod-f");
        expect(getCodeMirrorShortcut("heading_1", "macos")).toBe("Mod-1");
        expect(getCodeMirrorShortcut("remove_heading", "windows")).toBe(
            "Mod-Shift-0",
        );
        expect(getCodeMirrorShortcut("add_selection_to_chat", "windows")).toBe(
            "Mod-l",
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

    it("matches reopen closed tab on both platforms", () => {
        const macEvent = new KeyboardEvent("keydown", {
            key: "T",
            metaKey: true,
            shiftKey: true,
        });
        const windowsEvent = new KeyboardEvent("keydown", {
            key: "t",
            ctrlKey: true,
            shiftKey: true,
        });

        expect(
            matchesShortcutAction(macEvent, "reopen_closed_tab", "macos"),
        ).toBe(true);
        expect(
            matchesShortcutAction(windowsEvent, "reopen_closed_tab", "windows"),
        ).toBe(true);
    });

    it("matches new agent on both platforms", () => {
        const macEvent = new KeyboardEvent("keydown", {
            key: "N",
            metaKey: true,
            shiftKey: true,
        });
        const windowsEvent = new KeyboardEvent("keydown", {
            key: "n",
            ctrlKey: true,
            shiftKey: true,
        });

        expect(matchesShortcutAction(macEvent, "new_agent", "macos")).toBe(
            true,
        );
        expect(
            matchesShortcutAction(windowsEvent, "new_agent", "windows"),
        ).toBe(true);
    });

    it("matches zoom in aliases on both platforms", () => {
        const macEvent = new KeyboardEvent("keydown", {
            key: "+",
            metaKey: true,
            shiftKey: true,
        });
        const windowsEvent = new KeyboardEvent("keydown", {
            key: "+",
            ctrlKey: true,
            shiftKey: true,
        });

        expect(matchesShortcutAction(macEvent, "zoom_in", "macos")).toBe(true);
        expect(matchesShortcutAction(windowsEvent, "zoom_in", "windows")).toBe(
            true,
        );
    });

    it("matches reset zoom on both platforms", () => {
        const macEvent = new KeyboardEvent("keydown", {
            key: "0",
            metaKey: true,
        });
        const windowsEvent = new KeyboardEvent("keydown", {
            key: "0",
            ctrlKey: true,
        });

        expect(matchesShortcutAction(macEvent, "reset_zoom", "macos")).toBe(
            true,
        );
        expect(
            matchesShortcutAction(windowsEvent, "reset_zoom", "windows"),
        ).toBe(true);
    });

    it("matches navigation and editor-only shortcuts from the shared registry", () => {
        expect(
            matchesShortcutAction(
                new KeyboardEvent("keydown", { key: "[", ctrlKey: true }),
                "go_back",
                "windows",
            ),
        ).toBe(true);
        expect(
            matchesShortcutAction(
                new KeyboardEvent("keydown", { key: "]", metaKey: true }),
                "go_forward",
                "macos",
            ),
        ).toBe(true);
        expect(
            matchesShortcutAction(
                new KeyboardEvent("keydown", {
                    key: "0",
                    ctrlKey: true,
                    shiftKey: true,
                }),
                "remove_heading",
                "windows",
            ),
        ).toBe(true);
    });
});
