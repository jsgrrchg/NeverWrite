import { describe, expect, it } from "vitest";
import type { DesktopPlatform } from "../utils/platform";
import type { ShortcutModifier } from "./registry";
import {
    getReservedInteractionShortcut,
    RESERVED_INTERACTION_SHORTCUTS,
} from "./reservedInteractions";

const reservedCases: readonly [
    DesktopPlatform,
    string,
    readonly ShortcutModifier[],
    string,
][] = [
    ["macos", "c", ["meta"], "Copy"],
    ["macos", "v", ["meta"], "Paste"],
    ["macos", "x", ["meta"], "Cut"],
    ["macos", "a", ["meta"], "Select All"],
    ["macos", "z", ["meta"], "Undo"],
    ["macos", "y", ["meta"], "Redo"],
    ["macos", "z", ["meta", "shift"], "Redo"],
    ["macos", "v", ["meta", "shift"], "Paste without formatting"],
    ["macos", "v", ["meta", "alt", "shift"], "Paste and Match Style"],
    ["macos", "f", ["meta"], "Find in Note"],
    ["macos", "e", ["meta"], "Toggle Live Preview"],
    ["macos", "1", ["meta"], "Heading 1"],
    ["macos", "2", ["meta"], "Heading 2"],
    ["macos", "3", ["meta"], "Heading 3"],
    ["macos", "4", ["meta"], "Heading 4"],
    ["macos", "5", ["meta"], "Heading 5"],
    ["macos", "6", ["meta"], "Heading 6"],
    ["macos", "0", ["meta", "shift"], "Remove Heading"],
    ["macos", "b", ["meta"], "Bold Selection"],
    ["macos", "h", ["meta", "shift"], "Highlight Selection"],
    ["macos", "p", ["meta", "alt"], "Preview Link at Caret"],
    ["macos", "s", ["meta", "shift"], "Save Note"],
    ["macos", "l", ["meta"], "Add Selection to Chat"],
    ["windows", "c", ["ctrl"], "Copy"],
    ["windows", "v", ["ctrl"], "Paste"],
    ["windows", "x", ["ctrl"], "Cut"],
    ["windows", "a", ["ctrl"], "Select All"],
    ["windows", "z", ["ctrl"], "Undo"],
    ["windows", "y", ["ctrl"], "Redo"],
    ["windows", "z", ["ctrl", "shift"], "Redo"],
    ["windows", "c", ["ctrl", "shift"], "Copy in terminals"],
    [
        "windows",
        "v",
        ["ctrl", "shift"],
        "Paste without formatting or in terminals",
    ],
    ["windows", "Insert", ["ctrl"], "Copy"],
    ["windows", "Insert", ["shift"], "Paste"],
    ["windows", "Delete", ["shift"], "Cut"],
    ["windows", "f", ["ctrl"], "Find in Note"],
    ["windows", "e", ["ctrl"], "Toggle Live Preview"],
    ["windows", "1", ["ctrl"], "Heading 1"],
    ["windows", "2", ["ctrl"], "Heading 2"],
    ["windows", "3", ["ctrl"], "Heading 3"],
    ["windows", "4", ["ctrl"], "Heading 4"],
    ["windows", "5", ["ctrl"], "Heading 5"],
    ["windows", "6", ["ctrl"], "Heading 6"],
    ["windows", "0", ["ctrl", "shift"], "Remove Heading"],
    ["windows", "b", ["ctrl"], "Bold Selection"],
    ["windows", "h", ["ctrl", "shift"], "Highlight Selection"],
    ["windows", "p", ["ctrl", "alt"], "Preview Link at Caret"],
    ["windows", "s", ["ctrl", "shift"], "Save Note"],
    ["windows", "l", ["ctrl"], "Add Selection to Chat"],
];

describe("reserved interaction shortcuts", () => {
    it("keeps the agreed platform inventories complete", () => {
        expect(RESERVED_INTERACTION_SHORTCUTS.macos).toHaveLength(23);
        expect(RESERVED_INTERACTION_SHORTCUTS.windows).toHaveLength(26);
    });

    it.each(reservedCases)(
        "reserves %s %s with %j for %s",
        (platform, key, modifiers, label) => {
            expect(
                getReservedInteractionShortcut(
                    { key, modifiers: [...modifiers] },
                    platform,
                )?.label,
            ).toBe(label);
        },
    );

    it("uses the Windows interaction inventory on Linux", () => {
        expect(
            getReservedInteractionShortcut(
                { key: "c", modifiers: ["ctrl", "shift"] },
                "linux",
            )?.label,
        ).toBe("Copy in terminals");
    });

    it("allows nearby combinations that are not reserved interactions", () => {
        expect(
            getReservedInteractionShortcut(
                { key: "x", modifiers: ["ctrl", "shift"] },
                "windows",
            ),
        ).toBeNull();
        expect(
            getReservedInteractionShortcut(
                { key: "c", modifiers: ["meta", "shift"] },
                "macos",
            ),
        ).toBeNull();
    });
});
