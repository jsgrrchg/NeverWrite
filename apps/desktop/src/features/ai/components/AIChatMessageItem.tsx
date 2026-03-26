import {
    memo,
    useCallback,
    useMemo,
    useRef,
    useState,
    type MouseEvent,
    type ReactElement,
} from "react";
import {
    ContextMenu,
    type ContextMenuState,
} from "../../../components/context-menu/ContextMenu";
import type { AIChatMessage, AIFileDiff } from "../types";
import { ChatInlinePill } from "./ChatInlinePill";
import { MarkdownContent } from "./MarkdownContent";
import type { ChatPillMetrics } from "./chatPillMetrics";
import type { ChatPillVariant } from "./chatPillPalette";
import { useChatStore } from "../store/chatStore";
import {
    DIFF_ZOOM_MAX,
    DIFF_ZOOM_MIN,
    DIFF_ZOOM_STEP,
    computeDiffStats,
    computeFileDiffStats,
    formatDiffStat,
    getFileNameFromPath,
    stepDiffZoom,
} from "../diff/reviewDiff";
import { EditedFileDiffPreview } from "./editedFilesPresentation";
import {
    openChatNoteByAbsolutePath,
    openChatNoteByReference,
} from "../chatNoteNavigation";
import { useSettingsStore } from "../../../app/store/settingsStore";
import { useVaultStore } from "../../../app/store/vaultStore";

interface UserMentionContextMenuPayload {
    label: string;
}

interface ToolTargetContextMenuPayload {
    target: string;
}

