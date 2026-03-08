import { type ThemePalette } from "./index";

export const defaultTheme: ThemePalette = {
    label: "Default",
    light: {
        bgPrimary: "#ffffff",
        bgSecondary: "#f5f5f5",
        bgTertiary: "#ebebeb",
        bgElevated: "#fcfcfc",
        textPrimary: "#1c1c1c",
        textSecondary: "#737373",
        border: "#e5e5e5",
        accent: "#6366f1",
        shadowSoft: "0 18px 48px rgba(15, 23, 42, 0.08)",
    },
    dark: {
        bgPrimary: "#1c1c1c",
        bgSecondary: "#252525",
        bgTertiary: "#2e2e2e",
        bgElevated: "#232323",
        textPrimary: "#e8e8e8",
        textSecondary: "#8a8a8a",
        border: "#383838",
        accent: "#818cf8",
        shadowSoft: "0 24px 56px rgba(0, 0, 0, 0.28)",
    },
};
