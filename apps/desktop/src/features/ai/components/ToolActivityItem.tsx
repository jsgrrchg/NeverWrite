import { useCallback, useState, type KeyboardEvent } from "react";

import {
    ContextMenu,
    type ContextMenuState,
} from "../../../components/context-menu/ContextMenu";
import { FileTypeIcon } from "../../../components/icons/FileTypeIcon";
import { openChatSessionInWorkspace } from "../chatPaneMovement";
import {
    canOpenAiEditedFileByAbsolutePath,
    openAiEditedFileByAbsolutePath,
} from "../chatFileNavigation";
import { useChatStore } from "../store/chatStore";
import type { AIChatMessage, AIChatSession } from "../types";
import { useStoredRowExpanded } from "./chatRowUiPresentation";

export interface ToolTargetContextMenuPayload {
    target: string;
}

const WEB_TOOL_KINDS = new Set(["browse", "fetch", "web_fetch", "web_search"]);

const SEARCH_TOOL_KINDS = new Set([
    "glob",
    "browse",
    "fetch",
    "find",
    "grep",
    "search",
    "web_fetch",
    "web_search",
]);

function getOpenSessionActionLabel(
    message: AIChatMessage,
    resolvedSessionTitle: string | null,
) {
    const explicitLabel = message.toolAction?.label?.trim();
    if (explicitLabel) return explicitLabel;

    if (resolvedSessionTitle) return `Open ${resolvedSessionTitle}`;

    const name = (message.title ?? "")
        .replace(/^(spawned|started|opened)\s+/i, "")
        .trim();
    return name.length > 0 && name.length <= 28 ? `Open ${name}` : "Open";
}

function sessionMatchesOpenSessionRef(session: AIChatSession, ref: string) {
    return (
        session.sessionId === ref ||
        session.historySessionId === ref ||
        session.runtimeSessionId === ref
    );
}

function resolveOpenSessionActionId(
    sessionsById: Record<string, AIChatSession>,
    sessionOrder: string[],
    ref: string | null,
) {
    if (!ref) return null;
    const candidates = Object.values(sessionsById).filter((session) =>
        sessionMatchesOpenSessionRef(session, ref),
    );
    if (candidates.length === 0) return null;

    const sessionOrderRank = new Map(
        sessionOrder.map((sessionId, index) => [sessionId, index]),
    );
    candidates.sort((left, right) => {
        const leftLive = left.runtimeState === "live" && !left.isPersistedSession;
        const rightLive =
            right.runtimeState === "live" && !right.isPersistedSession;
        if (leftLive !== rightLive) return leftLive ? -1 : 1;

        const leftExact = left.sessionId === ref;
        const rightExact = right.sessionId === ref;
        if (leftExact !== rightExact) return leftExact ? -1 : 1;

        const leftRank = sessionOrderRank.get(left.sessionId) ?? Number.MAX_SAFE_INTEGER;
        const rightRank =
            sessionOrderRank.get(right.sessionId) ?? Number.MAX_SAFE_INTEGER;
        return leftRank - rightRank;
    });

    return candidates[0].sessionId;
}

export function OpenSessionActionButton({
    message,
}: {
    message: AIChatMessage;
}) {
    const openSessionAction =
        message.toolAction?.kind === "open_session" ? message.toolAction : null;
    const openSessionId = openSessionAction?.session_id ?? null;
    const resolvedOpenSessionId = useChatStore((state) =>
        resolveOpenSessionActionId(
            state.sessionsById,
            state.sessionOrder,
            openSessionId,
        ),
    );
    const resolvedOpenSessionTitle = useChatStore((state) => {
        if (!resolvedOpenSessionId) return null;
        const session = state.sessionsById[resolvedOpenSessionId];
        return (
            session?.customTitle?.trim() ||
            session?.persistedTitle?.trim() ||
            null
        );
    });
    const canOpenSession = resolvedOpenSessionId !== null;

    if (!openSessionAction) {
        return null;
    }

    const label = getOpenSessionActionLabel(message, resolvedOpenSessionTitle);

    return (
        <button
            type="button"
            disabled={!canOpenSession}
            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium"
            style={{
                background: "transparent",
                border: "1px solid color-mix(in srgb, var(--border) 82%, transparent)",
                color: canOpenSession
                    ? "var(--text-secondary)"
                    : "color-mix(in srgb, var(--text-secondary) 62%, transparent)",
                cursor: canOpenSession ? "pointer" : "default",
            }}
            title={canOpenSession ? label : "Session is not available yet"}
            onClick={(event) => {
                event.stopPropagation();
                if (!resolvedOpenSessionId) return;
                void openChatSessionInWorkspace(resolvedOpenSessionId);
            }}
        >
            {label}
        </button>
    );
}

