import { getDesktopPlatform, type DesktopPlatform } from "../utils/platform";

export type ShortcutModifier = "meta" | "ctrl" | "alt" | "shift";

export interface ShortcutBinding {
    key: string;
    modifiers?: ShortcutModifier[];
}

export type ShortcutActionId =
    | "command_palette"
    | "quick_switcher"
    | "search_in_vault"
    | "open_vault"
    | "new_note"
    | "new_tab"
    | "close_tab"
    | "reopen_closed_tab"
    | "next_tab"
    | "previous_tab"
    | "toggle_left_sidebar"
    | "toggle_right_panel"
    | "open_settings"
    | "toggle_live_preview"
    | "bold_selection"
    | "highlight_selection"
    | "save_note";

export interface ShortcutDefinition {
    id: ShortcutActionId;
    label: string;
    category: string;
    bindings: Record<DesktopPlatform, ShortcutBinding[]>;
    aliases?: Partial<Record<DesktopPlatform, ShortcutBinding[]>>;
    note?: string;
}

export interface ShortcutSettingsEntry {
    id: ShortcutActionId;
    label: string;
    category: string;
    shortcut: string;
}

const shortcutDefinitions = [
    {
        id: "command_palette",
        label: "Command Palette",
        category: "Navigation",
        bindings: {
            macos: [{ key: "k", modifiers: ["meta"] }],
            windows: [{ key: "p", modifiers: ["ctrl", "shift"] }],
        },
    },
    {
        id: "quick_switcher",
        label: "Quick Switcher",
        category: "Navigation",
        bindings: {
            macos: [{ key: "o", modifiers: ["meta"] }],
            windows: [{ key: "o", modifiers: ["ctrl"] }],
        },
    },
    {
        id: "search_in_vault",
        label: "Search in Vault",
        category: "Navigation",
        bindings: {
            macos: [{ key: "f", modifiers: ["meta", "shift"] }],
            windows: [{ key: "f", modifiers: ["ctrl", "shift"] }],
        },
    },
    {
        id: "open_vault",
        label: "Open Vault",
        category: "Vault",
        bindings: {
            macos: [{ key: "o", modifiers: ["meta", "shift"] }],
            windows: [{ key: "o", modifiers: ["ctrl", "shift"] }],
        },
    },
    {
        id: "new_note",
        label: "New Note",
        category: "Vault",
        bindings: {
            macos: [{ key: "n", modifiers: ["meta"] }],
            windows: [{ key: "n", modifiers: ["ctrl"] }],
        },
    },
    {
        id: "new_tab",
        label: "New Tab",
        category: "Editor",
        bindings: {
            macos: [{ key: "t", modifiers: ["meta"] }],
            windows: [{ key: "t", modifiers: ["ctrl"] }],
        },
    },
    {
        id: "close_tab",
        label: "Close Tab",
        category: "Editor",
        bindings: {
            macos: [{ key: "w", modifiers: ["meta"] }],
            windows: [{ key: "w", modifiers: ["ctrl"] }],
        },
    },
    {
        id: "reopen_closed_tab",
        label: "Reopen Closed Tab",
        category: "Editor",
        bindings: {
            macos: [{ key: "t", modifiers: ["meta", "shift"] }],
            windows: [{ key: "t", modifiers: ["ctrl", "shift"] }],
        },
    },
    {
        id: "next_tab",
        label: "Next Tab",
        category: "Navigation",
        bindings: {
            macos: [{ key: "tab", modifiers: ["ctrl"] }],
            windows: [{ key: "tab", modifiers: ["ctrl"] }],
        },
    },
    {
        id: "previous_tab",
        label: "Previous Tab",
        category: "Navigation",
        bindings: {
            macos: [{ key: "t", modifiers: ["meta", "alt"] }],
            windows: [{ key: "tab", modifiers: ["ctrl", "shift"] }],
        },
        aliases: {
            macos: [{ key: "tab", modifiers: ["ctrl", "shift"] }],
        },
    },
    {
        id: "toggle_left_sidebar",
        label: "Toggle Sidebar",
        category: "View",
        bindings: {
            macos: [{ key: "s", modifiers: ["meta"] }],
            windows: [{ key: "s", modifiers: ["ctrl"] }],
        },
    },
    {
        id: "toggle_right_panel",
        label: "Toggle Right Panel",
        category: "View",
        bindings: {
            macos: [{ key: "j", modifiers: ["meta"] }],
            windows: [{ key: "j", modifiers: ["ctrl"] }],
        },
    },
    {
        id: "open_settings",
        label: "Open Settings",
        category: "View",
        bindings: {
            macos: [{ key: ",", modifiers: ["meta"] }],
            windows: [{ key: ",", modifiers: ["ctrl"] }],
        },
    },
    {
        id: "toggle_live_preview",
        label: "Toggle Live Preview",
        category: "Editor",
        bindings: {
            macos: [{ key: "e", modifiers: ["meta"] }],
            windows: [{ key: "e", modifiers: ["ctrl"] }],
        },
    },
    {
        id: "bold_selection",
        label: "Bold Selection",
        category: "Editor",
        bindings: {
            macos: [{ key: "b", modifiers: ["meta"] }],
            windows: [{ key: "b", modifiers: ["ctrl"] }],
        },
    },
    {
        id: "highlight_selection",
        label: "Highlight Selection",
        category: "Editor",
        bindings: {
            macos: [{ key: "h", modifiers: ["meta", "shift"] }],
            windows: [{ key: "h", modifiers: ["ctrl", "shift"] }],
        },
    },
    {
        id: "save_note",
        label: "Save Note",
        category: "Editor",
        bindings: {
            macos: [{ key: "s", modifiers: ["meta", "shift"] }],
            windows: [{ key: "s", modifiers: ["ctrl", "shift"] }],
        },
        note: "manual",
    },
] satisfies ShortcutDefinition[];

