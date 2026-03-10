import { invoke } from "@tauri-apps/api/core";
import { useState, type ReactElement } from "react";
import type { AIChatMessage } from "../types";
import { ChatInlinePill } from "./ChatInlinePill";
import { MarkdownContent } from "./MarkdownContent";
import type { ChatPillMetrics } from "./chatPillMetrics";
import { useEditorStore } from "../../../app/store/editorStore";
import { useVaultStore } from "../../../app/store/vaultStore";

function openNoteByAbsolutePath(absPath: string) {
    const notes = useVaultStore.getState().notes;
    const note = notes.find((n) => n.path === absPath);
    if (!note) return;

    const { tabs, openNote } = useEditorStore.getState();
    const existing = tabs.find((t) => t.noteId === note.id);
    if (existing) {
        openNote(note.id, note.title, existing.content);
        return;
    }
    void invoke<{ content: string }>("read_note", { noteId: note.id })
        .then((detail) => {
            useEditorStore.getState().openNote(note.id, note.title, detail.content);
        })
        .catch((e) => console.error("Error opening note:", e));
}

/** Parse @mentions and @fetch in serialized user messages into styled pills. */
function renderUserContent(
    text: string,
    pillMetrics: ChatPillMetrics,
): Array<string | ReactElement> {
    const parts: Array<string | ReactElement> = [];
    // Match @fetch, @📁FolderName, @NoteName, or /plan
    const mentionRegex = /(@(fetch|📁[^\s]+|[^\s@]+)|\/plan\b)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let key = 0;

    while ((match = mentionRegex.exec(text)) !== null) {
        if (match.index > lastIndex) {
            parts.push(text.slice(lastIndex, match.index));
        }

        const token = match[1];
        if (token === "/plan") {
            parts.push(
                <ChatInlinePill
                    key={key++}
                    label="/plan"
                    metrics={pillMetrics}
                    variant="neutral"
                />,
            );
            lastIndex = match.index + match[0].length;
            continue;
        }

        const label = match[2];
        const isFetch = label === "fetch";
        const isFolder = label.startsWith("📁");
        const displayLabel = isFolder ? label.replace(/^📁\s*/u, "") : label;

        parts.push(
            <ChatInlinePill
                key={key++}
                label={isFetch ? "@fetch" : displayLabel}
                metrics={pillMetrics}
                variant={
                    isFetch ? "success" : isFolder ? "folder" : "accent"
                }
            />,
        );

        lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
        parts.push(text.slice(lastIndex));
    }

    return parts;
}

interface AIChatMessageItemProps {
    message: AIChatMessage;
    pillMetrics: ChatPillMetrics;
    onPermissionResponse?: (requestId: string, optionId?: string) => void;
}

function stripMarkdownBold(text: string) {
    return text.replace(/\*\*(.+?)\*\*/g, "$1");
}

function ThinkingMessage({ message }: { message: AIChatMessage }) {
    const [expanded, setExpanded] = useState(false);
    const content = stripMarkdownBold(message.content).trim();

    return (
        <div className="min-w-0 max-w-full">
            <button
                type="button"
                onClick={() => {
                    if (content || message.inProgress) setExpanded((v) => !v);
                }}
                className="flex items-center gap-2 py-0.5"
                style={{
                    color: "var(--text-secondary)",
                    backgroundColor: "transparent",
                    border: "none",
                    cursor:
                        !content && !message.inProgress ? "default" : "pointer",
                    opacity: 0.7,
                    fontSize: "0.85em",
                }}
            >
                <svg
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{
                        transform: expanded ? "rotate(90deg)" : "none",
                        transition: "transform 0.12s ease",
                    }}
                >
                    <path d="M4.5 2.5L8 6L4.5 9.5" />
                </svg>
                <span>Thinking{message.inProgress ? "..." : ""}</span>
            </button>
            {expanded && (content || message.inProgress) && (
                <div
                    className="mt-1 whitespace-pre-wrap pl-5 italic"
                    style={{
                        color: "var(--text-secondary)",
                        opacity: 0.7,
                        overflowWrap: "anywhere",
                        wordBreak: "break-word",
                    }}
                >
                    {content}
                </div>
            )}
        </div>
    );
}

