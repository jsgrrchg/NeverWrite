import type { AIChatAttachment } from "../types";

interface AIChatContextBarProps {
    attachments: AIChatAttachment[];
    onRemoveAttachment: (attachmentId: string) => void;
}

export function AIChatContextBar({
    attachments,
    onRemoveAttachment,
}: AIChatContextBarProps) {
    if (attachments.length === 0) return null;

    return (
        <div className="flex flex-wrap gap-1.5">
            {attachments.map((attachment) => (
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
                        title={attachment.path ?? attachment.label}
                    >
                        {attachment.label}
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
                        aria-label={`Remove ${attachment.label}`}
                    >
                        ×
                    </button>
                </div>
            ))}
        </div>
    );
}
