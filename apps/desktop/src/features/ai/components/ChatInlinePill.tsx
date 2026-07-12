import type { CSSProperties, MouseEventHandler, ReactNode } from "react";
import { type ChatPillMetrics } from "./chatPillMetrics";
import { CHAT_PILL_VARIANTS, type ChatPillVariant } from "./chatPillPalette";

interface ChatInlinePillProps {
    appearance?: "link" | "pill";
    label: string;
    metrics: ChatPillMetrics;
    title?: string;
    interactive?: boolean;
    leadingVisual?: ReactNode;
    variant?: ChatPillVariant;
    onClick?: () => void;
    onContextMenu?: MouseEventHandler<HTMLElement>;
}

export function ChatInlinePill({
    appearance = "pill",
    label,
    metrics,
    title,
    interactive = false,
    leadingVisual,
    variant = "accent",
    onClick,
    onContextMenu,
}: ChatInlinePillProps) {
    const palette = CHAT_PILL_VARIANTS[variant];
    const clickable = interactive || typeof onClick === "function";
    const isLink = appearance === "link";
    const style: CSSProperties = {
        display: "inline-flex",
        alignItems: "center",
        margin: `0 ${metrics.gapX}px`,
        padding: isLink ? 0 : `${metrics.paddingY}px ${metrics.paddingX}px`,
        maxInlineSize: "100%",
        borderRadius: isLink ? 2 : metrics.radius,
        background: isLink ? "transparent" : palette.background,
        color: isLink ? "var(--accent)" : palette.color,
        fontSize: metrics.fontSize,
        lineHeight: metrics.lineHeight,
        border: "none",
        cursor: clickable ? "pointer" : "default",
        fontFamily: "inherit",
        verticalAlign: "baseline",
        overflowWrap: "anywhere",
        transform: `translateY(${isLink ? 2 : metrics.offsetY}px)`,
        filter: "brightness(1)",
        opacity: clickable ? 0.85 : 1,
        transition: clickable
            ? "opacity 80ms ease, filter 80ms ease"
            : undefined,
    };

    const content = (
        <span
            style={{
                alignItems: "center",
                display: "inline-flex",
                gap: leadingVisual ? 4 : 0,
                minWidth: 0,
                maxWidth: "100%",
            }}
        >
            {leadingVisual ? (
                <span
                    aria-hidden="true"
                    style={{ display: "inline-flex", flexShrink: 0 }}
                >
                    {leadingVisual}
                </span>
            ) : null}
            <span
                style={{
                    display: "block",
                    minWidth: 0,
                    maxWidth: "100%",
                    overflowWrap: "anywhere",
                    whiteSpace: "normal",
                    wordBreak: "break-word",
                }}
            >
                {label}
            </span>
        </span>
    );

    if (clickable) {
        return (
            <button
                type="button"
                onClick={onClick}
                onContextMenu={onContextMenu}
                style={style}
                title={title ?? label}
                onMouseEnter={(e) => {
                    e.currentTarget.style.opacity = "1";
                    e.currentTarget.style.filter = "brightness(1.08)";
                }}
                onMouseLeave={(e) => {
                    e.currentTarget.style.opacity = "0.85";
                    e.currentTarget.style.filter = "brightness(1)";
                }}
            >
                {content}
            </button>
        );
    }

    return (
        <span
            style={style}
            title={title ?? label}
            onContextMenu={onContextMenu}
        >
            {content}
        </span>
    );
}