function ToolIcon({ kind }: { kind?: string }) {
    const k = String(kind ?? "");
    if (k === "read" || k === "search") {
        return (
            <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                <circle cx="5.5" cy="5.5" r="3" />
                <path d="M7.5 7.5L10 10" />
            </svg>
        );
    }
    if (k === "edit") {
        return (
            <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                <path d="M7 2l3 3-7 7H0V9z" />
            </svg>
        );
    }
    if (k === "execute") {
        return (
            <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                <path d="M2 3l4 3-4 3z" />
                <path d="M7 9h3" />
            </svg>
        );
    }
    // default gear
    return (
        <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <circle cx="6" cy="6" r="1.5" />
            <path d="M6 1v1.5M6 9.5V11M1 6h1.5M9.5 6H11M2.5 2.5l1 1M8.5 8.5l1 1M9.5 2.5l-1 1M3.5 8.5l-1 1" />
        </svg>
    );
}

/** Compact card for file-mutating tools (edit, delete, move). */
function FileToolMessage({ message }: { message: AIChatMessage }) {
    const [expanded, setExpanded] = useState(false);
    const toolKind = String(message.meta?.tool ?? "edit");
    const target = message.meta?.target ? String(message.meta.target) : null;
    const shortTarget = target?.split("/").pop() ?? null;
    const status = String(message.meta?.status ?? "");
    const isCompleted = status === "completed";
    const isInProgress = status === "in_progress";

    const isRead = toolKind === "read" || toolKind === "search";
    const accent = toolKind === "delete"
        ? "#ef4444"
        : "#6b7280"; // neutral gray for read/edit/move

    const actionLabel = isRead
        ? "Read"
        : toolKind === "delete"
          ? "Deleted"
          : toolKind === "move"
            ? "Moved"
            : "Updated";

    // Detail: show summary/content if it provides extra info beyond filename
    const detail =
        message.content &&
        message.content !== shortTarget &&
        message.content !== (message.title ?? toolKind)
            ? message.content
            : null;

    return (
        <div
            className="min-w-0 max-w-full overflow-hidden rounded-lg"
            style={{
                border: `1px solid color-mix(in srgb, ${accent} 25%, var(--border))`,
                backgroundColor: `color-mix(in srgb, ${accent} 4%, var(--bg-secondary))`,
                opacity: isCompleted ? 0.65 : 1,
                transition: "opacity 0.2s ease",
            }}
        >
            {/* Header */}
            <div
                className="flex items-center gap-2 px-3 py-1.5"
                style={{
                    cursor: detail ? "pointer" : "default",
                    borderBottom: detail && expanded
                        ? `1px solid color-mix(in srgb, ${accent} 15%, var(--border))`
                        : "none",
                }}
                onClick={detail ? () => setExpanded((v) => !v) : undefined}
            >
                {/* Icon */}
                {isRead ? (
                    <svg
                        width="13"
                        height="13"
                        viewBox="0 0 14 14"
                        fill="none"
                        stroke={accent}
                        strokeWidth="1.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="shrink-0"
                    >
                        <circle cx="6" cy="6" r="3.5" />
                        <path d="M8.5 8.5L12 12" />
                    </svg>
                ) : (
                    <svg
                        width="13"
                        height="13"
                        viewBox="0 0 14 14"
                        fill="none"
                        stroke={accent}
                        strokeWidth="1.3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="shrink-0"
                    >
                        <path d="M8 1.5H3.5a1 1 0 00-1 1v9a1 1 0 001 1h7a1 1 0 001-1V5L8 1.5z" />
                        <path d="M8 1.5V5h3.5" />
                        {toolKind === "delete" ? (
                            <path d="M5.5 7.5l3 3M8.5 7.5l-3 3" />
                        ) : (
                            <path d="M5 8.5l1.5 1.5L9 7" />
                        )}
                    </svg>
                )}

                {/* Filename + action */}
                <span
                    className="min-w-0 flex-1 truncate"
                    title={target ?? undefined}
                    style={{
                        color: target ? "var(--accent)" : "var(--text-primary)",
                        fontSize: "0.83em",
                        fontWeight: 500,
                        cursor: target ? "pointer" : "default",
                        textDecoration: "none",
                    }}
                    onClick={target ? (e) => { e.stopPropagation(); openNoteByAbsolutePath(target); } : undefined}
                    onMouseEnter={target ? (e) => { (e.currentTarget as HTMLElement).style.textDecoration = "underline"; } : undefined}
                    onMouseLeave={target ? (e) => { (e.currentTarget as HTMLElement).style.textDecoration = "none"; } : undefined}
                >
                    {shortTarget ?? message.title ?? actionLabel}
                </span>

                {/* Status */}
                {isInProgress ? (
                    <span
                        className="inline-block h-1.5 w-1.5 animate-pulse rounded-full shrink-0"
                        style={{ backgroundColor: accent }}
                    />
                ) : isCompleted ? (
                    <span
                        style={{
                            color: accent,
                            fontSize: "0.75em",
                            opacity: 0.8,
                        }}
                    >
                        {actionLabel}
                    </span>
                ) : null}

                {/* Expand chevron */}
                {detail && (
                    <svg
                        width="10"
                        height="10"
                        viewBox="0 0 10 10"
                        fill="none"
                        stroke={accent}
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="shrink-0"
                        style={{
                            transform: expanded ? "rotate(180deg)" : "rotate(0)",
                            transition: "transform 0.15s ease",
                            opacity: 0.6,
                        }}
                    >
                        <path d="M2.5 4L5 6.5L7.5 4" />
                    </svg>
                )}
            </div>

            {/* Expandable detail */}
            {expanded && detail && (
                <div className="px-3 py-1.5">
                    <pre
                        className="max-h-32 overflow-auto rounded px-2 py-1.5"
                        style={{
                            backgroundColor: `color-mix(in srgb, ${accent} 4%, var(--bg-tertiary))`,
                            border: `1px solid color-mix(in srgb, ${accent} 10%, var(--border))`,
                            color: "var(--text-secondary)",
                            fontSize: "0.78em",
                            lineHeight: 1.4,
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                            margin: 0,
                        }}
                    >
                        {detail}
                    </pre>
                </div>
            )}
        </div>
    );
}

