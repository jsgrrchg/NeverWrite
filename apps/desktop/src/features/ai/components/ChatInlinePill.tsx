import type { MouseEventHandler, ReactNode } from "react";
import { type ChatPillMetrics } from "./chatPillMetrics";
import type { ChatPillVariant } from "./chatPillPalette";
import {
    getChatInlineLeadingVisualStyle,
    getChatInlinePillStyle,
} from "./chatInlinePillStyle";

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
    const clickable = interactive || typeof onClick === "function";
    const style = getChatInlinePillStyle({
        appearance,
        clickable,
        metrics,
        variant,
    });

    const content = (
        <span
            style={{
                alignItems: "flex-start",
                display: "inline-flex",
                gap: leadingVisual ? 4 : 0,
                minWidth: 0,
                maxWidth: "100%",
            }}
        >
            {leadingVisual ? (
                <span
                    aria-hidden="true"
                    style={getChatInlineLeadingVisualStyle(metrics)}
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
