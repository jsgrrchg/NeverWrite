import { type ThemePalette } from "./index";

export const sunsetTheme: ThemePalette = {
    label: "Sunset",
    light: {
        bgPrimary: "#fefaf8",
        bgSecondary: "#f8efe8",
        bgTertiary: "#f0e2d6",
        bgElevated: "#fffbf9",
        textPrimary: "#21150e",
        textSecondary: "#8c6e5a",
        border: "#e6d4c4",
        accent: "#ea580c",
        iconMuted: "#8c6e5a",
        shadowSoft: "0 18px 48px rgba(33, 21, 14, 0.07)",
    },
    dark: {
        bgPrimary: "#1a1410",
        bgSecondary: "#251d17",
        bgTertiary: "#30261e",
        bgElevated: "#1f1914",
        textPrimary: "#ece2d8",
        textSecondary: "#a8917e",
        border: "#3c3028",
        accent: "#fb923c",
        iconMuted: "#9e8774",
        shadowSoft: "0 24px 56px rgba(0, 0, 0, 0.32)",
    },
};