function ToolMessage({ message }: { message: AIChatMessage }) {
    const [expanded, setExpanded] = useState(false);
    const toolKind = String(message.meta?.tool ?? "");
    const target = message.meta?.target ? String(message.meta.target) : null;
    const shortTarget = target?.split("/").pop() ?? null;
    const title = message.title ?? toolKind;
    const label = shortTarget ?? title;
    const status = String(message.meta?.status ?? "");
    const isCompleted = status === "completed";

    // File-mutating tools get card treatment
    if (toolKind === "edit" || toolKind === "delete" || toolKind === "move") {
        return <FileToolMessage message={message} />;
    }

    // Read/search tools with a file target get card treatment
    if ((toolKind === "read" || toolKind === "search") && target) {
        return <FileToolMessage message={message} />;
    }

    // Show detail content if it differs from the label (e.g. long shell commands)
    const detail =
        message.content && message.content !== label && message.content !== title
            ? message.content
            : null;

    return (
        <div
            className="min-w-0 max-w-full py-0.5"
            style={{
                color: "var(--text-secondary)",
                opacity: isCompleted ? 0.45 : 0.7,
                fontSize: "0.85em",
            }}
        >
            <div
                className="flex min-w-0 items-center gap-2"
                style={{ cursor: detail ? "pointer" : "default" }}
                onClick={detail ? () => setExpanded((v) => !v) : undefined}
            >
                <ToolIcon kind={toolKind} />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                {!isCompleted && status === "in_progress" ? (
                    <span
                        className="inline-block h-1.5 w-1.5 animate-pulse rounded-full"
                        style={{ backgroundColor: "var(--accent)" }}
                    />
                ) : null}
                {detail && (
                    <svg
                        width="10"
                        height="10"
                        viewBox="0 0 10 10"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        style={{
                            flexShrink: 0,
                            transform: expanded ? "rotate(180deg)" : "rotate(0)",
                            transition: "transform 0.15s ease",
                        }}
                    >
                        <path d="M2.5 4L5 6.5L7.5 4" />
                    </svg>
                )}
            </div>
            {expanded && detail && (
                <pre
                    className="mt-1 max-h-40 overflow-auto rounded px-2 py-1.5"
                    style={{
                        backgroundColor: "var(--bg-tertiary)",
                        border: "1px solid var(--border)",
                        fontSize: "0.82em",
                        lineHeight: 1.4,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                    }}
                >
                    {detail}
                </pre>
            )}
        </div>
    );
}

