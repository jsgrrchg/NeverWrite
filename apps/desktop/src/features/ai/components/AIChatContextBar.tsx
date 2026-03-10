interface AIChatContextBarProps {
    attachments: Array<{
        id: string;
        label: string;
        path: string | null;
        removable?: boolean;
    }>;
    onRemoveAttachment: (attachmentId: string) => void;
    onClearAll?: () => void;
}

function normalizeAttachmentLabel(label: string) {
    return label.replace(/^📁\s*/u, "");
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
                return (
                    <div
                        key={attachment.id}
                        className="flex items-center gap-1 rounded-md py-0.5 pl-2 pr-1"
                        style={{
                            backgroundColor:
                                "color-mix(in srgb, var(--bg-tertiary) 50%, transparent)",
                        }}
                    >
                        <span
                            className="max-w-[150px] truncate text-xs"
                            style={{ color: "var(--text-secondary)" }}
                            title={attachment.path ?? displayLabel}
                        >
                            {displayLabel}
                        </span>
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
