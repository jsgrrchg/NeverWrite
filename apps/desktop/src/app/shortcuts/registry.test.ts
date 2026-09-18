import { describe, expect, it } from "vitest";
import {
    CONFIGURABLE_SHORTCUT_ACTION_IDS,
    getConfigurableShortcutSettingsEntries,
    getFixedShortcutSettingsEntries,
    getShortcutSettingsEntries,
    isConfigurableShortcutAction,
    type ShortcutActionId,
} from "./registry";

const EXPECTED_CONFIGURABLE_ACTION_IDS = [
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
] satisfies ShortcutActionId[];

const CONTEXTUAL_EDITOR_ACTION_IDS = [
    "find_in_note",
    "toggle_live_preview",
    "heading_1",
    "heading_2",
    "heading_3",
    "heading_4",
    "heading_5",
    "heading_6",
    "remove_heading",
    "bold_selection",
    "highlight_selection",
    "preview_link_at_caret",
    "save_note",
] satisfies ShortcutActionId[];

describe("configurable shortcut scope", () => {
    it("contains exactly the 22 global actions approved for customization", () => {
        expect(CONFIGURABLE_SHORTCUT_ACTION_IDS).toEqual(
            EXPECTED_CONFIGURABLE_ACTION_IDS,
        );
        expect(CONFIGURABLE_SHORTCUT_ACTION_IDS).toHaveLength(22);
    });

    it("excludes contextual editor actions", () => {
        for (const actionId of CONTEXTUAL_EDITOR_ACTION_IDS) {
            expect(isConfigurableShortcutAction(actionId)).toBe(false);
        }
    });

    it("keeps agent stop and selection capture fixed", () => {
        expect(isConfigurableShortcutAction("stop_active_agent")).toBe(false);
        expect(isConfigurableShortcutAction("add_selection_to_chat")).toBe(
            false,
        );
        expect(isConfigurableShortcutAction("unknown_action")).toBe(false);
        expect(isConfigurableShortcutAction(null)).toBe(false);
    });

    it("partitions Settings entries into configurable and fixed lists", () => {
        const entries = getShortcutSettingsEntries("windows");
        const configurableEntries =
            getConfigurableShortcutSettingsEntries("windows");
        const fixedEntries = getFixedShortcutSettingsEntries("windows");

        expect(configurableEntries.map((entry) => entry.id)).toEqual(
            entries
                .filter((entry) => isConfigurableShortcutAction(entry.id))
                .map((entry) => entry.id),
        );
        expect(fixedEntries.map((entry) => entry.id)).toEqual(
            entries
                .filter((entry) => !isConfigurableShortcutAction(entry.id))
                .map((entry) => entry.id),
        );
        expect(configurableEntries).toHaveLength(22);
        expect(fixedEntries).toHaveLength(15);
    });
});
