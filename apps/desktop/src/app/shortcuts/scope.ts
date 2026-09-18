export type ShortcutActionId =
    | "command_palette"
    | "quick_switcher"
    | "search_in_vault"
    | "find_in_note"
    | "open_vault"
    | "new_note"
    | "new_agent"
    | "stop_active_agent"
    | "new_terminal"
    | "new_tab"
    | "close_tab"
    | "reopen_closed_tab"
    | "next_tab"
    | "previous_tab"
    | "next_file"
    | "previous_file"
    | "go_back"
    | "go_forward"
    | "toggle_left_sidebar"
    | "toggle_right_panel"
    | "zoom_in"
    | "zoom_out"
    | "reset_zoom"
    | "open_settings"
    | "toggle_live_preview"
    | "heading_1"
    | "heading_2"
    | "heading_3"
    | "heading_4"
    | "heading_5"
    | "heading_6"
    | "remove_heading"
    | "bold_selection"
    | "highlight_selection"
    | "preview_link_at_caret"
    | "add_selection_to_chat"
    | "save_note";

export const CONFIGURABLE_SHORTCUT_ACTION_IDS = [
    "command_palette",
    "quick_switcher",
    "search_in_vault",
    "next_tab",
    "previous_tab",
    "next_file",
    "previous_file",
    "go_back",
    "go_forward",
    "open_vault",
    "new_note",
    "new_agent",
    "new_terminal",
    "new_tab",
    "close_tab",
    "reopen_closed_tab",
    "toggle_left_sidebar",
    "toggle_right_panel",
    "zoom_in",
    "zoom_out",
    "reset_zoom",
    "open_settings",
] as const satisfies readonly ShortcutActionId[];

export type ConfigurableShortcutActionId =
    (typeof CONFIGURABLE_SHORTCUT_ACTION_IDS)[number];

export type FixedShortcutActionId = Exclude<
    ShortcutActionId,
    ConfigurableShortcutActionId
>;

const configurableShortcutActionIds: ReadonlySet<string> = new Set(
    CONFIGURABLE_SHORTCUT_ACTION_IDS,
);

export function isConfigurableShortcutAction(
    actionId: unknown,
): actionId is ConfigurableShortcutActionId {
    return (
        typeof actionId === "string" &&
        configurableShortcutActionIds.has(actionId)
    );
}
