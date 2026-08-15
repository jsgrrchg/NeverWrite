import type { EditorFontFamily } from "../store/settingsStore";

export function resolveFontFamily(fontFamily: EditorFontFamily) {
    switch (fontFamily) {
        case "sans":
            return '"Inter", "IBM Plex Sans", "Avenir Next", "Segoe UI", sans-serif';
        case "geist":
            return '"Geist", "Inter", system-ui, sans-serif';
        case "atkinson":
            return '"Atkinson Hyperlegible", system-ui, sans-serif';
        case "serif":
            return '"Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif';
        case "literata":
            return '"Literata", Georgia, serif';
        case "lora":
            return '"Lora", "Palatino Linotype", Georgia, serif';
        case "merriweather":
            return '"Merriweather", Georgia, serif';
        case "source-serif":
            return '"Source Serif 4", Georgia, "Iowan Old Style", serif';
        case "mono":
            return '"JetBrains Mono", "SFMono-Regular", "Fira Code", Menlo, Monaco, Consolas, monospace';
        case "jetbrains":
            return '"JetBrains Mono", "Fira Code", Menlo, Monaco, Consolas, monospace';
        case "fliege-mono":
            return '"Fliege Mono", "JetBrains Mono", Menlo, Monaco, Consolas, monospace';
        case "geist-mono":
            return '"Geist Mono", "JetBrains Mono", Menlo, Monaco, Consolas, monospace';
        case "ibm-plex-mono":
            return '"IBM Plex Mono", "JetBrains Mono", Menlo, Monaco, Consolas, monospace';
        case "courier":
            return '"Courier New", Courier, "Nimbus Mono PS", monospace';
        case "reading":
            return '"Charter", "Baskerville", "Georgia", serif';
        case "rounded":
            return '"SF Pro Rounded", "Nunito", "Avenir Next Rounded", "Hiragino Maru Gothic ProN", sans-serif';
        case "humanist":
            return '"Optima", "Gill Sans", "Trebuchet MS", "Segoe UI", sans-serif';
        case "slab":
            return '"Rockwell", "Clarendon Text", "Roboto Slab", "Courier Prime", serif';
        case "typewriter":
            return '"American Typewriter", "Courier Prime", "Courier New", "Nimbus Mono PS", monospace';
        case "newspaper":
            return '"Times New Roman", "Georgia", "Source Serif 4", "Iowan Old Style", serif';
        case "condensed":
            return '"Avenir Next Condensed", "Arial Narrow", "Roboto Condensed", "Helvetica Neue", sans-serif';
        case "andale":
            return '"Andale Mono", Menlo, Monaco, Consolas, monospace';
        case "system":
        default:
            return 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    }
}
