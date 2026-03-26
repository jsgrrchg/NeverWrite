import { type ThemePalette } from "./index";

export const lavenderTheme: ThemePalette = {
    label: "Lavender",
    light: {
        bgPrimary: "#fcfaff",
        bgSecondary: "#f3eefb",
        bgTertiary: "#e8e0f5",
        bgElevated: "#fdfbff",
        textPrimary: "#1a1525",
        textSecondary: "#7c6f96",
        border: "#ddd4ec",
        accent: "#8b5cf6",
        iconMuted: "#7c6f96",
        shadowSoft: "0 18px 48px rgba(26, 21, 37, 0.07)",
    },
    dark: {
        bgPrimary: "#18141f",
        bgSecondary: "#211c2a",
        bgTertiary: "#2b2536",
        bgElevated: "#1c1825",
        textPrimary: "#e8e2f0",
        textSecondary: "#9b90ad",
        border: "#352e42",
        accent: "#a78bfa",
        iconMuted: "#8d82a3",
        shadowSoft: "0 24px 56px rgba(0, 0, 0, 0.32)",
    },
};
