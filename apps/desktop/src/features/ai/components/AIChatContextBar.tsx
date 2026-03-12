import type { AIAttachmentStatus, AIAttachmentType } from "../types";

interface ContextBarAttachment {
    id: string;
    label: string;
    path: string | null;
    removable?: boolean;
    type?: AIAttachmentType;
    status?: AIAttachmentStatus;
    errorMessage?: string;
}

interface AIChatContextBarProps {
    attachments: ContextBarAttachment[];
    onRemoveAttachment: (attachmentId: string) => void;
    onClearAll?: () => void;
}

function normalizeAttachmentLabel(label: string) {
    return label.replace(/^📁\s*/u, "");
}

function AttachmentIcon({ type }: { type?: AIAttachmentType }) {
    if (type === "audio") {
        return (
            <svg
                width="11"
                height="11"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                <path d="M8 1v8M5 6a3 3 0 0 0 6 0M6 12h4M8 12v2" />
            </svg>
        );
    }
    if (type === "file") {
        return (
            <svg
                width="11"
                height="11"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                <path d="M9 1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5L9 1Z" />
                <path d="M9 1v4h4" />
            </svg>
        );
    }
    if (type === "folder") {
        return (
            <svg
                width="11"
                height="11"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                <path d="M2 4v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H8L6.5 2.5A1 1 0 0 0 5.8 2H4a2 2 0 0 0-2 2Z" />
            </svg>
        );
    }
    return null;
}

function StatusIndicator({
    status,
    errorMessage,
}: {
    status?: AIAttachmentStatus;
    errorMessage?: string;
}) {
    if (status === "processing") {
        return (
            <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                className="animate-spin"
                style={{ color: "var(--accent)" }}
            >
                <circle
                    cx="5"
                    cy="5"
                    r="4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeDasharray="16"
                    strokeDashoffset="4"
                    strokeLinecap="round"
                />
            </svg>
        );
    }
    if (status === "error") {
        return (
            <span
                title={errorMessage ?? "Error"}
                style={{ color: "#ef4444", fontSize: 10, lineHeight: 1 }}
            >
                !
            </span>
        );
    }
    return null;
}

export function AIChatContextBar({
    attachments,
    onRemoveAttachment,
    onClearAll,
}: AIChatContextBarProps) {
    if (attachments.length === 0) return null;

    const removableCount = attachments.filter(
        (a) => a.removable !== false,
    ).length;

    return (
        <div className="flex flex-wrap items-center gap-1.5">
            {attachments.map((attachment) => {
                const displayLabel = normalizeAttachmentLabel(attachment.label);
                const showIcon =
                    attachment.type === "audio" ||
                    attachment.type === "file" ||
                    attachment.type === "folder";
                return (
                    <div
                        key={attachment.id}
                        className="flex items-center gap-1 rounded-md py-0.5 pl-2 pr-1"
                        style={{
                            backgroundColor:
                                attachment.status === "error"
                                    ? "color-mix(in srgb, #ef4444 12%, transparent)"
                                    : "color-mix(in srgb, var(--bg-tertiary) 50%, transparent)",
                        }}
                    >
                        {showIcon && (
                            <span
                                style={{
                                    color: "var(--text-secondary)",
                                    opacity: 0.7,
                                    display: "flex",
                                }}
                            >
                                <AttachmentIcon type={attachment.type} />
                            </span>
                        )}
                        <span
                            className="max-w-[150px] truncate text-xs"
                            style={{ color: "var(--text-secondary)" }}
                            title={
                                attachment.errorMessage ??
                                attachment.path ??
                                displayLabel
                            }
                        >
                            {displayLabel}
                        </span>
                        <StatusIndicator
                            status={attachment.status}
                            errorMessage={attachment.errorMessage}
                        />
                        <button
                            type="button"
                            onClick={() => onRemoveAttachment(attachment.id)}
                            className="flex items-center justify-center rounded p-0.5 text-xs"
                            style={{
                                color: "var(--text-secondary)",
                                backgroundColor: "transparent",
                                border: "none",
                                opacity: 0.6,
                            }}
                            aria-label={`Remove ${displayLabel}`}
                            disabled={attachment.removable === false}
                        >
                            {attachment.removable === false ? "•" : "×"}
                        </button>
                    </div>
                );
            })}
            {removableCount >= 2 && onClearAll && (
                <button
                    type="button"
                    onClick={onClearAll}
                    className="rounded-md px-1.5 py-0.5 text-xs"
                    style={{
                        color: "var(--text-secondary)",
                        backgroundColor: "transparent",
                        border: "none",
                        opacity: 0.6,
                    }}
                    title="Remove all context notes"
                    aria-label="Clear all attachments"
                >
                    Clear all
                </button>
            )}
        </div>
    );
}
