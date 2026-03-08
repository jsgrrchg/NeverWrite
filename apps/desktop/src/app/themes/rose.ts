import { type ThemePalette } from "./index";

export const roseTheme: ThemePalette = {
    label: "Rose",
    light: {
        bgPrimary: "#fefcfd",
        bgSecondary: "#f8f0f4",
        bgTertiary: "#f0e4ea",
        bgElevated: "#fffafc",
        textPrimary: "#1f1215",
        textSecondary: "#886f78",
        border: "#e8d5dc",
        accent: "#e11d48",
        shadowSoft: "0 18px 48px rgba(31, 18, 21, 0.06)",
    },
    dark: {
        bgPrimary: "#1a1215",
        bgSecondary: "#241a1e",
        bgTertiary: "#2e2228",
        bgElevated: "#1f161a",
        textPrimary: "#ede4e7",
        textSecondary: "#a8949b",
        border: "#3a2830",
        accent: "#fb7185",
        shadowSoft: "0 24px 56px rgba(0, 0, 0, 0.32)",
    },
};
