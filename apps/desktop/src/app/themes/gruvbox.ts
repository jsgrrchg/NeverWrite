import { type ThemePalette } from "./index";

export const gruvboxTheme: ThemePalette = {
    label: "Gruvbox",
    light: {
        bgPrimary: "#fbf1c7",
        bgSecondary: "#f2e5bc",
        bgTertiary: "#e4d5a0",
        bgElevated: "#fdf4d0",
        textPrimary: "#3c3836",
        textSecondary: "#7c6f64",
        border: "#d5c4a1",
        accent: "#427b58",
        iconMuted: "#7c6f64",
        shadowSoft: "0 18px 48px rgba(60, 56, 54, 0.07)",
    },
    dark: {
        bgPrimary: "#282828",
        bgSecondary: "#3c3836",
        bgTertiary: "#504945",
        bgElevated: "#32302f",
        textPrimary: "#ebdbb2",
        textSecondary: "#a89984",
        border: "#504945",
        accent: "#8ec07c",
        iconMuted: "#a89984",
        shadowSoft: "0 24px 56px rgba(0, 0, 0, 0.35)",
    },
};
