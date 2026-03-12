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
    const normalized = content.replace(/\s+/g, " ").trim();
    return normalized || "Untitled message";
}

function getQueueTitle(count: number) {
    return count === 1 ? "1 Queued Message" : `${count} Queued Messages`;
}

function getStatusColor(status: QueuedChatMessage["status"]) {
    if (status === "failed") return "#ef4444";
    if (status === "sending") return "var(--accent)";
    return "#8b5cf6";
}

export function QueuedMessagesPanel({
    items,
    editingItem = null,
    onCancel,
    onClearAll,
    onEdit,
    onSendNow,
    onCancelEdit,
}: QueuedMessagesPanelProps) {
    if (items.length === 0 && !editingItem) return null;

    return (
        <div
            className="mb-2 overflow-hidden rounded-xl"
            style={{
                border: "1px solid color-mix(in srgb, var(--border) 88%, transparent)",
                backgroundColor:
                    "color-mix(in srgb, var(--bg-tertiary) 84%, transparent)",
            }}
        >
            {items.length > 0 && (
                <div
                    className="flex items-center justify-between gap-3 px-3 py-2"
                    style={{
                        borderBottom:
                            editingItem || items.length > 0
                                ? "1px solid color-mix(in srgb, var(--border) 80%, transparent)"
                                : "none",
                    }}
                >
                    <div
                        className="text-sm font-medium"
                        style={{ color: "var(--text-secondary)" }}
                    >
                        {getQueueTitle(items.length)}
                    </div>
                    <button
                        type="button"
                        onClick={onClearAll}
                        className="rounded-md px-2 py-1 text-xs"
                        style={{
                            color: "var(--text-secondary)",
                            backgroundColor: "transparent",
                            border: "none",
                        }}
                    >
                        Clear All
                    </button>
                </div>
            )}

            {editingItem && (
                <div
                    className="flex items-center justify-between gap-3 px-3 py-2"
                    style={{
                        borderBottom:
                            items.length > 0
                                ? "1px solid color-mix(in srgb, var(--border) 75%, transparent)"
                                : "none",
                    }}
                >
                    <div className="min-w-0">
                        <div
                            className="text-[11px] uppercase"
                            style={{
                                color: "var(--accent)",
                                letterSpacing: "0.12em",
                            }}
                        >
                            Editing queued message
                        </div>
                        <div
                            className="mt-1 truncate text-sm"
                            style={{ color: "var(--text-primary)" }}
                            title={editingItem.content}
                        >
                            {summarizeContent(editingItem.content)}
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={onCancelEdit}
                        className="shrink-0 rounded-md px-2 py-1 text-xs"
                        style={{
                            color: "var(--text-secondary)",
                            backgroundColor: "transparent",
                            border: "none",
                        }}
                    >
                        Cancel Edit
                    </button>
                </div>
            )}

            <div className="flex flex-col">
                {items.map((item, index) => {
                    const sending = item.status === "sending";
                    const failed = item.status === "failed";

                    return (
                        <div
                            key={item.id}
                            className="flex items-center gap-3 px-3 py-2"
                            style={{
                                borderTop:
                                    index === 0 && !editingItem
                                        ? "none"
                                        : "1px solid color-mix(in srgb, var(--border) 72%, transparent)",
                            }}
                        >
                            <span
                                aria-hidden="true"
                                className="h-2 w-2 shrink-0 rounded-full"
                                style={{
                                    backgroundColor: getStatusColor(item.status),
                                    opacity: sending ? 1 : 0.9,
                                }}
                            />
                            <div className="min-w-0 flex-1">
                                <div
                                    className="truncate text-sm"
                                    style={{ color: "var(--text-primary)" }}
                                    title={item.content}
                                >
                                    {summarizeContent(item.content)}
                                </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                                <button
                                    type="button"
                                    onClick={() => onCancel(item.id)}
                                    className="rounded-md px-2 py-1 text-xs"
                                    style={{
                                        color: "var(--text-secondary)",
                                        backgroundColor: "transparent",
                                        border: "none",
                                        opacity: sending ? 0.45 : 1,
                                    }}
                                    disabled={sending}
                                    aria-label={`Delete ${summarizeContent(item.content)}`}
                                >
                                    Delete
                                </button>
                                {!sending && (
                                    <button
                                        type="button"
                                        onClick={() => onEdit(item.id)}
                                        className="rounded-md px-2 py-1 text-xs"
                                        style={{
                                            color: "var(--text-secondary)",
                                            backgroundColor: "transparent",
                                            border: "none",
                                        }}
                                        aria-label={`Edit ${summarizeContent(item.content)}`}
                                    >
                                        Edit
                                    </button>
                                )}
                                <button
                                    type="button"
                                    onClick={() => onSendNow(item.id)}
                                    className="rounded-md px-2.5 py-1 text-xs"
                                    style={{
                                        color: failed
                                            ? "#ef4444"
                                            : "var(--accent)",
                                        backgroundColor:
                                            "color-mix(in srgb, var(--bg-secondary) 92%, transparent)",
                                        border:
                                            failed
                                                ? "1px solid color-mix(in srgb, #ef4444 45%, var(--border))"
                                                : "1px solid color-mix(in srgb, var(--accent) 55%, var(--border))",
                                        opacity: sending ? 0.45 : 1,
                                    }}
                                    disabled={sending}
                                >
                                    Send Now
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
