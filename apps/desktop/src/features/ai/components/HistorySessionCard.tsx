import { useMemo, useState, type MouseEvent } from "react";
import {
    ContextMenu,
    type ContextMenuEntry,
    type ContextMenuState,
} from "../../../components/context-menu/ContextMenu";
import {
    computeSessionStats,
    formatDuration,
    formatSessionTime,
    getHistorySelectionId,
    getRuntimeName,
    getSessionPreview,
    getSessionTitle,
    getSessionTitleText,
    getSessionUpdatedAt,
    hasCustomTitle,
} from "../sessionPresentation";
import type { AIChatSession, AIRuntimeOption } from "../types";
import { useInlineRename } from "./useInlineRename";

interface HistorySessionCardProps {
    session: AIChatSession;
    runtimes: AIRuntimeOption[];
    isSelected: boolean;
    isActive: boolean;
    onOpen: () => void;
    onSelect: (event: MouseEvent<HTMLDivElement>) => void;
    onDelete: () => void;
    onFork: () => void;
    onExport: () => void;
    onRename: (newTitle: string | null) => void;
}

export function HistorySessionCard({
    session,
    runtimes,
    isSelected,
    isActive,
    onOpen,
    onSelect,
    onDelete,
    onFork,
    onExport,
    onRename,
}: HistorySessionCardProps) {
    const [hovered, setHovered] = useState(false);
    const [contextMenu, setContextMenu] =
        useState<ContextMenuState<void> | null>(null);
    const {
        editingKey,
        editValue,
        inputRef,
        setEditValue,
        startEditing: beginInlineRename,
        cancelEditing,
        commitEditing,
    } = useInlineRename<string>();

    const title = getSessionTitle(session);
    const preview = getSessionPreview(session);
    const runtimeLabel = getRuntimeName(session.runtimeId, runtimes).replace(
        / ACP$/,
        "",
    );
    const stats = computeSessionStats(session);
    const updatedAt = getSessionUpdatedAt(session);
    const duration = formatDuration(stats.durationMs);
    const isEditing = editingKey === session.sessionId;
    const stableSessionId = getHistorySelectionId(session);
    const fullTitle = getSessionTitleText(session);
    const contextMenuEntries = useMemo<ContextMenuEntry[]>(
        () => [
            {
                label: "Open",
                action: onOpen,
            },
            {
                label: "Rename chat",
                action: startEditing,
            },
            {
                label: "Fork chat",
                action: onFork,
            },
            {
                label: "Export to note",
                action: onExport,
            },
            { type: "separator" },
            {
                label: "Copy chat title",
                action: () => void navigator.clipboard.writeText(fullTitle),
            },
            {
                label: "Copy chat ID",
                action: () =>
                    void navigator.clipboard.writeText(stableSessionId),
            },
            { type: "separator" },
            {
                label: "Delete",
                action: onDelete,
                danger: true,
            },
        ],
        [
            fullTitle,
            onDelete,
            onExport,
            onFork,
            onOpen,
            startEditing,
            stableSessionId,
        ],
    );

    function startEditing() {
        beginInlineRename(session.sessionId, getSessionTitle(session));
    }

    function commitEdit() {
        if (editingKey !== session.sessionId) return;
        commitEditing((_sessionId, newTitle) => onRename(newTitle));
    }

    function cancelEdit() {
        cancelEditing();
    }

    return (
        <>
            <div
                className="rounded-md px-3 py-2"
                style={{
                    backgroundColor: isActive
                        ? "var(--bg-tertiary)"
                        : isSelected
                          ? "color-mix(in srgb, var(--accent) 7%, transparent)"
                          : hovered
                            ? "color-mix(in srgb, var(--bg-tertiary) 50%, transparent)"
                            : "transparent",
                    border: isActive
                        ? "1px solid var(--accent)"
                        : isSelected
                          ? "1px solid color-mix(in srgb, var(--accent) 24%, transparent)"
                          : "1px solid transparent",
                    cursor: "pointer",
                    transition:
                        "background-color 80ms ease, border-color 80ms ease",
                }}
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
                onClick={onSelect}
                onContextMenu={(event) => {
                    if (
                        (event.target as HTMLElement).closest(
                            "input, textarea, [contenteditable='true']",
                        )
                    ) {
                        return;
                    }
                    event.preventDefault();
                    onSelect(event);
                    setContextMenu({
                        x: event.clientX,
                        y: event.clientY,
                        payload: undefined,
                    });
                }}
            >
                {/* Title row */}
                <div className="flex items-center gap-1">
                    {isEditing ? (
                        <input
                            ref={inputRef}
                            className="min-w-0 flex-1 rounded px-1.5 py-0.5 text-xs font-medium outline-none"
                            style={{
                                background: "var(--bg-primary)",
                                color: "var(--text-primary)",
                                border: "1px solid var(--accent)",
                            }}
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                    commitEdit();
                                } else if (e.key === "Escape") {
                                    cancelEdit();
                                }
                            }}
                            onBlur={commitEdit}
                            onClick={(e) => e.stopPropagation()}
                        />
                    ) : (
                        <span
                            className="min-w-0 flex-1 truncate text-xs font-medium"
                            style={{ color: "var(--text-primary)" }}
                            onDoubleClick={(e) => {
                                e.stopPropagation();
                                startEditing();
                            }}
                        >
                            {title}
                            {hasCustomTitle(session) && (
                                <svg
                                    width="10"
                                    height="10"
                                    viewBox="0 0 12 12"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.5"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    className="ml-1 inline-block align-[-1px]"
                                    style={{ opacity: 0.4 }}
                                >
                                    <path d="M7.5 2l2.5 2.5M3 7.5 8.5 2l2 2L5 9.5 2 10l1-2.5z" />
                                </svg>
                            )}
                        </span>
                    )}

                    {/* Export button (visible on hover) */}
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            onExport();
                        }}
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded"
                        style={{
                            background: "none",
                            border: "none",
                            color: "var(--text-secondary)",
                            opacity: 0.6,
                            visibility: hovered ? "visible" : "hidden",
                        }}
                        title="Export to note"
                    >
                        <svg
                            width="14"
                            height="14"
                            viewBox="0 0 12 12"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <path d="M6 2v6M3.5 5.5 6 8l2.5-2.5M2.5 10h7" />
                        </svg>
                    </button>

                    {/* Fork button (visible on hover) */}
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            onFork();
                        }}
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded"
                        style={{
                            background: "none",
                            border: "none",
                            color: "var(--text-secondary)",
                            opacity: 0.6,
                            visibility: hovered ? "visible" : "hidden",
                        }}
                        title="Fork chat"
                    >
                        <svg
                            width="14"
                            height="14"
                            viewBox="0 0 12 12"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <path d="M3 2v3a3 3 0 0 0 3 3h0a3 3 0 0 0 3-3V2M3 2h0M9 2h0M6 8v2" />
                        </svg>
                    </button>

                    {/* Delete button (visible on hover) */}
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            onDelete();
                        }}
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded"
                        style={{
                            background: "none",
                            border: "none",
                            color: "var(--text-secondary)",
                            opacity: 0.6,
                            visibility: hovered ? "visible" : "hidden",
                        }}
                        title="Delete chat"
                    >
                        <svg
                            width="14"
                            height="14"
                            viewBox="0 0 12 12"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <path d="M2 3h8M5 3V2h2v1M4.5 3v6.5h3V3" />
                        </svg>
                    </button>
                </div>

                {/* Preview */}
                <div
                    className="mt-0.5 truncate text-[11px] leading-snug"
                    style={{ color: "var(--text-secondary)", opacity: 0.8 }}
                >
                    {preview}
                </div>

                {/* Metadata row */}
                <div
                    className="mt-1 flex items-center gap-1.5 text-[10px]"
                    style={{ color: "var(--text-secondary)", opacity: 0.6 }}
                >
                    <span className="shrink-0">{runtimeLabel}</span>
                    {stats.modelUsed && (
                        <>
                            <span>·</span>
                            <span className="min-w-0 truncate">
                                {stats.modelUsed}
                            </span>
                        </>
                    )}
                    {duration && (
                        <>
                            <span>·</span>
                            <span className="shrink-0">{duration}</span>
                        </>
                    )}
                    <span className="flex-1" />
                    {stats.messageCount > 0 && (
                        <span className="shrink-0">
                            {stats.messageCount}{" "}
                            {stats.messageCount === 1 ? "msg" : "msgs"}
                        </span>
                    )}
                    {updatedAt > 0 && (
                        <span className="shrink-0">
                            {formatSessionTime(updatedAt)}
                        </span>
                    )}
                </div>
            </div>
            {contextMenu && (
                <ContextMenu
                    menu={contextMenu}
                    entries={contextMenuEntries}
                    onClose={() => setContextMenu(null)}
                />
            )}
        </>
    );
}
