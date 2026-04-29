import { type ThemePalette } from "./index";

export const synthwave84Theme: ThemePalette = {
    label: "Synthwave '84",
    light: {
        bgPrimary: "#faf5ff",
        bgSecondary: "#f0eaf8",
        bgTertiary: "#e4dcf0",
        bgElevated: "#fdf9ff",
        textPrimary: "#2a2139",
        textSecondary: "#695d85",
        textHeading: "color-mix(in srgb, var(--accent) 10%, var(--text-primary))",
        textHeadingMuted: "#695d85",
        border: "#dbd2ec",
        accent: "#d946a8",
        iconMuted: "#695d85",
        shadowSoft: "0 18px 48px rgba(42, 33, 57, 0.10)",
    },
    dark: {
        bgPrimary: "#262335",
        bgSecondary: "#241b2f",
        bgTertiary: "#2a2139",
        bgElevated: "#1e1a2c",
        textPrimary: "#ffffff",
        textSecondary: "#848bbd",
        textHeading: "color-mix(in srgb, var(--accent) 14%, var(--text-primary))",
        textHeadingMuted: "#848bbd",
        border: "#34294f",
        accent: "#ff7edb",
        iconMuted: "#7a73a6",
        shadowSoft: "0 24px 56px rgba(0, 0, 0, 0.40)",
    },
};
