import type { CSSProperties } from "react";
import { CHAT_PILL_VARIANTS, type ChatPillVariant } from "./chatPillPalette";
import type { ChatPillMetrics } from "./chatPillMetrics";

export function getChatInlinePillStyle({
    appearance,
    clickable,
    metrics,
    variant,
}: {
    appearance: "link" | "pill";
    clickable: boolean;
    metrics: ChatPillMetrics;
    variant: ChatPillVariant;
}): CSSProperties {
    const palette = CHAT_PILL_VARIANTS[variant];
    const isLink = appearance === "link";
    return {
        display: "inline-flex",
        alignItems: "center",
        margin: `0 ${metrics.gapX}px`,
        padding: isLink ? "0px" : `${metrics.paddingY}px ${metrics.paddingX}px`,
        maxInlineSize: "100%",
        borderRadius: `${isLink ? 2 : metrics.radius}px`,
        background: isLink ? "transparent" : palette.background,
        color: isLink ? "var(--accent)" : palette.color,
        fontSize: `${metrics.fontSize}px`,
        lineHeight: String(metrics.lineHeight),
        border: "none",
        cursor: clickable ? "pointer" : "default",
        fontFamily: "inherit",
        verticalAlign: "baseline",
        overflowWrap: "anywhere",
        transform: `translateY(${isLink ? 2 : metrics.offsetY}px)`,
        filter: "brightness(1)",
        opacity: String(clickable ? 0.85 : 1),
        transition: clickable
            ? "opacity 80ms ease, filter 80ms ease"
            : undefined,
    };
}
