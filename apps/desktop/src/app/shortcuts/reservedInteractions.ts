import type { DesktopPlatform } from "../utils/platform";
import type {
    ShortcutBinding,
    ShortcutModifier,
} from "./registry";

export interface ReservedInteractionShortcut {
    label: string;
    binding: ShortcutBinding;
}

function reservedInteraction(
    label: string,
    key: string,
    modifiers: ShortcutModifier[],
): ReservedInteractionShortcut {
    return { label, binding: { key, modifiers } };
}

export const RESERVED_INTERACTION_SHORTCUTS = {
    macos: [
        reservedInteraction("Copy", "c", ["meta"]),
        reservedInteraction("Paste", "v", ["meta"]),
        reservedInteraction("Cut", "x", ["meta"]),
        reservedInteraction("Select All", "a", ["meta"]),
        reservedInteraction("Undo", "z", ["meta"]),
        reservedInteraction("Redo", "y", ["meta"]),
        reservedInteraction("Redo", "z", ["meta", "shift"]),
        reservedInteraction("Paste without formatting", "v", ["meta", "shift"]),
        reservedInteraction("Paste and Match Style", "v", [
            "meta",
            "alt",
            "shift",
        ]),
    ],
    windows: [
        reservedInteraction("Copy", "c", ["ctrl"]),
        reservedInteraction("Paste", "v", ["ctrl"]),
        reservedInteraction("Cut", "x", ["ctrl"]),
        reservedInteraction("Select All", "a", ["ctrl"]),
        reservedInteraction("Undo", "z", ["ctrl"]),
        reservedInteraction("Redo", "y", ["ctrl"]),
        reservedInteraction("Redo", "z", ["ctrl", "shift"]),
        reservedInteraction("Copy in terminals", "c", ["ctrl", "shift"]),
        reservedInteraction("Paste without formatting or in terminals", "v", [
            "ctrl",
            "shift",
        ]),
        reservedInteraction("Copy", "Insert", ["ctrl"]),
        reservedInteraction("Paste", "Insert", ["shift"]),
        reservedInteraction("Cut", "Delete", ["shift"]),
    ],
} as const satisfies Record<
    "macos" | "windows",
    readonly ReservedInteractionShortcut[]
>;

function bindingsEqual(left: ShortcutBinding, right: ShortcutBinding) {
    const modifiers = ["meta", "ctrl", "alt", "shift"] as const;
    return (
        left.key.toLowerCase() === right.key.toLowerCase() &&
        modifiers.every(
            (modifier) =>
                Boolean(left.modifiers?.includes(modifier)) ===
                Boolean(right.modifiers?.includes(modifier)),
        )
    );
}

export function getReservedInteractionShortcut(
    binding: ShortcutBinding,
    platform: DesktopPlatform,
): ReservedInteractionShortcut | null {
    const shortcutPlatform = platform === "macos" ? "macos" : "windows";
    return (
        RESERVED_INTERACTION_SHORTCUTS[shortcutPlatform].find((shortcut) =>
            bindingsEqual(shortcut.binding, binding),
        ) ?? null
    );
}
