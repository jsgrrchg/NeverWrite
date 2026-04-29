import { type ThemePalette } from "./index";

export const rosePineTheme: ThemePalette = {
    label: "Rosé Pine",
    light: {
        bgPrimary: "#faf4ed",
        bgSecondary: "#f2e9e1",
        bgTertiary: "#e6ddd4",
        bgElevated: "#fffaf3",
        textPrimary: "#575279",
        textSecondary: "#9893a5",
        textHeading: "color-mix(in srgb, var(--accent) 10%, var(--text-primary))",
        textHeadingMuted: "#9893a5",
        border: "#dfd8cf",
        accent: "#d7827e",
        iconMuted: "#9893a5",
        shadowSoft: "0 18px 48px rgba(87, 82, 121, 0.08)",
    },
    dark: {
        bgPrimary: "#191724",
        bgSecondary: "#1f1d2e",
        bgTertiary: "#26233a",
        bgElevated: "#211f30",
        textPrimary: "#e0def4",
        textSecondary: "#908caa",
        textHeading: "color-mix(in srgb, var(--accent) 14%, var(--text-primary))",
        textHeadingMuted: "#908caa",
        border: "#2a2740",
        accent: "#ebbcba",
        iconMuted: "#7e79a0",
        shadowSoft: "0 24px 56px rgba(0, 0, 0, 0.35)",
    },
};
