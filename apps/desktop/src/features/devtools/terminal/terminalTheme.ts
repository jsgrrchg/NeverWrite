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
}

export function getTerminalTheme(element: HTMLElement | null): TerminalTheme {
    const computed = window.getComputedStyle(
        element ?? document.documentElement,
    );

    return {
        background: computed.getPropertyValue("--bg-primary").trim(),
        panelBackground: computed.getPropertyValue("--bg-secondary").trim(),
        border: computed.getPropertyValue("--border").trim(),
        text: computed.getPropertyValue("--text-primary").trim(),
        mutedText: computed.getPropertyValue("--text-secondary").trim(),
        accent: computed.getPropertyValue("--accent").trim(),
        cursor: computed.getPropertyValue("--accent").trim(),
        fontFamily:
            '"SFMono-Regular", "Cascadia Code", "JetBrains Mono", Menlo, Monaco, Consolas, monospace',
        fontSize: 13,
        lineHeight: 1.4,
    };
}
