import type { DesktopPlatform } from "../utils/platform";
import {
    getShortcutBindings,
    type ConfigurableShortcutActionId,
    type ShortcutBinding,
} from "./registry";

export const SYNC_NATIVE_MENU_SHORTCUTS_COMMAND =
    "sync_native_menu_shortcuts";

const NATIVE_MENU_SHORTCUT_ACTIONS = {
    "app:open-settings": "open_settings",
    "vault:new-note": "new_note",
    "editor:new-tab": "new_tab",
    "workspace:new-terminal-tab": "new_terminal",
    "vault:open": "open_vault",
    "editor:close-tab": "close_tab",
    "editor:reopen-closed-tab": "reopen_closed_tab",
    "vault:search": "search_in_vault",
    "layout:toggle-sidebar": "toggle_left_sidebar",
    "layout:toggle-right-panel": "toggle_right_panel",
    "nav:command-palette": "command_palette",
    "nav:quick-switcher": "quick_switcher",
    "app:zoom-in": "zoom_in",
    "app:zoom-out": "zoom_out",
    "app:zoom-reset": "reset_zoom",
    "nav:back": "go_back",
    "nav:forward": "go_forward",
    "nav:next-tab": "next_tab",
    "nav:previous-tab": "previous_tab",
} as const satisfies Record<string, ConfigurableShortcutActionId>;

const ELECTRON_MODIFIER_LABELS = {
    meta: "Command",
    ctrl: "Control",
    alt: "Alt",
    shift: "Shift",
} as const;

const ELECTRON_KEY_LABELS: Readonly<Record<string, string>> = {
    " ": "Space",
    arrowdown: "Down",
    arrowleft: "Left",
    arrowright: "Right",
    arrowup: "Up",
    backspace: "Backspace",
    delete: "Delete",
    end: "End",
    enter: "Enter",
    home: "Home",
    insert: "Insert",
    pagedown: "PageDown",
    pageup: "PageUp",
    space: "Space",
    tab: "Tab",
};

function formatElectronAcceleratorKey(key: string): string | null {
    const normalized = key.toLowerCase();
    const namedKey = ELECTRON_KEY_LABELS[normalized];
    if (namedKey) {
        return namedKey;
    }
    if (/^f(?:[1-9]|1\d|2[0-4])$/i.test(key)) {
        return key.toUpperCase();
    }
    if (key.length === 1) {
        return /[a-z]/i.test(key) ? key.toUpperCase() : key;
    }
    return null;
}

export function formatNativeMenuAccelerator(
    binding: ShortcutBinding,
): string | null {
    const key = formatElectronAcceleratorKey(binding.key);
    if (!key) {
        return null;
    }

    const modifiers = (["meta", "ctrl", "alt", "shift"] as const)
        .filter((modifier) => binding.modifiers?.includes(modifier))
        .map((modifier) => ELECTRON_MODIFIER_LABELS[modifier]);
    if (modifiers.length === 0) {
        return null;
    }
    return [...modifiers, key].join("+");
}

export function getNativeMenuShortcutAccelerators(
    platform: DesktopPlatform,
): Record<string, string | null> {
    return Object.fromEntries(
        Object.entries(NATIVE_MENU_SHORTCUT_ACTIONS).map(
            ([commandId, actionId]) => {
                const binding = getShortcutBindings(actionId, platform)[0];
                return [
                    commandId,
                    binding ? formatNativeMenuAccelerator(binding) : null,
                ];
            },
        ),
    );
}
