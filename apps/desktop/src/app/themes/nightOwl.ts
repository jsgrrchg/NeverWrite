import { type ThemePalette } from "./index";

export const nightOwlTheme: ThemePalette = {
    label: "Night Owl",
    light: {
        bgPrimary: "#fbfbfb",
        bgSecondary: "#f0f0f0",
        bgTertiary: "#e4e4e4",
        bgElevated: "#f6f6f6",
        textPrimary: "#403f53",
        textSecondary: "#7e8a9e",
        border: "#d9d9d9",
        accent: "#2aa298",
        shadowSoft: "0 18px 48px rgba(64, 63, 83, 0.08)",
    },
    dark: {
        bgPrimary: "#011627",
        bgSecondary: "#01111d",
        bgTertiary: "#0b253a",
        bgElevated: "#021d32",
        textPrimary: "#d6deeb",
        textSecondary: "#5f7e97",
        border: "#122d42",
        accent: "#82aaff",
        shadowSoft: "0 24px 56px rgba(0, 0, 0, 0.40)",
    },
};
