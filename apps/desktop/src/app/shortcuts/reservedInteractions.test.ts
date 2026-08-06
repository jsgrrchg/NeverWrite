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
];

describe("reserved interaction shortcuts", () => {
    it("keeps the agreed platform inventories complete", () => {
        expect(RESERVED_INTERACTION_SHORTCUTS.macos).toHaveLength(9);
        expect(RESERVED_INTERACTION_SHORTCUTS.windows).toHaveLength(12);
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
