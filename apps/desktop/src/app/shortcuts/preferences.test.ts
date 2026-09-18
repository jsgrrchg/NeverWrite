import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    applyShortcutOverrideChanges,
    getShortcutOverride,
    readShortcutOverrides,
    resetAllShortcutOverrides,
    resetShortcutOverride,
    setShortcutOverride,
    SHORTCUT_OVERRIDES_STORAGE_KEY,
    subscribeShortcutOverrides,
} from "./preferences";
import {
    formatShortcutAction,
    getCodeMirrorShortcut,
    matchesShortcutAction,
} from "./registry";

function keyboardEvent(
    key: string,
    modifiers: Partial<
        Pick<KeyboardEventInit, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">
    > = {},
) {
    return new KeyboardEvent("keydown", { key, ...modifiers });
}

beforeEach(() => {
    localStorage.clear();
});

afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
});

describe("shortcut preferences persistence", () => {
    it("persists normalized overrides in one versioned global payload", () => {
        expect(
            setShortcutOverride("command_palette", "macos", {
                key: "P",
                modifiers: ["shift", "meta", "shift"],
            }),
        ).toBe(true);

        expect(readShortcutOverrides()).toEqual({
            version: 1,
            macos: {
                command_palette: {
                    key: "P",
                    modifiers: ["meta", "shift"],
                },
            },
            windows: {},
        });
        expect(
            JSON.parse(
                localStorage.getItem(SHORTCUT_OVERRIDES_STORAGE_KEY) ?? "",
            ),
        ).toEqual(readShortcutOverrides());
    });

    it("keeps overrides global and isolated from per-vault settings", () => {
        const vaultSettingsKey = "neverwrite:settings:/vaults/one";
        localStorage.setItem(vaultSettingsKey, '{"state":{"vimMode":true}}');

        setShortcutOverride("new_note", "macos", {
            key: "D",
            modifiers: ["meta"],
        });
        localStorage.setItem("neverwrite:lastVault", "/vaults/two");

        expect(getShortcutOverride("new_note", "macos")).toEqual({
            key: "D",
            modifiers: ["meta"],
        });
        expect(localStorage.getItem(vaultSettingsKey)).toBe(
            '{"state":{"vimMode":true}}',
        );
        expect(
            [...Array(localStorage.length)].map((_, index) =>
                localStorage.key(index),
            ),
        ).not.toContain("neverwrite:settings:/vaults/two");
    });

    it("stores and resolves macOS and Windows overrides independently", () => {
        setShortcutOverride("quick_switcher", "macos", {
            key: "J",
            modifiers: ["meta"],
        });
        setShortcutOverride("quick_switcher", "windows", {
            key: "Q",
            modifiers: ["ctrl", "alt"],
        });

        expect(formatShortcutAction("quick_switcher", "macos")).toBe("⌘J");
        expect(formatShortcutAction("quick_switcher", "windows")).toBe(
            "Ctrl+Alt+Q",
        );
        expect(formatShortcutAction("quick_switcher", "linux")).toBe(
            "Ctrl+Alt+Q",
        );
    });

    it("applies overrides consistently to formatting, matching, and CodeMirror", () => {
        setShortcutOverride("new_tab", "macos", {
            key: "Y",
            modifiers: ["meta", "shift"],
        });

        expect(formatShortcutAction("new_tab", "macos")).toBe("⌘⇧Y");
        expect(
            matchesShortcutAction(
                keyboardEvent("Y", { metaKey: true, shiftKey: true }),
                "new_tab",
                "macos",
            ),
        ).toBe(true);
        expect(
            matchesShortcutAction(
                keyboardEvent("T", { metaKey: true }),
                "new_tab",
                "macos",
            ),
        ).toBe(false);
        expect(getCodeMirrorShortcut("new_tab", "macos")).toBe("Mod-Shift-y");
    });

    it("suppresses default aliases only while an override exists", () => {
        const defaultAlias = keyboardEvent("+", {
            metaKey: true,
            shiftKey: true,
        });

        expect(matchesShortcutAction(defaultAlias, "zoom_in", "macos")).toBe(
            true,
        );
        setShortcutOverride("zoom_in", "macos", {
            key: "I",
            modifiers: ["meta", "alt"],
        });
        expect(matchesShortcutAction(defaultAlias, "zoom_in", "macos")).toBe(
            false,
        );

        resetShortcutOverride("zoom_in", "macos");
        expect(formatShortcutAction("zoom_in", "macos")).toBe("⌘=");
        expect(matchesShortcutAction(defaultAlias, "zoom_in", "macos")).toBe(
            true,
        );
    });

    it("resets one platform without discarding another platform", () => {
        setShortcutOverride("open_settings", "macos", {
            key: ";",
            modifiers: ["meta"],
        });
        setShortcutOverride("open_settings", "windows", {
            key: ";",
            modifiers: ["ctrl"],
        });

        expect(resetAllShortcutOverrides("macos")).toBe(true);
        expect(getShortcutOverride("open_settings", "macos")).toBeNull();
        expect(getShortcutOverride("open_settings", "windows")).toEqual({
            key: ";",
            modifiers: ["ctrl"],
        });

        expect(resetAllShortcutOverrides("windows")).toBe(true);
        expect(localStorage.getItem(SHORTCUT_OVERRIDES_STORAGE_KEY)).toBeNull();
    });

    it("discards invalid entries without losing valid overrides", () => {
        localStorage.setItem(
            SHORTCUT_OVERRIDES_STORAGE_KEY,
            JSON.stringify({
                version: 1,
                macos: {
                    command_palette: {
                        key: "P",
                        modifiers: ["shift", "meta", "shift"],
                    },
                    quick_switcher: { key: "Q", modifiers: [] },
                    new_note: { key: "N", modifiers: ["hyper"] },
                    new_agent: { key: "Shift", modifiers: ["meta"] },
                    zoom_in: { key: "Escape", modifiers: ["meta"] },
                    stop_active_agent: { key: "X", modifiers: ["meta"] },
                    unknown_action: { key: "U", modifiers: ["meta"] },
                },
                windows: {
                    open_vault: { key: "G", modifiers: ["ctrl", "shift"] },
                },
            }),
        );

        expect(readShortcutOverrides()).toEqual({
            version: 1,
            macos: {
                command_palette: {
                    key: "P",
                    modifiers: ["meta", "shift"],
                },
            },
            windows: {
                open_vault: {
                    key: "G",
                    modifiers: ["ctrl", "shift"],
                },
            },
        });
        expect(formatShortcutAction("stop_active_agent", "macos")).toBe(
            "Escape",
        );
    });

    it.each(["CapsLock", "NumLock", "ScrollLock"])(
        "rejects the lock key %s as a shortcut key",
        (key) => {
            expect(
                setShortcutOverride("new_note", "windows", {
                    key,
                    modifiers: ["ctrl"],
                }),
            ).toBe(false);
            expect(
                localStorage.getItem(SHORTCUT_OVERRIDES_STORAGE_KEY),
            ).toBeNull();
        },
    );

    it("rejects reserved interaction shortcuts from writes and stored payloads", () => {
        expect(
            setShortcutOverride("new_note", "windows", {
                key: "c",
                modifiers: ["ctrl"],
            }),
        ).toBe(false);
        expect(
            setShortcutOverride("new_note", "macos", {
                key: "v",
                modifiers: ["meta"],
            }),
        ).toBe(false);
        expect(
            setShortcutOverride("new_note", "windows", {
                key: "l",
                modifiers: ["ctrl"],
            }),
        ).toBe(false);
        expect(
            setShortcutOverride("new_note", "macos", {
                key: "l",
                modifiers: ["meta"],
            }),
        ).toBe(false);

        localStorage.setItem(
            SHORTCUT_OVERRIDES_STORAGE_KEY,
            JSON.stringify({
                version: 1,
                macos: {
                    new_note: { key: "x", modifiers: ["meta"] },
                    new_agent: { key: "l", modifiers: ["meta"] },
                },
                windows: {
                    new_note: { key: "a", modifiers: ["ctrl"] },
                    quick_switcher: { key: "l", modifiers: ["ctrl"] },
                    new_agent: {
                        key: "q",
                        modifiers: ["ctrl", "alt"],
                    },
                },
            }),
        );

        expect(readShortcutOverrides()).toEqual({
            version: 1,
            macos: {},
            windows: {
                new_agent: {
                    key: "q",
                    modifiers: ["ctrl", "alt"],
                },
            },
        });
    });

    it("rejects fixed editor bindings from batched override writes", () => {
        const cases = [
            ["macos", "f", ["meta"]],
            ["macos", "s", ["meta", "shift"]],
            ["macos", "1", ["meta"]],
            ["macos", "b", ["meta"]],
            ["macos", "h", ["meta", "shift"]],
            ["windows", "f", ["ctrl"]],
            ["windows", "s", ["ctrl", "shift"]],
            ["windows", "1", ["ctrl"]],
            ["windows", "b", ["ctrl"]],
            ["windows", "h", ["ctrl", "shift"]],
        ] as const;

        for (const [platform, key, modifiers] of cases) {
            expect(
                applyShortcutOverrideChanges(platform, [
                    {
                        actionId: "new_note",
                        binding: { key, modifiers: [...modifiers] },
                    },
                ]),
            ).toBe(false);
        }

        expect(localStorage.getItem(SHORTCUT_OVERRIDES_STORAGE_KEY)).toBeNull();
    });

    it("keeps the active shortcut unchanged when persistence fails", () => {
        expect(
            setShortcutOverride("new_note", "macos", {
                key: "D",
                modifiers: ["meta"],
            }),
        ).toBe(true);

        vi.spyOn(window.localStorage, "setItem").mockImplementationOnce(() => {
            throw new Error("storage unavailable");
        });

        expect(
            setShortcutOverride("new_note", "macos", {
                key: "N",
                modifiers: ["meta", "shift"],
            }),
        ).toBe(false);

        expect(getShortcutOverride("new_note", "macos")).toEqual({
            key: "D",
            modifiers: ["meta"],
        });
        expect(
            JSON.parse(
                localStorage.getItem(SHORTCUT_OVERRIDES_STORAGE_KEY) ?? "",
            ),
        ).toMatchObject({
            macos: {
                new_note: { key: "D", modifiers: ["meta"] },
            },
        });
    });

    it("falls back to defaults for malformed or unsupported payloads", () => {
        localStorage.setItem(SHORTCUT_OVERRIDES_STORAGE_KEY, "not json");
        expect(formatShortcutAction("command_palette", "macos")).toBe("⌘K");

        localStorage.setItem(
            SHORTCUT_OVERRIDES_STORAGE_KEY,
            JSON.stringify({
                version: 2,
                macos: {
                    command_palette: { key: "P", modifiers: ["meta"] },
                },
                windows: {},
            }),
        );
        expect(readShortcutOverrides()).toEqual({
            version: 1,
            macos: {},
            windows: {},
        });
        expect(formatShortcutAction("command_palette", "macos")).toBe("⌘K");
    });

    it("notifies subscribers only when the global override payload changes", () => {
        const listener = vi.fn();
        const unsubscribe = subscribeShortcutOverrides(listener);

        localStorage.setItem("neverwrite:settings:/vaults/one", "{}");
        window.dispatchEvent(
            new StorageEvent("storage", {
                key: "neverwrite:settings:/vaults/one",
                newValue: "{}",
            }),
        );
        setShortcutOverride("new_terminal", "windows", {
            key: "T",
            modifiers: ["ctrl", "alt"],
        });

        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenLastCalledWith({
            version: 1,
            macos: {},
            windows: {
                new_terminal: {
                    key: "T",
                    modifiers: ["ctrl", "alt"],
                },
            },
        });

        unsubscribe();
        resetShortcutOverride("new_terminal", "windows");
        expect(listener).toHaveBeenCalledTimes(1);
    });
});
