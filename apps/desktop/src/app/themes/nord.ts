import { type ThemePalette } from "./index";

export const nordTheme: ThemePalette = {
    label: "Nord",
    light: {
        bgPrimary: "#eceff4",
        bgSecondary: "#e5e9f0",
        bgTertiary: "#d8dee9",
        bgElevated: "#edf0f5",
        textPrimary: "#2e3440",
        textSecondary: "#4c566a",
        border: "#d0d6e1",
        accent: "#5e81ac",
        shadowSoft: "0 18px 48px rgba(46, 52, 64, 0.08)",
    },
    dark: {
        bgPrimary: "#2e3440",
        bgSecondary: "#3b4252",
        bgTertiary: "#434c5e",
        bgElevated: "#333a47",
        textPrimary: "#eceff4",
        textSecondary: "#d8dee9",
        border: "#4c566a",
        accent: "#88c0d0",
        shadowSoft: "0 24px 56px rgba(0, 0, 0, 0.30)",
    },
};