/** Parse @mentions and @fetch in serialized user messages into styled pills. */
function renderUserContent(
    text: string,
    pillMetrics: ChatPillMetrics,
    onNoteContextMenu: (event: MouseEvent<HTMLElement>, label: string) => void,
): Array<string | ReactElement> {
    const parts: Array<string | ReactElement> = [];
    // New bracketed format: [@note], [@📁 folder], [Screenshot ...], [📎 file]
    // Legacy format (backward compat): @fetch, /plan, @📁word, @word
    const mentionRegex =
        /(\[@📁 [^\]]+\]|\[@[^\]]+\]|\[Screenshot [^\]]+\]|\[📎 [^\]]+\]|@fetch\b|\/plan\b|@📁[^\s]+|@[^\s@]+)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let key = 0;

    while ((match = mentionRegex.exec(text)) !== null) {
        if (match.index > lastIndex) {
            parts.push(text.slice(lastIndex, match.index));
        }

        const token = match[0];

        if (token.startsWith("[Screenshot ") || token.startsWith("[📎 ")) {
            const pillLabel = token.slice(1, -1); // strip [ ]
            parts.push(
                <ChatInlinePill
                    key={key++}
                    label={pillLabel}
                    metrics={pillMetrics}
                    variant="file"
                />,
            );
            lastIndex = match.index + token.length;
            continue;
        }

        if (token === "/plan") {
            parts.push(
                <ChatInlinePill
                    key={key++}
                    label="/plan"
                    metrics={pillMetrics}
                    variant="neutral"
                />,
            );
            lastIndex = match.index + token.length;
            continue;
        }

        if (token === "@fetch") {
            parts.push(
                <ChatInlinePill
                    key={key++}
                    label="@fetch"
                    metrics={pillMetrics}
                    variant="success"
                />,
            );
            lastIndex = match.index + token.length;
            continue;
        }

        if (token.startsWith("[@📁 ")) {
            const folderLabel = token.slice(4, -1); // strip [@📁 and ]
            parts.push(
                <ChatInlinePill
                    key={key++}
                    label={folderLabel}
                    metrics={pillMetrics}
                    variant="folder"
                />,
            );
            lastIndex = match.index + token.length;
            continue;
        }

        // [@NoteName] (new) or @NoteName (legacy) — note/folder mention
        let noteLabel: string;
        let variant: ChatPillVariant = "accent";
        if (token.startsWith("[@")) {
            noteLabel = token.slice(2, -1); // strip [@ and ]
        } else if (token.startsWith("@📁")) {
            noteLabel = token.slice(2).replace(/^\s*/u, ""); // strip @📁
            variant = "folder";
        } else {
            noteLabel = token.slice(1); // strip @
        }
        const isNote = variant === "accent";
        parts.push(
            <ChatInlinePill
                key={key++}
                label={noteLabel}
                metrics={pillMetrics}
                interactive={isNote}
                variant={variant}
                onClick={
                    isNote
                        ? () => {
                              void openChatNoteByReference(noteLabel);
                          }
                        : undefined
                }
                onContextMenu={
                    isNote
                        ? (event) => onNoteContextMenu(event, noteLabel)
                        : undefined
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

function UserTextMessage({
    message,
    pillMetrics,
}: {
    message: AIChatMessage;
    pillMetrics: ChatPillMetrics;
}) {
    const [contextMenu, setContextMenu] =
        useState<ContextMenuState<UserMentionContextMenuPayload> | null>(null);

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
            {renderUserContent(message.content, pillMetrics, (event, label) => {
                event.preventDefault();
                event.stopPropagation();
                setContextMenu({
                    x: event.clientX,
                    y: event.clientY,
                    payload: { label },
                });
            })}
            {contextMenu ? (
                <ContextMenu
                    menu={contextMenu}
                    onClose={() => setContextMenu(null)}
                    entries={[
                        {
                            label: "Open in New Tab",
                            action: () => {
                                void openChatNoteByReference(
                                    contextMenu.payload.label,
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

interface AIChatMessageItemProps {
    message: AIChatMessage;
    pillMetrics: ChatPillMetrics;
    visibleWorkCycleId?: string | null;
    onPermissionResponse?: (requestId: string, optionId?: string) => void;
    onUserInputResponse?: (
        requestId: string,
        answers: Record<string, string[]>,
    ) => void;
}

function stripMarkdownBold(text: string) {
    return text.replace(/\*\*(.+?)\*\*/g, "$1");
}

function shouldShowDiffReview(
    message: AIChatMessage,
    visibleWorkCycleId?: string | null,
) {
    if (!message.diffs?.length) {
        return false;
    }

    if (!visibleWorkCycleId || !message.workCycleId) {
        return true;
    }

    return message.workCycleId === visibleWorkCycleId;
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
    const [contextMenu, setContextMenu] =
        useState<ContextMenuState<ToolTargetContextMenuPayload> | null>(null);
    const notes = useVaultStore((state) => state.notes);
    const toolKind = String(message.meta?.tool ?? "edit");
    const target = message.meta?.target ? String(message.meta.target) : null;
    const canOpenTarget = target
        ? notes.some((note) => note.path === target)
        : false;
    const shortTarget = target?.split("/").pop() ?? null;
    const status = String(message.meta?.status ?? "");
    const isCompleted = status === "completed";
    const isInProgress = status === "in_progress";

    const isRead = toolKind === "read" || toolKind === "search";
    const accent = toolKind === "delete" ? "#ef4444" : "#6b7280"; // neutral gray for read/edit/move

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
                    borderBottom:
                        detail && expanded
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
                        cursor: canOpenTarget ? "pointer" : "default",
                        textDecoration: "none",
                    }}
                    onClick={
                        canOpenTarget && target
                            ? (e) => {
                                  e.stopPropagation();
                                  void openChatNoteByAbsolutePath(target);
                              }
                            : undefined
                    }
                    onContextMenu={
                        canOpenTarget && target
                            ? (event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  setContextMenu({
                                      x: event.clientX,
                                      y: event.clientY,
                                      payload: { target },
                                  });
                              }
                            : undefined
                    }
                    onMouseEnter={
                        canOpenTarget
                            ? (e) => {
                                  (
                                      e.currentTarget as HTMLElement
                                  ).style.textDecoration = "underline";
                              }
                            : undefined
                    }
                    onMouseLeave={
                        canOpenTarget
                            ? (e) => {
                                  (
                                      e.currentTarget as HTMLElement
                                  ).style.textDecoration = "none";
                              }
                            : undefined
                    }
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
                            transform: expanded
                                ? "rotate(180deg)"
                                : "rotate(0)",
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
                        className="max-h-32 overflow-y-auto rounded px-2 py-1.5"
                        style={{
                            backgroundColor: `color-mix(in srgb, ${accent} 4%, var(--bg-tertiary))`,
                            border: `1px solid color-mix(in srgb, ${accent} 10%, var(--border))`,
                            color: "var(--text-secondary)",
                            fontSize: "0.78em",
                            lineHeight: 1.4,
                            overflowWrap: "anywhere",
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                            margin: 0,
                        }}
                    >
                        {detail}
                    </pre>
                </div>
            )}
            {contextMenu ? (
                <ContextMenu
                    menu={contextMenu}
                    onClose={() => setContextMenu(null)}
                    entries={[
                        {
                            label: "Open in New Tab",
                            action: () => {
                                void openChatNoteByReference(
                                    contextMenu.payload.target,
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

function ToolMessage({
    message,
    showDiffReview = true,
}: {
    message: AIChatMessage;
    showDiffReview?: boolean;
}) {
    const [expanded, setExpanded] = useState(false);
    const toolKind = String(message.meta?.tool ?? "");
    const target = message.meta?.target ? String(message.meta.target) : null;
    const shortTarget = target?.split("/").pop() ?? null;
    const title = message.title ?? toolKind;
    const label = shortTarget ?? title;
    const status = String(message.meta?.status ?? "");
    const isCompleted = status === "completed";

    if (showDiffReview && message.diffs && message.diffs.length > 0) {
        return <ChangeReviewPanel message={message} />;
    }

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
        message.content &&
        message.content !== label &&
        message.content !== title
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
                            transform: expanded
                                ? "rotate(180deg)"
                                : "rotate(0)",
                            transition: "transform 0.15s ease",
                        }}
                    >
                        <path d="M2.5 4L5 6.5L7.5 4" />
                    </svg>
                )}
            </div>
            {expanded && detail && (
                <pre
                    className="mt-1 max-h-40 overflow-y-auto rounded px-2 py-1.5"
                    style={{
                        backgroundColor: "var(--bg-tertiary)",
                        border: "1px solid var(--border)",
                        fontSize: "0.82em",
                        lineHeight: 1.4,
                        overflowWrap: "anywhere",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        margin: 0,
                    }}
                >
                    {detail}
                </pre>
            )}
        </div>
    );
}

export function PlanMessage({
    message,
    pillMetrics,
}: {
    message: AIChatMessage;
    pillMetrics: ChatPillMetrics;
}) {
    const [expanded, setExpanded] = useState(true);
    const entries = message.planEntries ?? [];
    const detail = message.planDetail?.trim() || null;
    const completedCount = entries.filter(
        (entry) => entry.status === "completed",
    ).length;
    const inProgress = entries.some((entry) => entry.status === "in_progress");
    const allDone = entries.length > 0 && completedCount === entries.length;
    const statusLabel = allDone
        ? "All Done"
        : inProgress
          ? "In Progress"
          : entries.length > 0
            ? "Planned"
            : "Draft";
    const canExpand = entries.length > 0 || !!detail;

    return (
        <div
            className="min-w-0 max-w-full overflow-hidden rounded-xl"
            style={{
                border: "1px solid color-mix(in srgb, var(--border) 88%, transparent)",
                backgroundColor:
                    "color-mix(in srgb, var(--bg-tertiary) 84%, transparent)",
            }}
        >
            <button
                type="button"
                onClick={() => {
                    if (canExpand) setExpanded((value) => !value);
                }}
                className="flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left"
                aria-expanded={expanded}
                style={{
                    backgroundColor: "transparent",
                    border: "none",
                    cursor: canExpand ? "pointer" : "default",
                }}
            >
                <span
                    className="inline-flex shrink-0 items-center justify-center rounded-md px-1.5 py-0.5 text-xs"
                    style={{
                        color: "var(--text-secondary)",
                        backgroundColor:
                            "color-mix(in srgb, var(--bg-secondary) 74%, transparent)",
                        border: "1px solid color-mix(in srgb, var(--border) 82%, transparent)",
                        fontWeight: 500,
                    }}
                >
                    {canExpand ? (expanded ? "▾" : "▸") : "•"}
                </span>
                <span
                    className="min-w-0 flex-1 font-medium"
                    style={{
                        color: "var(--text-secondary)",
                        fontSize: "0.875rem",
                    }}
                >
                    {message.title ?? "Plan"}
                </span>
                <span
                    style={{
                        color: "var(--text-secondary)",
                        fontSize: "0.76em",
                    }}
                >
                    {statusLabel}
                </span>
            </button>

            {expanded && detail ? (
                <div
                    className="mx-2.5 mb-1.5 rounded-md px-2 py-1.5"
                    style={{
                        backgroundColor:
                            "color-mix(in srgb, var(--bg-secondary) 74%, transparent)",
                        border: "1px solid color-mix(in srgb, var(--border) 72%, transparent)",
                    }}
                >
                    <div
                        style={{
                            color: "var(--text-secondary)",
                            fontSize: "0.78em",
                            lineHeight: 1.45,
                        }}
                    >
                        <MarkdownContent
                            content={detail}
                            pillMetrics={pillMetrics}
                        />
                    </div>
                </div>
            ) : null}

            {expanded && entries.length > 0 ? (
                <div
                    className="flex flex-col"
                    style={{
                        borderTop:
                            "1px solid color-mix(in srgb, var(--border) 72%, transparent)",
                    }}
                >
                    {entries.map((entry, index) => {
                        const isCompleted = entry.status === "completed";
                        const isActive = entry.status === "in_progress";
                        return (
                            <div
                                key={`${entry.content}:${index}`}
                                className="flex min-w-0 items-start gap-2.5 px-2.5 py-1.5"
                                style={{
                                    borderTop:
                                        index === 0
                                            ? "none"
                                            : "1px solid color-mix(in srgb, var(--border) 72%, transparent)",
                                    color: isCompleted
                                        ? "var(--text-secondary)"
                                        : "var(--text-primary)",
                                    opacity: isCompleted ? 0.74 : 1,
                                }}
                            >
                                <span
                                    className="mt-[3px] inline-flex h-1.5 w-1.5 shrink-0 rounded-full"
                                    style={{
                                        backgroundColor: isCompleted
                                            ? "#84cc16"
                                            : isActive
                                              ? "var(--accent)"
                                              : "var(--text-secondary)",
                                        opacity: isCompleted ? 0.9 : 0.8,
                                    }}
                                />
                                <div className="min-w-0 flex-1">
                                    <div
                                        style={{
                                            fontSize: "0.8em",
                                            overflowWrap: "anywhere",
                                            wordBreak: "break-word",
                                            textDecoration: isCompleted
                                                ? "line-through"
                                                : "none",
                                        }}
                                    >
                                        {entry.content}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            ) : expanded && !detail ? (
                <div
                    className="px-2.5 pb-1.5"
                    style={{
                        color: "var(--text-secondary)",
                        fontSize: "0.8em",
                    }}
                >
                    No plan steps yet.
                </div>
            ) : null}

            {expanded && entries.length > 0 ? (
                <div
                    className="px-2.5 pb-1.5 pt-0.5"
                    style={{
                        color: "var(--text-secondary)",
                        fontSize: "0.74em",
                        opacity: 0.68,
                    }}
                >
                    {completedCount}/{entries.length}
                </div>
            ) : null}
        </div>
    );
}

function formatElapsedMs(ms: number) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
    if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
    return `${seconds}s`;
}

function StatusMessage({ message }: { message: AIChatMessage }) {
    const statusKind = String(message.meta?.status_event ?? "status");
    const status = String(message.meta?.status ?? "");
    const emphasis = String(message.meta?.emphasis ?? "neutral");
    const title = message.title ?? message.content;
    const detail =
        message.content && message.content !== title ? message.content : null;

    if (statusKind === "turn_started") {
        const elapsedMs =
            typeof message.meta?.elapsed_ms === "number"
                ? message.meta.elapsed_ms
                : null;
        return (
            <div className="min-w-0 max-w-full py-2">
                <div className="flex min-w-0 max-w-full items-center gap-3">
                    <div
                        className="h-px flex-1"
                        style={{
                            backgroundColor: "var(--border)",
                            opacity: 0.5,
                        }}
                    />
                    <span
                        className="shrink-0 uppercase tracking-[0.14em]"
                        style={{
                            color: "var(--text-secondary)",
                            fontSize: "0.68em",
                            opacity: 0.7,
                        }}
                    >
                        {title}
                    </span>
                    {elapsedMs != null ? (
                        <span
                            style={{
                                color: "var(--text-secondary)",
                                fontSize: "0.66em",
                                opacity: 0.55,
                            }}
                        >
                            {formatElapsedMs(elapsedMs)}
                        </span>
                    ) : null}
                    <div
                        className="h-px flex-1"
                        style={{
                            backgroundColor: "var(--border)",
                            opacity: 0.5,
                        }}
                    />
                </div>
            </div>
        );
    }

    if (emphasis === "error" || statusKind === "stream_error") {
        return (
            <div
                className="min-w-0 max-w-full rounded-lg px-2.5 py-2"
                style={{
                    border: "1px solid color-mix(in srgb, #dc2626 30%, var(--border))",
                    backgroundColor:
                        "color-mix(in srgb, #dc2626 8%, transparent)",
                }}
            >
                <div
                    className="flex items-center gap-2"
                    style={{ color: "#f87171" }}
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
                        className="shrink-0"
                    >
                        <circle cx="7" cy="7" r="5.5" />
                        <path d="M7 4.5v3M7 9.5h.005" />
                    </svg>
                    <span
                        className="font-medium"
                        style={{ fontSize: "0.84em" }}
                    >
                        {title}
                    </span>
                </div>
                {detail && (
                    <div
                        className="mt-1 whitespace-pre-wrap"
                        style={{
                            color: "var(--text-primary)",
                            fontSize: "0.8em",
                            overflowWrap: "anywhere",
                            wordBreak: "break-word",
                        }}
                    >
                        {detail}
                    </div>
                )}
            </div>
        );
    }

    if (statusKind === "model_reroute" || statusKind === "review_mode") {
        const accent = statusKind === "review_mode" ? "#0f766e" : "#0891b2";
        return (
            <div
                className="min-w-0 max-w-full rounded-lg px-2.5 py-2"
                style={{
                    border: `1px solid color-mix(in srgb, ${accent} 28%, var(--border))`,
                    backgroundColor: `color-mix(in srgb, ${accent} 6%, transparent)`,
                }}
            >
                <div
                    className="uppercase tracking-[0.14em] text-xs font-medium"
                    style={{ color: accent }}
                >
                    {title}
                </div>
                {detail && (
                    <div
                        className="mt-1 whitespace-pre-wrap"
                        style={{
                            color: "var(--text-primary)",
                            overflowWrap: "anywhere",
                            wordBreak: "break-word",
                            fontSize: "0.83em",
                        }}
                    >
                        {detail}
                    </div>
                )}
            </div>
        );
    }

    const isInProgress = status === "in_progress";
    const isCompleted = status === "completed";

    return (
        <div
            className="min-w-0 max-w-full py-0.5"
            style={{
                color: "var(--text-secondary)",
                opacity: isCompleted ? 0.5 : 0.72,
                fontSize: "0.83em",
            }}
        >
            <div className="flex min-w-0 items-center gap-2">
                {isInProgress ? (
                    <span
                        className="inline-block h-1.5 w-1.5 animate-pulse rounded-full shrink-0"
                        style={{ backgroundColor: "var(--accent)" }}
                    />
                ) : (
                    <svg
                        width="12"
                        height="12"
                        viewBox="0 0 12 12"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="shrink-0"
                        style={{ opacity: isCompleted ? 0.8 : 0.55 }}
                    >
                        <circle cx="6" cy="6" r="4" />
                        {isCompleted ? (
                            <path d="M4.2 6.1L5.4 7.3L7.9 4.8" />
                        ) : null}
                    </svg>
                )}
                <span className="min-w-0 flex-1 truncate">{title}</span>
            </div>
            {detail && (
                <div
                    className="mt-0.5 pl-5"
                    style={{
                        overflowWrap: "anywhere",
                        wordBreak: "break-word",
                        opacity: 0.8,
                    }}
                >
                    {detail}
                </div>
            )}
        </div>
    );
}

const DIFF_DEFAULT_HEIGHT = 200;
const DIFF_MIN_HEIGHT = 80;

function ResizableDiffContainer({
    accent,
    children,
}: {
    accent: string;
    children: ReactElement;
}) {
    const [height, setHeight] = useState(DIFF_DEFAULT_HEIGHT);
    const dragging = useRef(false);
    const startY = useRef(0);
    const startH = useRef(0);

    const onPointerDown = useCallback(
        (e: React.PointerEvent) => {
            e.preventDefault();
            dragging.current = true;
            startY.current = e.clientY;
            startH.current = height;
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
        },
        [height],
    );

    const onPointerMove = useCallback((e: React.PointerEvent) => {
        if (!dragging.current) return;
        const delta = e.clientY - startY.current;
        setHeight(Math.max(DIFF_MIN_HEIGHT, startH.current + delta));
    }, []);

    const onPointerUp = useCallback(() => {
        dragging.current = false;
    }, []);

    return (
        <div
            style={{
                borderBottom: `1px solid color-mix(in srgb, ${accent} 8%, var(--border))`,
            }}
        >
            <div
                style={{
                    maxHeight: height,
                    overflowY: "auto",
                }}
            >
                {children}
            </div>
            {/* Resize handle */}
            <div
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                style={{
                    height: 6,
                    cursor: "ns-resize",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: "transparent",
                    transition: "background-color 0.15s ease",
                }}
                onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.backgroundColor =
                        "color-mix(in srgb, var(--text-secondary) 10%, transparent)";
                }}
                onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.backgroundColor =
                        "transparent";
                }}
            >
                <div
                    style={{
                        width: 32,
                        height: 2,
                        borderRadius: 1,
                        backgroundColor: "var(--text-secondary)",
                        opacity: 0.3,
                    }}
                />
            </div>
        </div>
    );
}

function ChangeReviewFileRow({
    diff,
    accent,
    expanded,
    onToggle,
    diffZoom,
    lineWrapping,
}: {
    diff: AIFileDiff;
    accent: string;
    expanded: boolean;
    onToggle: () => void;
    diffZoom: number;
    lineWrapping: boolean;
}) {
    const filename = getFileNameFromPath(diff.path);
    const previousFilename = diff.previous_path
        ? getFileNameFromPath(diff.previous_path)
        : diff.previous_path;
    const stats = useMemo(() => computeFileDiffStats(diff), [diff]);

    return (
        <div key={diff.path} className="min-w-0">
            <button
                type="button"
                onClick={onToggle}
                className="flex w-full items-center gap-1.5 px-3 py-1"
                style={{
                    background: "transparent",
                    border: "none",
                    borderBottom: `1px solid color-mix(in srgb, ${accent} 8%, var(--border))`,
                    cursor: "pointer",
                    fontSize: "0.78em",
                    color: "var(--text-secondary)",
                }}
            >
                <svg
                    width="8"
                    height="8"
                    viewBox="0 0 8 8"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    style={{
                        transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
                        transition: "transform 0.15s ease",
                        flexShrink: 0,
                    }}
                >
                    <path d="M2 1.5L5.5 4L2 6.5" />
                </svg>
                <span
                    style={{
                        color:
                            diff.kind === "add"
                                ? "#16a34a"
                                : diff.kind === "delete"
                                  ? "#dc2626"
                                  : diff.kind === "move"
                                    ? "#c0841a"
                                    : "var(--text-primary)",
                        fontWeight: 500,
                    }}
                >
                    {filename}
                </span>
                <span
                    style={{
                        opacity: 0.5,
                        fontSize: "0.9em",
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                    }}
                >
                    <span>
                        {diff.kind === "add"
                            ? "new file"
                            : diff.kind === "delete"
                              ? "deleted"
                              : diff.kind === "move"
                                ? previousFilename
                                    ? `moved from ${previousFilename}`
                                    : "moved"
                                : "modified"}
                    </span>
                    {diff.reversible === false ? (
                        <span
                            className="rounded-full px-1.5 py-0.5"
                            style={{
                                fontSize: "0.82em",
                                textTransform: "uppercase",
                                letterSpacing: "0.04em",
                                color: "#b45309",
                                backgroundColor:
                                    "color-mix(in srgb, #f59e0b 14%, transparent)",
                            }}
                        >
                            partial
                        </span>
                    ) : null}
                </span>
                <span
                    style={{
                        marginLeft: "auto",
                        display: "flex",
                        gap: 6,
                        fontSize: "0.9em",
                    }}
                >
                    {stats.additions > 0 && (
                        <span style={{ color: "#16a34a" }}>
                            +
                            {formatDiffStat(stats.additions, stats.approximate)}
                        </span>
                    )}
                    {stats.deletions > 0 && (
                        <span style={{ color: "#dc2626" }}>
                            -
                            {formatDiffStat(stats.deletions, stats.approximate)}
                        </span>
                    )}
                </span>
            </button>

            {expanded && (
                <ResizableDiffContainer accent={accent}>
                    <EditedFileDiffPreview
                        diff={diff}
                        expanded={expanded}
                        diffZoom={diffZoom}
                        lineWrapping={lineWrapping}
                        testId={`diff-content:${diff.path}`}
                        showWhenEmpty={false}
                        compactLineNumbers
                    />
                </ResizableDiffContainer>
            )}
        </div>
    );
}

function ChangeReviewFileList({
    diffs,
    accent,
    diffZoom,
    lineWrapping,
}: {
    diffs: AIFileDiff[];
    accent: string;
    diffZoom: number;
    lineWrapping: boolean;
}) {
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});

    return (
        <div className="flex flex-col">
            {diffs.map((diff) => {
                return (
                    <ChangeReviewFileRow
                        key={diff.path}
                        diff={diff}
                        accent={accent}
                        diffZoom={diffZoom}
                        lineWrapping={lineWrapping}
                        expanded={expanded[diff.path] ?? false}
                        onToggle={() =>
                            setExpanded((prev) => ({
                                ...prev,
                                [diff.path]: !prev[diff.path],
                            }))
                        }
                    />
                );
            })}
        </div>
    );
}

function getDiffPanelToolLabel(toolKind: string) {
    switch (toolKind) {
        case "edit":
            return "Edit";
        case "delete":
            return "Delete";
        case "move":
            return "Move";
        default:
            return "Change";
    }
}

function ChangeReviewPanel({
    message,
    onPermissionResponse,
}: {
    message: AIChatMessage;
    onPermissionResponse?: (requestId: string, optionId?: string) => void;
}) {
    const diffs = message.diffs ?? [];
    const editDiffZoom = useChatStore((state) => state.editDiffZoom);
    const setEditDiffZoom = useChatStore((state) => state.setEditDiffZoom);
    const lineWrapping = useSettingsStore((state) => state.lineWrapping);
    const notes = useVaultStore((state) => state.notes);
    const toolKind = String(message.meta?.tool ?? "");
    const isToolMessage = message.kind === "tool";
    const accent = isToolMessage
        ? toolKind === "delete"
            ? "#ef4444"
            : "#6b7280"
        : "#d97706";
    const status = String(message.meta?.status ?? "pending");
    const resolvedOptionId =
        message.meta?.resolved_option !== undefined &&
        message.meta?.resolved_option !== null
            ? String(message.meta.resolved_option)
            : null;
    const resolvedOptionLabel =
        message.permissionOptions?.find((o) => o.option_id === resolvedOptionId)
            ?.name ?? null;
    const isPending = status === "pending";
    const isResponding = status === "responding";
    const isResolved = status === "resolved";

    const stats = computeDiffStats(diffs);
    const fileCount = diffs.length;
    const fileWord = fileCount === 1 ? "file" : "files";
    const target = message.meta?.target ? String(message.meta.target) : null;
    const openFilePath =
        isToolMessage && toolKind !== "delete"
            ? (target ?? (diffs.length === 1 ? diffs[0]?.path : null))
            : null;
    const canOpenFile = openFilePath
        ? notes.some((note) => note.path === openFilePath)
        : false;
    const actionLabel = isToolMessage
        ? getDiffPanelToolLabel(toolKind)
        : "Edit";
    const canDecreaseZoom = editDiffZoom > DIFF_ZOOM_MIN;
    const canIncreaseZoom = editDiffZoom < DIFF_ZOOM_MAX;
    const isSingleFile = diffs.length === 1;
    const singleDiff = isSingleFile ? diffs[0] : null;
    const singleFilename = singleDiff
        ? getFileNameFromPath(singleDiff.path)
        : null;
    const singleFileStats = singleDiff
        ? computeFileDiffStats(singleDiff)
        : null;
    const singleFileStatusLabel = singleDiff
        ? singleDiff.kind === "add"
            ? "new file"
            : singleDiff.kind === "delete"
              ? "deleted"
              : singleDiff.kind === "move"
                ? singleDiff.previous_path
                    ? `moved from ${getFileNameFromPath(singleDiff.previous_path)}`
                    : "moved"
                : "modified"
        : null;
    const displayStats =
        isSingleFile && singleFileStats ? singleFileStats : stats;
    const [singleDiffExpanded, setSingleDiffExpanded] = useState(false);
    return (
        <div
            className="min-w-0 max-w-full overflow-hidden rounded-lg"
            style={{
                border: `1px solid color-mix(in srgb, ${accent} 25%, var(--border))`,
                backgroundColor: `color-mix(in srgb, ${accent} 4%, var(--bg-secondary))`,
            }}
        >
            {/* Summary bar */}
            <div
                className="flex items-center gap-2 px-3 py-2"
                role={isSingleFile ? "button" : undefined}
                tabIndex={isSingleFile ? 0 : undefined}
                onClick={
                    isSingleFile
                        ? () => setSingleDiffExpanded((p) => !p)
                        : undefined
                }
                onKeyDown={
                    isSingleFile
                        ? (e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  setSingleDiffExpanded((p) => !p);
                              }
                          }
                        : undefined
                }
                style={{
                    borderBottom: `1px solid color-mix(in srgb, ${accent} 15%, var(--border))`,
                    cursor: isSingleFile ? "pointer" : undefined,
                }}
            >
                {/* Chevron for single-file expand/collapse */}
                {isSingleFile && (
                    <svg
                        width="8"
                        height="8"
                        viewBox="0 0 8 8"
                        fill="none"
                        stroke="var(--text-secondary)"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        className="shrink-0"
                        style={{
                            display: "block",
                            transform: singleDiffExpanded
                                ? "rotate(90deg)"
                                : "rotate(0deg)",
                            transition: "transform 0.15s ease",
                        }}
                    >
                        <path d="M2 1.5L5.5 4L2 6.5" />
                    </svg>
                )}
                {isToolMessage ? (
                    <span
                        className="flex shrink-0 items-center"
                        style={{ color: accent }}
                    >
                        <ToolIcon kind={toolKind} />
                    </span>
                ) : (
                    <svg
                        width="14"
                        height="14"
                        viewBox="0 0 14 14"
                        fill="none"
                        stroke={accent}
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="shrink-0"
                    >
                        <path d="M7 1L2 12h10L7 1z" />
                        <path d="M7 5.5v2.5" />
                        <circle cx="7" cy="10" r="0.5" fill={accent} />
                    </svg>
                )}
                {isSingleFile ? (
                    <div
                        className="flex min-w-0 items-center gap-1.5"
                        style={{
                            overflow: "hidden",
                            maskImage:
                                "linear-gradient(to right, black calc(100% - 12px), transparent)",
                            WebkitMaskImage:
                                "linear-gradient(to right, black calc(100% - 12px), transparent)",
                        }}
                    >
                        <span
                            className="whitespace-nowrap"
                            style={{
                                overflowX: "auto",
                                scrollbarWidth: "none",
                                color: "var(--text-primary)",
                                fontWeight: 600,
                                fontSize: "0.83em",
                            }}
                        >
                            {`${actionLabel}${actionLabel.endsWith("e") ? "d" : "ed"} ${singleFilename}`}
                        </span>
                        {singleFileStatusLabel &&
                            singleFileStatusLabel !== "modified" && (
                                <span
                                    className="shrink-0 whitespace-nowrap"
                                    style={{
                                        color: "var(--text-secondary)",
                                        fontSize: "0.74em",
                                        opacity: 0.6,
                                    }}
                                >
                                    {singleFileStatusLabel}
                                </span>
                            )}
                        {singleDiff?.reversible === false && (
                            <span
                                className="shrink-0 rounded-full px-1.5 py-0.5 whitespace-nowrap"
                                style={{
                                    fontSize: "0.68em",
                                    textTransform: "uppercase",
                                    letterSpacing: "0.04em",
                                    color: "#b45309",
                                    backgroundColor:
                                        "color-mix(in srgb, #f59e0b 14%, transparent)",
                                }}
                            >
                                partial
                            </span>
                        )}
                    </div>
                ) : (
                    <>
                        <span
                            style={{
                                color: "var(--text-primary)",
                                fontWeight: 600,
                                fontSize: "0.83em",
                            }}
                        >
                            {actionLabel} {fileCount} {fileWord}
                        </span>
                        <span
                            style={{
                                color: "var(--text-secondary)",
                                fontSize: "0.78em",
                                opacity: 0.7,
                            }}
                        >
                            ·
                        </span>
                    </>
                )}
                <span
                    style={{
                        display: "flex",
                        gap: 6,
                        fontSize: "0.78em",
                        flexShrink: 0,
                    }}
                >
                    {displayStats.additions > 0 && (
                        <span style={{ color: "#16a34a", fontWeight: 500 }}>
                            +
                            {formatDiffStat(
                                displayStats.additions,
                                displayStats.approximate,
                            )}
                        </span>
                    )}
                    {displayStats.deletions > 0 && (
                        <span style={{ color: "#dc2626", fontWeight: 500 }}>
                            -
                            {formatDiffStat(
                                displayStats.deletions,
                                displayStats.approximate,
                            )}
                        </span>
                    )}
                </span>
                <div
                    className="ml-auto flex items-center gap-1.5"
                    onClick={
                        isSingleFile ? (e) => e.stopPropagation() : undefined
                    }
                >
                    <div
                        className="flex items-center rounded-md"
                        style={{
                            border: `1px solid color-mix(in srgb, ${accent} 18%, var(--border))`,
                            backgroundColor:
                                "color-mix(in srgb, var(--bg-primary) 48%, transparent)",
                        }}
                    >
                        <button
                            type="button"
                            aria-label="Decrease diff zoom"
                            disabled={!canDecreaseZoom}
                            onClick={() =>
                                setEditDiffZoom(
                                    stepDiffZoom(editDiffZoom, -DIFF_ZOOM_STEP),
                                )
                            }
                            className="rounded-l-md px-2 py-1"
                            style={{
                                fontSize: "0.76em",
                                color: canDecreaseZoom
                                    ? accent
                                    : "var(--text-secondary)",
                                opacity: canDecreaseZoom ? 1 : 0.45,
                                backgroundColor: "transparent",
                                border: "none",
                                cursor: canDecreaseZoom
                                    ? "pointer"
                                    : "not-allowed",
                            }}
                        >
                            -
                        </button>
                        <button
                            type="button"
                            aria-label="Increase diff zoom"
                            disabled={!canIncreaseZoom}
                            onClick={() =>
                                setEditDiffZoom(
                                    stepDiffZoom(editDiffZoom, DIFF_ZOOM_STEP),
                                )
                            }
                            className="rounded-r-md px-2 py-1"
                            style={{
                                fontSize: "0.76em",
                                color: canIncreaseZoom
                                    ? accent
                                    : "var(--text-secondary)",
                                opacity: canIncreaseZoom ? 1 : 0.45,
                                backgroundColor: "transparent",
                                border: "none",
                                cursor: canIncreaseZoom
                                    ? "pointer"
                                    : "not-allowed",
                            }}
                        >
                            +
                        </button>
                    </div>
                    {canOpenFile && openFilePath ? (
                        <button
                            type="button"
                            onClick={() =>
                                void openChatNoteByAbsolutePath(openFilePath)
                            }
                            className="rounded-md px-2 py-1"
                            style={{
                                fontSize: "0.76em",
                                color: accent,
                                backgroundColor:
                                    "color-mix(in srgb, var(--bg-primary) 55%, transparent)",
                                border: `1px solid color-mix(in srgb, ${accent} 22%, var(--border))`,
                                cursor: "pointer",
                            }}
                        >
                            Open
                        </button>
                    ) : null}
                </div>
            </div>

            {/* Single-file inline diff preview */}
            {isSingleFile && singleDiff && singleDiffExpanded && (
                <ResizableDiffContainer accent={accent}>
                    <EditedFileDiffPreview
                        diff={singleDiff}
                        expanded={singleDiffExpanded}
                        diffZoom={editDiffZoom}
                        lineWrapping={lineWrapping}
                        testId={`diff-content:${singleDiff.path}`}
                        showWhenEmpty={false}
                        compactLineNumbers
                    />
                </ResizableDiffContainer>
            )}

            {/* File list with expandable diffs (multi-file only) */}
            {!isSingleFile && (
                <ChangeReviewFileList
                    diffs={diffs}
                    accent={accent}
                    diffZoom={editDiffZoom}
                    lineWrapping={lineWrapping}
                />
            )}

            {/* Actions */}
            {message.permissionRequestId &&
            message.permissionOptions?.length ? (
                <div
                    className="flex items-center gap-2 px-3 py-2"
                    style={{
                        borderTop: `1px solid color-mix(in srgb, ${accent} 15%, var(--border))`,
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
                                    marginLeft: isReject ? 0 : "auto",
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
                                    border: "1px solid color-mix(in srgb, var(--text-secondary) 20%, transparent)",
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
                        borderTop: `1px solid color-mix(in srgb, ${accent} 15%, var(--border))`,
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
    showDiffReview = true,
    onPermissionResponse,
}: {
    message: AIChatMessage;
    pillMetrics: ChatPillMetrics;
    showDiffReview?: boolean;
    onPermissionResponse?: (requestId: string, optionId?: string) => void;
}) {
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

    // Delegate to Change Review Panel when diffs are present
    if (showDiffReview && message.diffs && message.diffs.length > 0) {
        return (
            <ChangeReviewPanel
                message={message}
                onPermissionResponse={onPermissionResponse}
            />
        );
    }

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
    const preview = isLong ? `${details.slice(0, MAX_PREVIEW)}...` : details;

    return (
        <div
            className="min-w-0 max-w-full overflow-hidden rounded-lg"
            style={{
                border: "1px solid color-mix(in srgb, #d97706 25%, var(--border))",
                backgroundColor:
                    "color-mix(in srgb, #d97706 4%, var(--bg-secondary))",
            }}
        >
            {/* Header */}
            <div
                className="flex items-center gap-2 px-3 py-2"
                style={{
                    borderBottom:
                        details || shortTarget
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
                        title={expanded ? "Collapse message" : "Expand message"}
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
                                backgroundColor:
                                    "color-mix(in srgb, #d97706 10%, transparent)",
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
                        borderTop:
                            "1px solid color-mix(in srgb, #d97706 15%, var(--border))",
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
                                    border: "1px solid color-mix(in srgb, var(--text-secondary) 20%, transparent)",
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
                        borderTop:
                            "1px solid color-mix(in srgb, #d97706 15%, var(--border))",
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

function UserInputRequestMessage({
    message,
    onUserInputResponse,
}: {
    message: AIChatMessage;
    onUserInputResponse?: (
        requestId: string,
        answers: Record<string, string[]>,
    ) => void;
}) {
    const status = String(message.meta?.status ?? "pending");
    const questions = message.userInputQuestions ?? [];
    const isPending = status === "pending";
    const isResponding = status === "responding";
    const isResolved = status === "resolved";
    const [selectedOptions, setSelectedOptions] = useState<
        Record<string, string>
    >({});
    const [textAnswers, setTextAnswers] = useState<Record<string, string>>({});
    const [otherAnswers, setOtherAnswers] = useState<Record<string, string>>(
        {},
    );

    const submitAnswers = (cancelled = false) => {
        if (!message.userInputRequestId) return;
        if (cancelled) {
            onUserInputResponse?.(message.userInputRequestId, {});
            return;
        }

        const answers = questions.reduce<Record<string, string[]>>(
            (accumulator, question) => {
                const values: string[] = [];
                const selected = selectedOptions[question.id]?.trim();
                const text = textAnswers[question.id]?.trim();
                const other = otherAnswers[question.id]?.trim();

                if (selected) values.push(selected);
                if (text) values.push(text);
                if (other) values.push(`user_note: ${other}`);

                if (values.length > 0) {
                    accumulator[question.id] = values;
                }
                return accumulator;
            },
            {},
        );

        onUserInputResponse?.(message.userInputRequestId, answers);
    };

    return (
        <div
            className="min-w-0 max-w-full overflow-hidden rounded-lg"
            style={{
                border: "1px solid color-mix(in srgb, #c2410c 24%, var(--border))",
                backgroundColor:
                    "color-mix(in srgb, #c2410c 4%, var(--bg-secondary))",
            }}
        >
            <div
                className="flex items-center gap-2 px-3 py-2"
                style={{
                    borderBottom:
                        questions.length > 0
                            ? "1px solid color-mix(in srgb, #c2410c 15%, var(--border))"
                            : "none",
                }}
            >
                <svg
                    width="14"
                    height="14"
                    viewBox="0 0 14 14"
                    fill="none"
                    stroke="#c2410c"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="shrink-0"
                >
                    <path d="M2 3.5A1.5 1.5 0 013.5 2h7A1.5 1.5 0 0112 3.5v5A1.5 1.5 0 0110.5 10h-4L4 12V10H3.5A1.5 1.5 0 012 8.5v-5z" />
                    <path d="M4.5 5.25h5M4.5 7.25h3.5" />
                </svg>
                <span
                    className="min-w-0 flex-1 font-medium"
                    style={{
                        color: "var(--text-primary)",
                        fontSize: "0.85em",
                    }}
                >
                    {message.title ?? "Input requested"}
                </span>
            </div>

            <div className="flex flex-col gap-3 px-3 py-3">
                {questions.map((question) => {
                    const options = question.options ?? [];
                    const selected = selectedOptions[question.id] ?? "";
                    const textValue = textAnswers[question.id] ?? "";
                    const otherValue = otherAnswers[question.id] ?? "";

                    return (
                        <div key={question.id} className="min-w-0">
                            <div
                                className="mb-1"
                                style={{
                                    color: "var(--text-primary)",
                                    fontSize: "0.8em",
                                    fontWeight: 600,
                                }}
                            >
                                {question.header}
                            </div>
                            <div
                                className="mb-2"
                                style={{
                                    color: "var(--text-secondary)",
                                    fontSize: "0.79em",
                                    overflowWrap: "anywhere",
                                    wordBreak: "break-word",
                                }}
                            >
                                {question.question}
                            </div>

                            {options.length > 0 ? (
                                <div className="flex flex-wrap gap-2">
                                    {options.map((option) => {
                                        const isSelected =
                                            selected === option.label;
                                        return (
                                            <button
                                                key={option.label}
                                                type="button"
                                                disabled={!isPending}
                                                onClick={() =>
                                                    setSelectedOptions(
                                                        (current) => ({
                                                            ...current,
                                                            [question.id]:
                                                                option.label,
                                                        }),
                                                    )
                                                }
                                                className="rounded-md px-2.5 py-1 text-left transition-colors"
                                                style={{
                                                    fontSize: "0.78em",
                                                    color: isSelected
                                                        ? "#fff"
                                                        : "var(--text-primary)",
                                                    backgroundColor: isSelected
                                                        ? "#c2410c"
                                                        : "color-mix(in srgb, #c2410c 7%, var(--bg-tertiary))",
                                                    border: "1px solid color-mix(in srgb, #c2410c 18%, var(--border))",
                                                    opacity: isPending
                                                        ? 1
                                                        : 0.55,
                                                    cursor: isPending
                                                        ? "pointer"
                                                        : "default",
                                                }}
                                                title={option.description}
                                            >
                                                {option.label}
                                            </button>
                                        );
                                    })}
                                </div>
                            ) : null}

                            {options.length === 0 && (
                                <input
                                    type={
                                        question.is_secret ? "password" : "text"
                                    }
                                    value={textValue}
                                    disabled={!isPending}
                                    onChange={(event) =>
                                        setTextAnswers((current) => ({
                                            ...current,
                                            [question.id]: event.target.value,
                                        }))
                                    }
                                    className="w-full rounded-md px-2.5 py-2"
                                    style={{
                                        backgroundColor: "var(--bg-tertiary)",
                                        border: "1px solid var(--border)",
                                        color: "var(--text-primary)",
                                        fontSize: "0.8em",
                                    }}
                                />
                            )}

                            {question.is_other && (
                                <textarea
                                    value={otherValue}
                                    disabled={!isPending}
                                    onChange={(event) =>
                                        setOtherAnswers((current) => ({
                                            ...current,
                                            [question.id]: event.target.value,
                                        }))
                                    }
                                    placeholder="Additional note"
                                    rows={2}
                                    className="mt-2 w-full resize-y rounded-md px-2.5 py-2"
                                    style={{
                                        backgroundColor: "var(--bg-tertiary)",
                                        border: "1px solid var(--border)",
                                        color: "var(--text-primary)",
                                        fontSize: "0.8em",
                                    }}
                                />
                            )}
                        </div>
                    );
                })}
            </div>

            {message.userInputRequestId ? (
                <div
                    className="flex flex-wrap gap-2 px-3 py-2"
                    style={{
                        borderTop:
                            "1px solid color-mix(in srgb, #c2410c 15%, var(--border))",
                    }}
                >
                    <button
                        type="button"
                        disabled={!isPending}
                        onClick={() => submitAnswers(true)}
                        className="rounded-md px-3 py-1 font-medium"
                        style={{
                            fontSize: "0.79em",
                            color: "var(--text-secondary)",
                            backgroundColor:
                                "color-mix(in srgb, var(--text-secondary) 10%, transparent)",
                            border: "1px solid color-mix(in srgb, var(--text-secondary) 18%, transparent)",
                            opacity: isPending ? 1 : 0.5,
                            cursor: isPending ? "pointer" : "default",
                        }}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        disabled={!isPending}
                        onClick={() => submitAnswers(false)}
                        className="rounded-md px-3 py-1 font-medium"
                        style={{
                            fontSize: "0.79em",
                            color: "#fff",
                            backgroundColor: "#c2410c",
                            border: "1px solid color-mix(in srgb, #c2410c 35%, transparent)",
                            opacity: isPending ? 1 : 0.5,
                            cursor: isPending ? "pointer" : "default",
                        }}
                    >
                        Submit
                    </button>
                </div>
            ) : null}

            {(isResponding || isResolved) && (
                <div
                    className="px-3 py-1.5"
                    style={{
                        color: "var(--text-secondary)",
                        borderTop:
                            "1px solid color-mix(in srgb, #c2410c 15%, var(--border))",
                        opacity: 0.7,
                        fontSize: "0.79em",
                    }}
                >
                    {isResponding ? "Sending input..." : "Input sent."}
                </div>
            )}
        </div>
    );
}

export const AIChatMessageItem = memo(function AIChatMessageItem({
    message,
    pillMetrics,
    visibleWorkCycleId = null,
    onPermissionResponse,
    onUserInputResponse,
}: AIChatMessageItemProps) {
    const showDiffReview = shouldShowDiffReview(message, visibleWorkCycleId);

    // User text — full width, subtle box (Zed style)
    if (message.kind === "text" && message.role === "user") {
        return <UserTextMessage message={message} pillMetrics={pillMetrics} />;
    }

    // Thinking — collapsible single line
    if (message.kind === "thinking") {
        return <ThinkingMessage message={message} />;
    }

    // Tool activity — subtle one-liner
    if (message.kind === "tool") {
        return (
            <ToolMessage message={message} showDiffReview={showDiffReview} />
        );
    }

    if (message.kind === "plan") {
        return <PlanMessage message={message} pillMetrics={pillMetrics} />;
    }

    if (message.kind === "status") {
        return <StatusMessage message={message} />;
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
                showDiffReview={showDiffReview}
                onPermissionResponse={onPermissionResponse}
            />
        );
    }

    if (message.kind === "user_input_request") {
        return (
            <UserInputRequestMessage
                message={message}
                onUserInputResponse={onUserInputResponse}
            />
        );
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
});
