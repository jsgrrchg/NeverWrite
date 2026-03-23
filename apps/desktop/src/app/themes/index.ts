import { defaultTheme } from "./default";
import { oceanTheme } from "./ocean";
import { forestTheme } from "./forest";
import { roseTheme } from "./rose";
import { amberTheme } from "./amber";
import { lavenderTheme } from "./lavender";
import { nordTheme } from "./nord";
import { sunsetTheme } from "./sunset";
import { catppuccinTheme } from "./catppuccin";
import { solarizedTheme } from "./solarized";
import { tokyoNightTheme } from "./tokyoNight";
import { gruvboxTheme } from "./gruvbox";
import { ayuTheme } from "./ayu";
import { nightOwlTheme } from "./nightOwl";
import { vesperTheme } from "./vesper";
import { rosePineTheme } from "./rosePine";
import { kanagawaTheme } from "./kanagawa";
import { everforestTheme } from "./everforest";
import { synthwave84Theme } from "./synthwave84";
import { claudeTheme } from "./claude";
import { codexTheme } from "./codex";

export interface ThemeColors {
    bgPrimary: string;
    bgSecondary: string;
    bgTertiary: string;
    bgElevated: string;
    textPrimary: string;
    textSecondary: string;
    border: string;
    accent: string;
    shadowSoft: string;
}

export interface ThemePalette {
    label: string;
    light: ThemeColors;
    dark: ThemeColors;
}

export type ThemeName =
    | "default"
    | "ocean"
    | "forest"
    | "rose"
    | "amber"
    | "lavender"
    | "nord"
    | "sunset"
    | "catppuccin"
    | "solarized"
    | "tokyoNight"
    | "gruvbox"
    | "ayu"
    | "nightOwl"
    | "vesper"
    | "rosePine"
    | "kanagawa"
    | "everforest"
    | "synthwave84"
    | "claude"
    | "codex";

export const themes: Record<ThemeName, ThemePalette> = {
    default: defaultTheme,
    ocean: oceanTheme,
    forest: forestTheme,
    rose: roseTheme,
    amber: amberTheme,
    lavender: lavenderTheme,
    nord: nordTheme,
    sunset: sunsetTheme,
    catppuccin: catppuccinTheme,
    solarized: solarizedTheme,
    tokyoNight: tokyoNightTheme,
    gruvbox: gruvboxTheme,
    ayu: ayuTheme,
    nightOwl: nightOwlTheme,
    vesper: vesperTheme,
    rosePine: rosePineTheme,
    kanagawa: kanagawaTheme,
    everforest: everforestTheme,
    synthwave84: synthwave84Theme,
    claude: claudeTheme,
    codex: codexTheme,
};

const CSS_VAR_MAP: Record<keyof ThemeColors, string> = {
    bgPrimary: "--bg-primary",
    bgSecondary: "--bg-secondary",
    bgTertiary: "--bg-tertiary",
    bgElevated: "--bg-elevated",
    textPrimary: "--text-primary",
    textSecondary: "--text-secondary",
    border: "--border",
    accent: "--accent",
    shadowSoft: "--shadow-soft",
};

export function applyThemeColors(name: ThemeName, isDark: boolean) {
    if (typeof document === "undefined") return;
    const palette = themes[name];
    const colors = isDark ? palette.dark : palette.light;
    const el = document.documentElement;

    for (const [key, cssVar] of Object.entries(CSS_VAR_MAP)) {
        el.style.setProperty(cssVar, colors[key as keyof ThemeColors]);
    }
}
