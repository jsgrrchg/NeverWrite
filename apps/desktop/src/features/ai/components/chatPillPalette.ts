export type ChatPillVariant =
    | "accent"
    | "success"
    | "neutral"
    | "folder"
    | "file";

export const CHAT_PILL_VARIANTS: Record<
    ChatPillVariant,
    { background: string; color: string }
> = {
    accent: {
        background: "color-mix(in srgb, var(--accent) 15%, transparent)",
        color: "var(--accent)",
    },
    success: {
        background: "color-mix(in srgb, #10b981 15%, transparent)",
        color: "#10b981",
    },
    neutral: {
        background: "color-mix(in srgb, var(--bg-tertiary) 84%, transparent)",
        color: "var(--text-secondary)",
    },
    folder: {
        background:
            "color-mix(in srgb, var(--text-secondary) 12%, var(--bg-tertiary))",
        color:
            "color-mix(in srgb, var(--text-secondary) 84%, var(--text-primary))",
    },
    file: {
        background: "color-mix(in srgb, #d97706 12%, transparent)",
        color: "#d97706",
    },
};
