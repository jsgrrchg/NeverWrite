import { type ThemePalette } from "./index";

export const solarizedTheme: ThemePalette = {
    label: "Solarized",
    light: {
        bgPrimary: "#fdf6e3",
        bgSecondary: "#eee8d5",
        bgTertiary: "#e4dcc8",
        bgElevated: "#fef8e6",
        textPrimary: "#073642",
        textSecondary: "#586e75",
        border: "#d3c6a6",
        accent: "#268bd2",
        shadowSoft: "0 18px 48px rgba(7, 54, 66, 0.07)",
    },
    dark: {
        bgPrimary: "#002b36",
        bgSecondary: "#073642",
        bgTertiary: "#0d4150",
        bgElevated: "#013b48",
        textPrimary: "#fdf6e3",
        textSecondary: "#93a1a1",
        border: "#11505e",
        accent: "#2aa198",
        shadowSoft: "0 24px 56px rgba(0, 0, 0, 0.40)",
    },
};
