import { useState, type MouseEvent } from "react";
import {
    ContextMenu,
    type ContextMenuState,
} from "../../../components/context-menu/ContextMenu";
import type { AIAttachmentStatus, AIAttachmentType } from "../types";
import { openChatNoteById } from "./chatNoteNavigation";
import { truncatePillLabel } from "./chatPillMetrics";
import { CHAT_PILL_VARIANTS, type ChatPillVariant } from "./chatPillPalette";

interface ContextBarAttachment {
    id: string;
    noteId?: string | null;
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

interface AttachmentContextMenuPayload {
    attachmentId: string;
    noteId: string;
}

function normalizeAttachmentLabel(label: string) {
    return label.replace(/^📁\s*/u, "");
}

function getAttachmentVariant(type?: AIAttachmentType): ChatPillVariant {
    if (type === "folder") return "folder";
    if (type === "file") return "file";
    if (type === "audio") return "neutral";
    return "accent";
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
    if (type === "selection") {
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
                <path d="M3 4h10M3 8h10M3 12h6" />
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
    const [contextMenu, setContextMenu] =
        useState<ContextMenuState<AttachmentContextMenuPayload> | null>(null);
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
                    attachment.type === "folder" ||
                    attachment.type === "selection";
                const palette =
                    CHAT_PILL_VARIANTS[getAttachmentVariant(attachment.type)];
                const isError = attachment.status === "error";
                const foregroundColor = isError ? "#ef4444" : palette.color;
                return (
                    <div
                        key={attachment.id}
                        className="flex items-center gap-1 rounded-md py-0.5 pl-2 pr-1"
                        style={{
                            backgroundColor: isError
                                ? "color-mix(in srgb, #ef4444 12%, transparent)"
                                : palette.background,
                        }}
                        onContextMenu={(event: MouseEvent<HTMLDivElement>) => {
                            if (
                                !attachment.noteId ||
                                (attachment.type !== "note" &&
                                    attachment.type !== "current_note" &&
                                    attachment.type !== "selection")
                            ) {
                                return;
                            }

                            event.preventDefault();
                            event.stopPropagation();
                            setContextMenu({
                                x: event.clientX,
                                y: event.clientY,
                                payload: {
                                    attachmentId: attachment.id,
                                    noteId: attachment.noteId,
                                },
                            });
                        }}
                    >
                        {showIcon && (
                            <span
                                style={{
                                    color: foregroundColor,
                                    opacity: isError ? 1 : 0.8,
                                    display: "flex",
                                }}
                            >
                                <AttachmentIcon type={attachment.type} />
                            </span>
                        )}
                        <span
                            className="max-w-[150px] truncate text-xs"
                            style={{ color: foregroundColor }}
                            title={
                                attachment.errorMessage ??
                                attachment.path ??
                                displayLabel
                            }
                        >
                            {truncatePillLabel(displayLabel)}
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
                                color: foregroundColor,
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
            {contextMenu ? (
                <ContextMenu
                    menu={contextMenu}
                    onClose={() => setContextMenu(null)}
                    entries={[
                        {
                            label: "Open in New Tab",
                            action: () => {
                                void openChatNoteById(
                                    contextMenu.payload.noteId,
                                    { newTab: true },
                                );
                            },
                        },
                    ]}
                />
            ) : null}
        </div>
    );
}
