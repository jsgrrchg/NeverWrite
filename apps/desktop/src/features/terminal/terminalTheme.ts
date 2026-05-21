export interface TerminalTheme {
    background: string;
    panelBackground: string;
    border: string;
    text: string;
    mutedText: string;
    accent: string;
    cursor: string;
    fontFamily: string;
    fontSize: number;
    lineHeight: number;
    // ANSI 16-color palette
    black: string;
    red: string;
    green: string;
    yellow: string;
    blue: string;
    magenta: string;
    cyan: string;
    white: string;
    brightBlack: string;
    brightRed: string;
    brightGreen: string;
    brightYellow: string;
    brightBlue: string;
    brightMagenta: string;
    brightCyan: string;
    brightWhite: string;
    // Selection and scrollbar
    selectionBackground: string;
    scrollbarSliderBackground: string;
    scrollbarSliderHoverBackground: string;
    scrollbarSliderActiveBackground: string;
}

const FALLBACK_FONT_STACK =
    '"SFMono-Regular", "Cascadia Code", "JetBrains Mono", Menlo, Monaco, Consolas, monospace';

export function getTerminalTheme(
    element: HTMLElement | null,
    opts?: { fontFamily?: string; fontSize?: number },
): TerminalTheme {
    const computed = window.getComputedStyle(
        element ?? document.documentElement,
    );
    const v = (name: string) => computed.getPropertyValue(name).trim();

    // Read a terminal ANSI slot: prefer the per-theme custom property set by
    // applyTerminalPalette(), fall back to the Catppuccin icon token which is
    // always present and provides a reasonable default for unlisted themes.
    const ansi = (cssVar: string, fallback: string) =>
        v(cssVar) || v(fallback);

    return {
        background: v("--bg-primary"),
        panelBackground: v("--bg-secondary"),
        border: v("--border"),
        text: v("--text-primary"),
        mutedText: v("--text-secondary"),
        accent: v("--accent"),
        cursor: v("--accent"),
        fontFamily: opts?.fontFamily?.trim() || FALLBACK_FONT_STACK,
        fontSize: opts?.fontSize ?? 13,
        lineHeight: 1.4,
        black:         ansi("--terminal-ansi-black",          "--bg-secondary"),
        red:           ansi("--terminal-ansi-red",            "--catppuccin-icon-red"),
        green:         ansi("--terminal-ansi-green",          "--catppuccin-icon-green"),
        yellow:        ansi("--terminal-ansi-yellow",         "--catppuccin-icon-yellow"),
        blue:          ansi("--terminal-ansi-blue",           "--catppuccin-icon-blue"),
        magenta:       ansi("--terminal-ansi-magenta",        "--catppuccin-icon-mauve"),
        cyan:          ansi("--terminal-ansi-cyan",           "--catppuccin-icon-teal"),
        white:         ansi("--terminal-ansi-white",          "--text-primary"),
        brightBlack:   ansi("--terminal-ansi-bright-black",   "--text-secondary"),
        brightRed:     ansi("--terminal-ansi-bright-red",     "--catppuccin-icon-maroon"),
        brightGreen:   ansi("--terminal-ansi-bright-green",   "--catppuccin-icon-green"),
        brightYellow:  ansi("--terminal-ansi-bright-yellow",  "--catppuccin-icon-peach"),
        brightBlue:    ansi("--terminal-ansi-bright-blue",    "--catppuccin-icon-lavender"),
        brightMagenta: ansi("--terminal-ansi-bright-magenta", "--catppuccin-icon-pink"),
        brightCyan:    ansi("--terminal-ansi-bright-cyan",    "--catppuccin-icon-sky"),
        brightWhite:   ansi("--terminal-ansi-bright-white",   "--text-heading"),
        selectionBackground: v("--highlight-bg"),
        scrollbarSliderBackground: v("--scrollbar-thumb-active"),
        scrollbarSliderHoverBackground: v("--scrollbar-thumb-hover"),
        scrollbarSliderActiveBackground: v("--scrollbar-thumb-active"),
    };
}