function ErrorMessage({ message }: { message: AIChatMessage }) {
    return (
        <div
            className="flex min-w-0 max-w-full items-start gap-2 rounded-lg px-2.5 py-2"
            style={{
                color: "#fca5a5",
                backgroundColor: "color-mix(in srgb, #dc2626 8%, transparent)",
                fontSize: "0.85em",
            }}
        >
            <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="mt-0.5 shrink-0"
                style={{ color: "#f87171" }}
            >
                <circle cx="7" cy="7" r="5.5" />
                <path d="M7 4.5v3M7 9.5h.005" />
            </svg>
            <span
                className="min-w-0 whitespace-pre-wrap"
                style={{
                    overflowWrap: "anywhere",
                    wordBreak: "break-word",
                }}
            >
                {message.content}
            </span>
        </div>
    );
}

function PermissionMessage({
    message,
    pillMetrics,
    onPermissionResponse,
}: {
    message: AIChatMessage;
    pillMetrics: ChatPillMetrics;
    onPermissionResponse?: (requestId: string, optionId?: string) => void;
}) {
    const target = message.meta?.target ? String(message.meta.target) : null;
    const shortTarget = target?.split("/").pop() ?? null;
    const status = String(message.meta?.status ?? "pending");
    const resolvedOptionId =
        message.meta?.resolved_option !== undefined &&
        message.meta?.resolved_option !== null
            ? String(message.meta.resolved_option)
            : null;
    const resolvedOptionLabel =
        message.permissionOptions?.find(
            (option) => option.option_id === resolvedOptionId,
        )?.name ?? null;
    const isPending = status === "pending";
    const isResponding = status === "responding";
    const isResolved = status === "resolved";

    // Extract first line as title, rest as details
    const lines = message.content.split("\n");
    const title = lines[0];
    const details = lines.slice(1).join("\n").trim();
    const MAX_PREVIEW = 120;
    const MAX_HEADER_PREVIEW = 72;
    const isLong = details.length > MAX_PREVIEW;
    const hasLongTitle = title.length > MAX_HEADER_PREVIEW;
    const canExpand = hasLongTitle || isLong;
    const [expanded, setExpanded] = useState(() => !canExpand);
    const preview = isLong
        ? `${details.slice(0, MAX_PREVIEW)}...`
        : details;

    return (
        <div
            className="min-w-0 max-w-full overflow-hidden rounded-lg"
            style={{
                border: "1px solid color-mix(in srgb, #d97706 25%, var(--border))",
                backgroundColor: "color-mix(in srgb, #d97706 4%, var(--bg-secondary))",
            }}
        >
            {/* Header */}
            <div
                className="flex items-center gap-2 px-3 py-2"
                style={{
                    borderBottom: details || shortTarget
                        ? "1px solid color-mix(in srgb, #d97706 15%, var(--border))"
                        : "none",
                }}
            >
                <svg
                    width="14"
                    height="14"
                    viewBox="0 0 14 14"
                    fill="none"
                    stroke="#d97706"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="shrink-0"
                >
                    <path d="M7 1.5L12 4.5V9.5L7 12.5L2 9.5V4.5L7 1.5Z" />
                    <path d="M7 5.5V7.5" />
                    <circle cx="7" cy="9.5" r="0.5" fill="#d97706" />
                </svg>
                <span
                    className="min-w-0 flex-1 font-medium"
                    style={{
                        color: "var(--text-primary)",
                        fontSize: "0.85em",
                        whiteSpace: expanded ? "normal" : "nowrap",
                        overflow: "hidden",
                        textOverflow: expanded ? "clip" : "ellipsis",
                    }}
                >
                    {title}
                </span>
                {canExpand && (
                    <button
                        type="button"
                        onClick={() => setExpanded((value) => !value)}
                        style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 18,
                            height: 18,
                            flexShrink: 0,
                            border: "none",
                            borderRadius: 4,
                            background: "transparent",
                            color: "#d97706",
                            cursor: "pointer",
                            opacity: 0.7,
                        }}
                        aria-label={
                            expanded
                                ? "Collapse permission message"
                                : "Expand permission message"
                        }
                        title={
                            expanded
                                ? "Collapse message"
                                : "Expand message"
                        }
                    >
                        <svg
                            width="10"
                            height="10"
                            viewBox="0 0 10 10"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            style={{
                                transform: expanded
                                    ? "rotate(180deg)"
                                    : "rotate(0deg)",
                                transition: "transform 0.15s ease",
                            }}
                        >
                            <path d="M2.5 4L5 6.5L7.5 4" />
                        </svg>
                    </button>
                )}
            </div>

            {/* Body */}
            {(details || shortTarget) && (
                <div className="px-3 py-2">
                    {shortTarget && (
                        <div
                            className="mb-1.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5"
                            style={{
                                backgroundColor: "color-mix(in srgb, #d97706 10%, transparent)",
                                color: "#d97706",
                                fontSize: "0.79em",
                            }}
                        >
                            <svg
                                width="10"
                                height="10"
                                viewBox="0 0 10 10"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <path d="M1.5 8.5V2a.5.5 0 01.5-.5h2.5L6 3h2.5a.5.5 0 01.5.5V8.5a.5.5 0 01-.5.5h-6a.5.5 0 01-.5-.5z" />
                            </svg>
                            {shortTarget}
                        </div>
                    )}
                    {details && (
                        <div
                            className="leading-relaxed"
                            style={{
                                color: "var(--text-secondary)",
                                overflowWrap: "anywhere",
                                wordBreak: "break-word",
                                fontSize: "0.79em",
                            }}
                        >
                            <MarkdownContent
                                content={expanded ? details : preview}
                                pillMetrics={pillMetrics}
                            />
                            {isLong && (
                                <button
                                    type="button"
                                    onClick={() => setExpanded((v) => !v)}
                                    className="mt-1"
                                    style={{
                                        color: "#d97706",
                                        background: "none",
                                        border: "none",
                                        cursor: "pointer",
                                        padding: 0,
                                    }}
                                >
                                    {expanded ? "Show less" : "Show more"}
                                </button>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* Actions */}
            {message.permissionRequestId &&
            message.permissionOptions?.length ? (
                <div
                    className="flex flex-wrap gap-2 px-3 py-2"
                    style={{
                        borderTop: "1px solid color-mix(in srgb, #d97706 15%, var(--border))",
                    }}
                >
                    {message.permissionOptions.map((option) => {
                        const isReject = option.kind.startsWith("reject");
                        return (
                            <button
                                key={option.option_id}
                                type="button"
                                onClick={() =>
                                    onPermissionResponse?.(
                                        message.permissionRequestId!,
                                        option.option_id,
                                    )
                                }
                                disabled={!isPending}
                                className="rounded-md px-3 py-1 font-medium transition-opacity"
                                style={{
                                    fontSize: "0.79em",
                                    color: !isPending
                                        ? "var(--text-secondary)"
                                        : isReject
                                          ? "var(--text-secondary)"
                                          : "#fff",
                                    backgroundColor: !isPending
                                        ? "color-mix(in srgb, var(--text-secondary) 10%, transparent)"
                                        : isReject
                                          ? "color-mix(in srgb, var(--text-secondary) 12%, transparent)"
                                          : "var(--accent)",
                                    border:
                                        "1px solid color-mix(in srgb, var(--text-secondary) 20%, transparent)",
                                    opacity: !isPending ? 0.5 : 1,
                                    cursor: isPending ? "pointer" : "default",
                                }}
                            >
                                {option.name}
                            </button>
                        );
                    })}
                </div>
            ) : null}

            {/* Status footer */}
            {(isResponding || isResolved) && (
                <div
                    className="px-3 py-1.5"
                    style={{
                        color: "var(--text-secondary)",
                        borderTop: "1px solid color-mix(in srgb, #d97706 15%, var(--border))",
                        opacity: 0.7,
                        fontSize: "0.79em",
                    }}
                >
                    {isResponding
                        ? "Sending decision..."
                        : `Decision sent${resolvedOptionLabel ? `: ${resolvedOptionLabel}` : "."}`}
                </div>
            )}
        </div>
    );
}

function ProposedEditMessage({ message }: { message: AIChatMessage }) {
    const label = message.title ?? message.kind.replaceAll("_", " ");

    return (
        <div
            className="min-w-0 max-w-full rounded-lg px-2.5 py-2"
            style={{
                border: "1px solid color-mix(in srgb, #0891b2 30%, var(--border))",
                backgroundColor: "color-mix(in srgb, #0891b2 6%, transparent)",
            }}
        >
            <div
                className="uppercase tracking-[0.14em] text-xs font-medium"
                style={{ color: "#0891b2" }}
            >
                {label}
            </div>
            <div
                className="mt-1 whitespace-pre-wrap"
                style={{
                    color: "var(--text-primary)",
                    overflowWrap: "anywhere",
                    wordBreak: "break-word",
                }}
            >
                {message.content}
            </div>
        </div>
    );
}

export function AIChatMessageItem({
    message,
    pillMetrics,
    onPermissionResponse,
}: AIChatMessageItemProps) {
    // User text — full width, subtle box (Zed style)
    if (message.kind === "text" && message.role === "user") {
        return (
            <div
                className="min-w-0 max-w-full whitespace-pre-wrap rounded-lg px-3 py-2"
                style={{
                    color: "var(--text-primary)",
                    backgroundColor: "var(--bg-tertiary)",
                    border: "1px solid var(--border)",
                    overflowWrap: "anywhere",
                    wordBreak: "break-word",
                }}
            >
                {renderUserContent(message.content, pillMetrics)}
            </div>
        );
    }

    // Thinking — collapsible single line
    if (message.kind === "thinking") {
        return <ThinkingMessage message={message} />;
    }

    // Tool activity — subtle one-liner
    if (message.kind === "tool") {
        return <ToolMessage message={message} />;
    }

    // Error — inline with icon
    if (message.kind === "error") {
        return <ErrorMessage message={message} />;
    }

    // Permission — minimal card
    if (message.kind === "permission") {
        return (
            <PermissionMessage
                message={message}
                pillMetrics={pillMetrics}
                onPermissionResponse={onPermissionResponse}
            />
        );
    }

    // Proposed edit / new note
    if (
        message.kind === "proposed_edit" ||
        message.kind === "proposed_new_note"
    ) {
        return <ProposedEditMessage message={message} />;
    }

    // Assistant text — flat, no card
    return (
        <div
            className="min-w-0 max-w-full"
            style={{
                color: "var(--text-primary)",
                overflowWrap: "anywhere",
                wordBreak: "break-word",
            }}
        >
            <MarkdownContent
                content={message.content}
                pillMetrics={pillMetrics}
            />
        </div>
    );
}
