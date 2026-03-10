import type { CSSProperties } from "react";
import type { ChatPillMetrics } from "./chatPillMetrics";

interface ChatInlinePillProps {
    label: string;
    metrics: ChatPillMetrics;
    title?: string;
    interactive?: boolean;
    variant?: "accent" | "success" | "neutral" | "folder" | "file";
    onClick?: () => void;
}

const PILL_VARIANTS = {
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
} as const;

export function ChatInlinePill({
    label,
    metrics,
    title,
    interactive = false,
    variant = "accent",
    onClick,
}: ChatInlinePillProps) {
    const palette = PILL_VARIANTS[variant];
    const clickable = interactive || typeof onClick === "function";
    const style: CSSProperties = {
        display: "inline-flex",
        alignItems: "center",
        margin: `0 ${metrics.gapX}px`,
        padding: `${metrics.paddingY}px ${metrics.paddingX}px`,
        maxInlineSize: metrics.maxWidth,
        borderRadius: metrics.radius,
        background: palette.background,
        color: palette.color,
        fontSize: metrics.fontSize,
        lineHeight: metrics.lineHeight,
        border: "none",
        cursor: clickable ? "pointer" : "default",
        fontFamily: "inherit",
        verticalAlign: "baseline",
        overflow: "hidden",
        transform: `translateY(${metrics.offsetY}px)`,
    };

    const content = (
        <span
            style={{
                display: "block",
                minWidth: 0,
                maxWidth: "100%",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
            }}
        >
            {label}
        </span>
    );

    if (clickable) {
        return (
            <button type="button" onClick={onClick} style={style} title={title}>
                {content}
            </button>
        );
    }

    return (
        <span style={style} title={title}>
            {content}
        </span>
    );
}
