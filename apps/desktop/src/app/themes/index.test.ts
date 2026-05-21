import { afterEach, describe, expect, it } from "vitest";

import {
    applyThemeColors,
    themes,
    type CodeColorAnchors,
    type ThemeName,
} from "./index";

const CODE_CSS_VAR_MAP = {
    comment: "--code-comment",
    constant: "--code-constant",
    escape: "--code-escape",
    function: "--code-function",
    keyword: "--code-keyword",
    markup: "--code-markup",
    parameter: "--code-parameter",
    property: "--code-property",
    string: "--code-string",
    type: "--code-type",
    typeParameter: "--code-type-parameter",
    variable: "--code-variable",
} satisfies Record<keyof CodeColorAnchors, string>;

const CODE_CSS_VAR_ENTRIES = Object.entries(CODE_CSS_VAR_MAP) as Array<
    [keyof CodeColorAnchors, string]
>;

const TERMINAL_ANSI_CSS_VARS = [
    "--terminal-ansi-black",
    "--terminal-ansi-red",
    "--terminal-ansi-green",
    "--terminal-ansi-yellow",
    "--terminal-ansi-blue",
    "--terminal-ansi-magenta",
    "--terminal-ansi-cyan",
    "--terminal-ansi-white",
    "--terminal-ansi-bright-black",
    "--terminal-ansi-bright-red",
    "--terminal-ansi-bright-green",
    "--terminal-ansi-bright-yellow",
    "--terminal-ansi-bright-blue",
    "--terminal-ansi-bright-magenta",
    "--terminal-ansi-bright-cyan",
    "--terminal-ansi-bright-white",
] as const;

function expectCodeVars(themeName: ThemeName, isDark: boolean) {
    applyThemeColors(themeName, isDark);

    const mode = isDark ? "dark" : "light";
    const anchors = themes[themeName][mode].codeAnchors;

    for (const [key, cssVar] of CODE_CSS_VAR_ENTRIES) {
        expect(document.documentElement.style.getPropertyValue(cssVar)).toBe(
            anchors[key],
        );
    }
}

describe("applyThemeColors", () => {
    afterEach(() => {
        document.documentElement.removeAttribute("style");
    });

    it("publishes all per-theme syntax token vars for light and dark modes", () => {
        expectCodeVars("default", false);
        expectCodeVars("default", true);
    });

    it("updates syntax token vars when only the theme name changes", () => {
        applyThemeColors("gruvbox", false);
        expect(
            document.documentElement.style.getPropertyValue("--code-keyword"),
        ).toBe(themes.gruvbox.light.codeAnchors.keyword);

        applyThemeColors("tokyoNight", false);

        expect(
            document.documentElement.style.getPropertyValue("--code-keyword"),
        ).toBe(themes.tokyoNight.light.codeAnchors.keyword);
        expect(themes.tokyoNight.light.codeAnchors.keyword).not.toBe(
            themes.gruvbox.light.codeAnchors.keyword,
        );
    });

    it("publishes terminal ANSI vars for every theme and mode", () => {
        for (const themeName of Object.keys(themes) as ThemeName[]) {
            for (const isDark of [false, true]) {
                applyThemeColors(themeName, isDark);

                for (const cssVar of TERMINAL_ANSI_CSS_VARS) {
                    expect(
                        document.documentElement.style.getPropertyValue(cssVar),
                    ).toMatch(/^#[0-9a-f]{6}$/i);
                }
            }
        }
    });
});