const MAC_MODIFIER_LABELS: Record<ShortcutModifier, string> = {
    meta: "⌘",
    ctrl: "⌃",
    alt: "⌥",
    shift: "⇧",
};

const WINDOWS_MODIFIER_LABELS: Record<ShortcutModifier, string> = {
    meta: "Win",
    ctrl: "Ctrl",
    alt: "Alt",
    shift: "Shift",
};

const CODEMIRROR_MODIFIER_LABELS: Record<ShortcutModifier, string> = {
    meta: "Cmd",
    ctrl: "Ctrl",
    alt: "Alt",
    shift: "Shift",
};

export const SHORTCUT_REGISTRY = shortcutDefinitions.reduce<
    Record<ShortcutActionId, ShortcutDefinition>
>(
    (acc, definition) => {
        acc[definition.id] = definition;
        return acc;
    },
    {} as Record<ShortcutActionId, ShortcutDefinition>,
);

export const SHORTCUT_SETTINGS_ORDER: ShortcutActionId[] = [
    "command_palette",
    "quick_switcher",
    "search_in_vault",
    "next_tab",
    "previous_tab",
    "open_vault",
    "new_note",
    "new_tab",
    "reopen_closed_tab",
    "bold_selection",
    "highlight_selection",
    "toggle_live_preview",
    "save_note",
    "close_tab",
    "toggle_left_sidebar",
    "toggle_right_panel",
    "open_settings",
];

function normalizeShortcutKey(key: string): string {
    return key.length === 1 ? key.toLowerCase() : key.toLowerCase();
}