export function ToolIcon({ kind }: { kind?: string }) {
    const normalizedKind = String(kind ?? "");
    if (normalizedKind === "thinking" || WEB_TOOL_KINDS.has(normalizedKind) || normalizedKind === "read" || normalizedKind === "read_file") {
        return (
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
                {normalizedKind === "thinking" ? (
                    <><path d="M14 7.7a6 6 0 0 1-6 6H2.5l.5-2.5A6 6 0 1 1 14 7.7Z" /><path d="M5.5 6h5M5.5 9h3" /></>
                ) : WEB_TOOL_KINDS.has(normalizedKind) ? (
                    <><circle cx="8" cy="8" r="6.5" /><ellipse cx="8" cy="8" rx="2.5" ry="6.5" /><path d="M1.5 8h13" /></>
                ) : (
                    <><path d="M9.5 1.5h-6v13h9v-10Z" /><path d="M9 1.5v4h3.5M5.5 8h5M5.5 10.5h4" /></>
                )}
            </svg>
        );
    }
    if (SEARCH_TOOL_KINDS.has(normalizedKind)) {
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
    if (normalizedKind === "edit") {
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
    if (
        normalizedKind === "execute" ||
        normalizedKind === "command" ||
        normalizedKind === "bash" ||
        normalizedKind === "shell" ||
        normalizedKind === "terminal"
    ) {
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

    if (normalizedKind === "mcp" || normalizedKind.startsWith("mcp_")) {
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
                <circle cx="3" cy="3" r="1.25" />
                <circle cx="9" cy="3" r="1.25" />
                <circle cx="6" cy="9" r="1.25" />
                <path d="M4.1 3h3.8M3.7 4.1l1.6 3.1M8.3 4.1L6.7 7.2" />
            </svg>
        );
    }

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

function getActionLabel(toolKind: string) {
    if (toolKind === "read" || toolKind === "read_file") return "Read";
    if (toolKind === "web_search" || toolKind === "browse") return "Web";
    if (SEARCH_TOOL_KINDS.has(toolKind)) {
        return toolKind === "fetch" || toolKind === "web_fetch"
            ? "Fetch"
            : "Search";
    }
    if (toolKind === "delete") return "Delete";
    if (toolKind === "move") return "Move";
    if (toolKind === "edit") return "Edit";
    if (["execute", "command", "bash", "shell", "terminal"].includes(toolKind)) return "Run";
    if (["write", "create"].includes(toolKind)) return "Write";
    if (toolKind === "apply_patch") return "Patch";
    return "Completed";
}

function isMcpActivity(message: AIChatMessage, toolKind: string) {
    if (toolKind === "mcp" || toolKind.startsWith("mcp_")) {
        return true;
    }

    const descriptor = `${message.title ?? ""}\n${message.content}`.toLowerCase();
    return descriptor.includes("mcp") || descriptor.includes("codex_apps/");
}

function Chevron({ expanded }: { expanded: boolean }) {
    return (
        <svg
            aria-hidden="true"
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="activity-item-disclosure shrink-0"
            style={{
                transform: expanded ? "rotate(180deg)" : "rotate(0)",
                transition: "transform 0.15s ease",
            }}
        >
            <path d="M2.5 4L5 6.5L7.5 4" />
        </svg>
    );
}

interface ToolActivityItemProps {
    readonly message: AIChatMessage;
    readonly sessionId?: string | null;
}

/**
 * The compact row used inside an expanded activity rail. Diff-backed tools
 * deliberately stay outside this component so ChangeReviewPanel remains the
 * only owner of review state and accept/reject controls.
 */
export function ToolActivityItem({
    message,
    sessionId,
}: ToolActivityItemProps) {
    const [expanded, setExpanded] = useStoredRowExpanded(
        sessionId,
        message.id,
        false,
    );
    const [contextMenu, setContextMenu] =
        useState<ContextMenuState<ToolTargetContextMenuPayload> | null>(null);
    const toolKind = String(message.meta?.tool ?? "").toLowerCase();
    const target = message.meta?.target ? String(message.meta.target) : null;
    const isWeb = WEB_TOOL_KINDS.has(toolKind) || /^https?:\/\//i.test(target ?? "");
    const shortTarget = isWeb
        ? target
        : target?.split(/[\\/]/).filter(Boolean).at(-1) ?? null;
    const status = String(message.meta?.status ?? "").toLowerCase();
    const isFailed = status === "cancelled" || status === "error" || status === "failed";
    const isInProgress =
        message.inProgress === true ||
        status === "in_progress" ||
        status === "pending";
    const actionLabel = getActionLabel(toolKind);
    const label =
        shortTarget ??
        (toolKind === "edit" && isInProgress ? "Writing" : message.title?.trim()) ??
        actionLabel;
    const detail =
        message.content.trim() &&
        message.content !== label &&
        message.content !== message.title
            ? message.content
            : null;
    const canOpenTarget = target && !isWeb
        ? canOpenAiEditedFileByAbsolutePath(target)
        : false;
    const isAttention = isFailed || message.toolAction != null;
    const isMcp = isMcpActivity(message, toolKind);
    const displayKind = isMcp && !toolKind.startsWith("mcp") ? "mcp" : toolKind;
    const activitySource = isMcp
        ? "mcp"
        : isWeb
          ? "web"
          : message.kind === "status"
            ? "status"
          : "tool";
    const stateLabel = isFailed
        ? status === "cancelled"
            ? "Cancelled"
            : "Failed"
        : isInProgress
          ? "Running"
          : null;

    const toggleDetail = useCallback(() => {
        if (detail) setExpanded((value) => !value);
    }, [detail, setExpanded]);
    const onKeyDown = useCallback(
        (event: KeyboardEvent<HTMLDivElement>) => {
            if (!detail || event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                toggleDetail();
            }
        },
        [detail, toggleDetail],
    );

    return (
        <div
            aria-expanded={detail ? expanded : undefined}
            className="activity-item group"
            data-tool-activity-row={isAttention ? "attention" : "routine"}
            data-tool-activity-source={activitySource}
            data-tool-activity-status={status || undefined}
            onClick={toggleDetail}
            onKeyDown={onKeyDown}
            role={detail ? "button" : undefined}
            style={{
                backgroundColor: isFailed
                    ? "color-mix(in srgb, #dc2626 7%, transparent)"
                    : undefined,
                cursor: detail ? "pointer" : "default",
            }}
            tabIndex={detail ? 0 : undefined}
        >
            <div className="activity-item-header">
                <span
                    className="activity-item-icon"
                    data-tool-activity-operation-icon="true"
                    aria-hidden="true"
                    style={{ color: isFailed ? "#f87171" : undefined }}
                >
                    <ToolIcon kind={isWeb ? "web_search" : displayKind} />
                </span>
                {target ? (
                    <>
                        <span className="shrink-0">
                            {isWeb && !WEB_TOOL_KINDS.has(toolKind) ? "Web" : actionLabel}
                        </span>
                        {canOpenTarget ? (
                            <button
                                className="activity-file-badge text-left focus-visible:outline-accent"
                                onClick={(event) => {
                                    event.stopPropagation();
                                    void openAiEditedFileByAbsolutePath(target);
                                }}
                                onContextMenu={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    setContextMenu({
                                        x: event.clientX,
                                        y: event.clientY,
                                        payload: { target },
                                    });
                                }}
                                title={target}
                                type="button"
                            >
                                <span
                                    className="shrink-0"
                                    data-tool-activity-file-icon="true"
                                    aria-hidden="true"
                                >
                                    <FileTypeIcon fileName={target} size={14} />
                                </span>
                                <span className="truncate">{shortTarget}</span>
                            </button>
                        ) : (
                            <span
                                className="min-w-0 truncate"
                                title={target}
                            >
                                {shortTarget}
                            </span>
                        )}
                    </>
                ) : (
                    <>
                        {isWeb ? <span className="shrink-0">{actionLabel}</span> : null}
                        <span className="min-w-0 truncate" title={label}>{label}</span>
                    </>
                )}
                {isInProgress ? (
                    <span
                        aria-label="Running"
                        className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full"
                        style={{ backgroundColor: "var(--accent)" }}
                    />
                ) : null}
                {stateLabel && !isInProgress ? (
                    <span
                        className="shrink-0 text-[10px]"
                        style={{
                            color: isFailed
                                ? "#f87171"
                                : "var(--text-secondary)",
                            opacity: isFailed ? 1 : 0.7,
                        }}
                    >
                        {stateLabel}
                    </span>
                ) : null}
                {detail ? <Chevron expanded={expanded} /> : null}
                <OpenSessionActionButton message={message} />
            </div>
            {expanded && detail ? (
                <pre
                    className="activity-item-detail"
                    data-tool-activity-detail="true"
                >
                    {detail}
                </pre>
            ) : null}
            {contextMenu ? (
                <ContextMenu
                    menu={contextMenu}
                    onClose={() => setContextMenu(null)}
                    entries={[
                        {
                            label: "Open",
                            action: () => {
                                void openAiEditedFileByAbsolutePath(
                                    contextMenu.payload.target,
                                );
                            },
                        },
                        {
                            label: "Open in New Tab",
                            action: () => {
                                void openAiEditedFileByAbsolutePath(
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
