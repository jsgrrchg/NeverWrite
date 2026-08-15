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
import {
    applyTerminalPalette,
    getTerminalPalette,
} from "./terminalPalettes";

// 12 syntax-highlighting anchor colors that drive per-theme code and
// markdown coloring across CodeMirror and the static highlighter. Each
// theme curates these once per mode (light/dark) and the runtime publishes
// them as `--code-*` CSS vars on `:root`.
export interface CodeColorAnchors {
    comment: string;
    constant: string;
    escape: string;
    function: string;
    keyword: string;
    markup: string;
    parameter: string;
    property: string;
    string: string;
    type: string;
    typeParameter: string;
    variable: string;
}

export interface ThemeUiColors {
    bgPrimary: string;
    bgSecondary: string;
    bgTertiary: string;
    bgElevated: string;
    textPrimary: string;
    textSecondary: string;
    textHeading: string;
    textHeadingMuted: string;
    border: string;
    accent: string;
    iconMuted: string;
    shadowSoft: string;
}

export interface ThemeColors extends ThemeUiColors {
    codeAnchors: CodeColorAnchors;
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

const CSS_VAR_MAP: Record<keyof ThemeUiColors, string> = {
    bgPrimary: "--bg-primary",
    bgSecondary: "--bg-secondary",
    bgTertiary: "--bg-tertiary",
    bgElevated: "--bg-elevated",
    textPrimary: "--text-primary",
    textSecondary: "--text-secondary",
    textHeading: "--text-heading",
    textHeadingMuted: "--text-heading-muted",
    border: "--border",
    accent: "--accent",
    iconMuted: "--icon-muted",
    shadowSoft: "--shadow-soft",
};

const CODE_CSS_VAR_MAP: Record<keyof CodeColorAnchors, string> = {
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
};

export interface AgentStatusColors {
    working: string;
    review: string;
    approval: string;
    input: string;
    failed: string;
    done: string;
    snoozed: string;
}

const AGENT_STATUS_CSS_VAR_MAP: Record<keyof AgentStatusColors, string> = {
    working: "--agent-status-working",
    review: "--agent-status-review",
    approval: "--agent-status-approval",
    input: "--agent-status-input",
    failed: "--agent-status-failed",
    done: "--agent-status-done",
    snoozed: "--agent-status-snoozed",
};

// Every bundled theme already owns a curated ANSI palette with semantic hues.
// Reusing it keeps agent lifecycle colors theme-aware while preserving the
// meaning of red/green/yellow across palettes. Dark themes use their lifted
// variants for readable contrast on sidebar surfaces.
export function getAgentStatusColors(
    name: ThemeName,
    isDark: boolean,
): AgentStatusColors {
    const ansi = getTerminalPalette(name, isDark);
    return {
        working: isDark ? ansi.brightCyan : ansi.cyan,
        review: isDark ? ansi.brightMagenta : ansi.magenta,
        approval: isDark ? ansi.brightYellow : ansi.yellow,
        input: isDark ? ansi.brightBlue : ansi.blue,
        failed: isDark ? ansi.brightRed : ansi.red,
        done: isDark ? ansi.brightGreen : ansi.green,
        snoozed: isDark ? ansi.brightBlue : ansi.blue,
    };
}

export function applyThemeColors(name: ThemeName, isDark: boolean) {
    if (typeof document === "undefined") return;
    const palette = themes[name];
    const colors = isDark ? palette.dark : palette.light;
    const el = document.documentElement;

    for (const [key, cssVar] of Object.entries(CSS_VAR_MAP)) {
        el.style.setProperty(cssVar, colors[key as keyof ThemeUiColors]);
    }

    for (const [key, cssVar] of Object.entries(CODE_CSS_VAR_MAP)) {
        el.style.setProperty(
            cssVar,
            colors.codeAnchors[key as keyof CodeColorAnchors],
        );
    }

    const agentStatusColors = getAgentStatusColors(name, isDark);
    for (const [key, cssVar] of Object.entries(AGENT_STATUS_CSS_VAR_MAP)) {
        el.style.setProperty(
            cssVar,
            agentStatusColors[key as keyof AgentStatusColors],
        );
    }

    applyTerminalPalette(name, isDark);
}