function formatShortcutKey(key: string): string {
    const normalized = normalizeShortcutKey(key);
    if (normalized === "tab") return "Tab";
    if (normalized.length === 1) return normalized.toUpperCase();
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function hasModifier(
    binding: ShortcutBinding,
    modifier: ShortcutModifier,
): boolean {
    return binding.modifiers?.includes(modifier) ?? false;
}

export function getPrimaryShortcutModifier(
    platform: DesktopPlatform = getDesktopPlatform(),
): ShortcutModifier {
    return platform === "macos" ? "meta" : "ctrl";
}

export function getShortcutDefinition(
    actionId: ShortcutActionId,
): ShortcutDefinition {
    return SHORTCUT_REGISTRY[actionId];
}

export function getShortcutBindings(
    actionId: ShortcutActionId,
    platform: DesktopPlatform = getDesktopPlatform(),
): ShortcutBinding[] {
    return SHORTCUT_REGISTRY[actionId].bindings[platform];
}

export function getShortcutBindingsWithAliases(
    actionId: ShortcutActionId,
    platform: DesktopPlatform = getDesktopPlatform(),
): ShortcutBinding[] {
    const definition = SHORTCUT_REGISTRY[actionId];
    return [
        ...definition.bindings[platform],
        ...(definition.aliases?.[platform] ?? []),
    ];
}

export function formatShortcutBinding(
    binding: ShortcutBinding,
    platform: DesktopPlatform = getDesktopPlatform(),
): string {
    const labels =
        platform === "macos" ? MAC_MODIFIER_LABELS : WINDOWS_MODIFIER_LABELS;
    const orderedModifiers: ShortcutModifier[] =
        platform === "macos"
            ? ["meta", "ctrl", "alt", "shift"]
            : ["ctrl", "shift", "alt", "meta"];
    const modifierParts = orderedModifiers
        .filter((modifier) => hasModifier(binding, modifier))
        .map((modifier) => labels[modifier]);
    const keyPart = formatShortcutKey(binding.key);

    if (platform === "macos") {
        return `${modifierParts.join("")}${keyPart}`;
    }

    return [...modifierParts, keyPart].join("+");
}

export function formatPrimaryShortcut(
    key: string,
    platform: DesktopPlatform = getDesktopPlatform(),
): string {
    return formatShortcutBinding(
        {
            key,
            modifiers: [getPrimaryShortcutModifier(platform)],
        },
        platform,
    );
}

export function formatShortcutAction(
    actionId: ShortcutActionId,
    platform: DesktopPlatform = getDesktopPlatform(),
    options?: { includeNote?: boolean },
): string {
    const primaryBinding = getShortcutBindings(actionId, platform)[0];
    if (!primaryBinding) return "";

    const formatted = formatShortcutBinding(primaryBinding, platform);
    const note = options?.includeNote
        ? SHORTCUT_REGISTRY[actionId].note
        : undefined;

    return note ? `${formatted} (${note})` : formatted;
}

export function formatShortcutDefinition(
    shortcut: ShortcutDefinition,
    platform: DesktopPlatform = getDesktopPlatform(),
): string {
    return formatShortcutAction(shortcut.id, platform, { includeNote: true });
}

export function getShortcutDisplayDefinitions(
    platform: DesktopPlatform = getDesktopPlatform(),
): ShortcutDefinition[] {
    return SHORTCUT_SETTINGS_ORDER.map((actionId) =>
        getShortcutDefinition(actionId),
    ).filter((definition) => definition.bindings[platform].length > 0);
}

export function getShortcutSettingsEntries(
    platform: DesktopPlatform = getDesktopPlatform(),
): ShortcutSettingsEntry[] {
    return SHORTCUT_SETTINGS_ORDER.map((actionId) => {
        const definition = getShortcutDefinition(actionId);
        return {
            id: actionId,
            label: definition.label,
            category: definition.category,
            shortcut: formatShortcutAction(actionId, platform, {
                includeNote: true,
            }),
        };
    });
}

export function matchesShortcutBinding(
    event: Pick<
        KeyboardEvent,
        "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
    >,
    binding: ShortcutBinding,
): boolean {
    if (normalizeShortcutKey(event.key) !== normalizeShortcutKey(binding.key)) {
        return false;
    }

    return (
        event.metaKey === hasModifier(binding, "meta") &&
        event.ctrlKey === hasModifier(binding, "ctrl") &&
        event.altKey === hasModifier(binding, "alt") &&
        event.shiftKey === hasModifier(binding, "shift")
    );
}

export function matchesShortcutAction(
    event: Pick<
        KeyboardEvent,
        "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
    >,
    actionId: ShortcutActionId,
    platform: DesktopPlatform = getDesktopPlatform(),
): boolean {
    return getShortcutBindingsWithAliases(actionId, platform).some((binding) =>
        matchesShortcutBinding(event, binding),
    );
}

export function getCodeMirrorShortcut(
    actionId: ShortcutActionId,
    platform: DesktopPlatform = getDesktopPlatform(),
): string | null {
    const binding = getShortcutBindings(actionId, platform)[0];
    if (!binding) return null;

    const parts: string[] = [];
    const usesSinglePrimaryModifier =
        hasModifier(binding, "meta") !== hasModifier(binding, "ctrl");

    if (usesSinglePrimaryModifier) {
        parts.push("Mod");
    } else {
        if (hasModifier(binding, "meta")) {
            parts.push(CODEMIRROR_MODIFIER_LABELS.meta);
        }
        if (hasModifier(binding, "ctrl")) {
            parts.push(CODEMIRROR_MODIFIER_LABELS.ctrl);
        }
    }

    if (hasModifier(binding, "alt")) {
        parts.push(CODEMIRROR_MODIFIER_LABELS.alt);
    }

    if (hasModifier(binding, "shift")) {
        parts.push(CODEMIRROR_MODIFIER_LABELS.shift);
    }

    parts.push(
        binding.key.length === 1
            ? binding.key.toLowerCase()
            : formatShortcutKey(binding.key),
    );
    return parts.join("-");
}
