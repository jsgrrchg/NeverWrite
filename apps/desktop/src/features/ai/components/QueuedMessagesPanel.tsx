import { useState } from "react";
import { cleanPillMarkers } from "../composerParts";
import type { QueuedChatMessage } from "../types";

interface QueuedMessagesPanelProps {
    items: QueuedChatMessage[];
    editingItem?: QueuedChatMessage | null;
    onCancel: (messageId: string) => void;
    onClearAll: () => void;
    onEdit: (messageId: string) => void;
    onSendNow: (messageId: string) => void;
    onCancelEdit: () => void;
}

function summarizeContent(content: string) {
    return cleanPillMarkers(content) || "Untitled message";
}

function getQueueTitle(count: number) {
    return count === 1 ? "1 Queued Message" : `${count} Queued Messages`;
}

function getStatusColor(status: QueuedChatMessage["status"]) {
    if (status === "failed") return "var(--diff-remove)";
    return "var(--accent)";
}

type StripIconButtonVariant = "neutral" | "danger" | "accent";

function StripIconButton({
    variant,
    title,
    ariaLabel,
    disabled,
    onClick,
    children,
}: {
    variant: StripIconButtonVariant;
    title: string;
    ariaLabel?: string;
    disabled?: boolean;
    onClick: () => void;
    children: React.ReactElement;
}) {
    const [hovered, setHovered] = useState(false);
    const interactive = !disabled;
    const accent =
        variant === "danger"
            ? "var(--diff-remove)"
            : variant === "accent"
              ? "var(--accent)"
              : "var(--text-secondary)";

    const baseColor = interactive
        ? variant === "neutral"
            ? "var(--text-secondary)"
            : accent
        : "var(--text-secondary)";

    return (
        <button
            type="button"
            title={title}
            aria-label={ariaLabel ?? title}
            disabled={disabled}
            onClick={onClick}
            onMouseEnter={() => interactive && setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            className="flex h-6 w-6 items-center justify-center rounded-sm transition-colors"
            style={{
                color: baseColor,
                opacity: interactive ? (hovered ? 1 : 0.75) : 0.35,
                backgroundColor:
                    hovered && interactive
                        ? `color-mix(in srgb, ${accent} 14%, transparent)`
                        : "transparent",
                border: "none",
                cursor: interactive ? "pointer" : "not-allowed",
            }}
        >
            {children}
        </button>
    );
}

const STRIP_PANEL_STYLE: React.CSSProperties = {
    backgroundColor: "color-mix(in srgb, var(--bg-secondary) 60%, transparent)",
    borderTop: "1px solid color-mix(in srgb, var(--border) 50%, transparent)",
    borderBottom:
        "1px solid color-mix(in srgb, var(--border) 50%, transparent)",
};

const STRIP_HEADER_LABEL_STYLE: React.CSSProperties = {
    color: "var(--text-secondary)",
    fontSize: "0.68em",
    letterSpacing: "0.12em",
    fontWeight: 600,
};

export function QueuedMessagesPanel({
    items,
    editingItem = null,
    onCancel,
    onClearAll,
    onEdit,
    onSendNow,
    onCancelEdit,
}: QueuedMessagesPanelProps) {
    const [collapsed, setCollapsed] = useState(false);
    const effectiveCollapsed = editingItem ? false : collapsed;

    if (items.length === 0 && !editingItem) return null;

    return (
        <div className="mb-1" style={STRIP_PANEL_STYLE}>
            {items.length > 0 && (
                <div
                    className="flex items-center justify-between gap-2.5 px-3 py-1"
                    style={{
                        borderBottom:
                            !effectiveCollapsed &&
                            (editingItem || items.length > 0)
                                ? "1px solid color-mix(in srgb, var(--border) 35%, transparent)"
                                : "none",
                    }}
                >
                    <button
                        type="button"
                        onClick={() => setCollapsed((value) => !value)}
                        className="inline-flex items-center gap-1.5 bg-transparent p-0"
                        style={{ border: "none", cursor: "pointer" }}
                        aria-label={
                            effectiveCollapsed
                                ? "Expand queue"
                                : "Collapse queue"
                        }
                        aria-expanded={!effectiveCollapsed}
                    >
                        <svg
                            width="9"
                            height="9"
                            viewBox="0 0 10 10"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.6"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                            style={{
                                color: "var(--text-secondary)",
                                transform: effectiveCollapsed
                                    ? "rotate(-90deg)"
                                    : "rotate(0deg)",
                                transition: "transform 0.15s ease",
                            }}
                        >
                            <path d="M2.5 4L5 6.5L7.5 4" />
                        </svg>
                        <span
                            className="uppercase"
                            style={STRIP_HEADER_LABEL_STYLE}
                        >
                            {getQueueTitle(items.length)}
                        </span>
                    </button>
                    <button
                        type="button"
                        onClick={onClearAll}
                        className="rounded-sm px-1.5 py-0.5 uppercase"
                        style={{
                            color: "var(--text-secondary)",
                            backgroundColor: "transparent",
                            border: "none",
                            cursor: "pointer",
                            fontSize: "0.62em",
                            letterSpacing: "0.1em",
                            fontWeight: 600,
                            opacity: 0.85,
                        }}
                    >
                        Clear All
                    </button>
                </div>
            )}

            {!effectiveCollapsed && editingItem && (
                <div
                    className="flex items-center justify-between gap-2.5 px-3 py-1.5"
                    style={{
                        borderBottom:
                            items.length > 0
                                ? "1px solid color-mix(in srgb, var(--border) 35%, transparent)"
                                : "none",
                    }}
                >
                    <div className="min-w-0">
                        <div
                            className="uppercase"
                            style={{
                                color: "var(--accent)",
                                fontSize: "0.62em",
                                letterSpacing: "0.12em",
                                fontWeight: 600,
                            }}
                        >
                            Editing queued message
                        </div>
                        <div
                            className="mt-0.5 truncate text-sm"
                            style={{ color: "var(--text-primary)" }}
                            title={editingItem.content}
                        >
                            {summarizeContent(editingItem.content)}
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={onCancelEdit}
                        className="shrink-0 rounded-sm px-1.5 py-0.5 uppercase"
                        style={{
                            color: "var(--text-secondary)",
                            backgroundColor: "transparent",
                            border: "none",
                            cursor: "pointer",
                            fontSize: "0.62em",
                            letterSpacing: "0.1em",
                            fontWeight: 600,
                        }}
                    >
                        Cancel Edit
                    </button>
                </div>
            )}

            {!effectiveCollapsed && (
                <div className="flex flex-col">
                    {items.map((item, index) => {
                        const sending = item.status === "sending";
                        const summary = summarizeContent(item.content);

                        return (
                            <div
                                key={item.id}
                                className="flex items-center gap-2 px-3 py-1"
                                style={{
                                    borderTop:
                                        index === 0 && !editingItem
                                            ? "none"
                                            : "1px solid color-mix(in srgb, var(--border) 25%, transparent)",
                                }}
                            >
                                <span
                                    aria-hidden="true"
                                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                                    style={{
                                        backgroundColor: getStatusColor(
                                            item.status,
                                        ),
                                        opacity: sending ? 1 : 0.85,
                                    }}
                                />
                                <div className="min-w-0 flex-1">
                                    <div
                                        className="truncate text-sm"
                                        style={{
                                            color: "var(--text-primary)",
                                            fontSize: "0.84em",
                                        }}
                                        title={item.content}
                                    >
                                        {summary}
                                    </div>
                                </div>
                                <div className="flex shrink-0 items-center gap-0.5">
                                    <StripIconButton
                                        variant="danger"
                                        title="Delete"
                                        ariaLabel={`Delete ${summary}`}
                                        disabled={sending}
                                        onClick={() => onCancel(item.id)}
                                    >
                                        <svg
                                            width="12"
                                            height="12"
                                            viewBox="0 0 14 14"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="1.5"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            aria-hidden="true"
                                        >
                                            <path d="M3 4h8" />
                                            <path d="M5.5 4V2.7a.6.6 0 0 1 .6-.6h1.8a.6.6 0 0 1 .6.6V4" />
                                            <path d="M4.2 4l.6 7.2a.6.6 0 0 0 .6.5h3.2a.6.6 0 0 0 .6-.5l.6-7.2" />
                                        </svg>
                                    </StripIconButton>
                                    {!sending && (
                                        <StripIconButton
                                            variant="neutral"
                                            title="Edit"
                                            ariaLabel={`Edit ${summary}`}
                                            onClick={() => onEdit(item.id)}
                                        >
                                            <svg
                                                width="12"
                                                height="12"
                                                viewBox="0 0 14 14"
                                                fill="none"
                                                stroke="currentColor"
                                                strokeWidth="1.5"
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                aria-hidden="true"
                                            >
                                                <path d="M9 2.5l2.5 2.5-7 7H2v-2.5z" />
                                            </svg>
                                        </StripIconButton>
                                    )}
                                    <StripIconButton
                                        variant="accent"
                                        title="Send now"
                                        disabled={sending}
                                        onClick={() => onSendNow(item.id)}
                                    >
                                        <svg
                                            width="12"
                                            height="12"
                                            viewBox="0 0 14 14"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="1.6"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            aria-hidden="true"
                                        >
                                            <path d="M2.5 7h8.5" />
                                            <path d="M7.5 3l4 4-4 4" />
                                        </svg>
                                    </StripIconButton>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
