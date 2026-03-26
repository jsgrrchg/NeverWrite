import { type ThemePalette } from "./index";

export const tokyoNightTheme: ThemePalette = {
    label: "Tokyo Night",
    light: {
        bgPrimary: "#e1e2e7",
        bgSecondary: "#d5d6db",
        bgTertiary: "#c8c9ce",
        bgElevated: "#e8e9ee",
        textPrimary: "#343b59",
        textSecondary: "#6172b0",
        border: "#c0c1c6",
        accent: "#2e7de9",
        iconMuted: "#6172b0",
        shadowSoft: "0 18px 48px rgba(52, 59, 89, 0.08)",
    },
    dark: {
        bgPrimary: "#1a1b26",
        bgSecondary: "#222337",
        bgTertiary: "#292e42",
        bgElevated: "#1e1f30",
        textPrimary: "#c0caf5",
        textSecondary: "#7982a9",
        border: "#33384e",
        accent: "#7aa2f7",
        iconMuted: "#8891b3",
        shadowSoft: "0 24px 56px rgba(0, 0, 0, 0.38)",
    },
};
