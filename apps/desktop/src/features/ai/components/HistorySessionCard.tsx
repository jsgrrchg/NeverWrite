import { useEffect, useRef, useState } from "react";
import {
    computeSessionStats,
    formatDuration,
    formatSessionTime,
    getRuntimeName,
    getSessionPreview,
    getSessionTitle,
    getSessionUpdatedAt,
    hasCustomTitle,
} from "../sessionPresentation";
import type { AIChatSession, AIRuntimeOption } from "../types";

interface HistorySessionCardProps {
    session: AIChatSession;
    runtimes: AIRuntimeOption[];
    isSelected: boolean;
    onSelect: () => void;
    onDelete: () => void;
    onRename: (newTitle: string | null) => void;
}

export function HistorySessionCard({
    session,
    runtimes,
    isSelected,
    onSelect,
    onDelete,
    onRename,
}: HistorySessionCardProps) {
    const [hovered, setHovered] = useState(false);
    const [editing, setEditing] = useState(false);
    const [editValue, setEditValue] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (editing) {
            inputRef.current?.focus();
            inputRef.current?.select();
        }
    }, [editing]);

    const title = getSessionTitle(session);
    const preview = getSessionPreview(session);
    const runtimeLabel = getRuntimeName(session.runtimeId, runtimes).replace(
        / ACP$/,
        "",
    );
    const stats = computeSessionStats(session);
    const updatedAt = getSessionUpdatedAt(session);
    const duration = formatDuration(stats.durationMs);

    function startEditing() {
        setEditing(true);
        setEditValue(getSessionTitle(session));
    }

    function commitEdit() {
        if (!editing) return;
        const trimmed = editValue.trim();
        onRename(trimmed || null);
        setEditing(false);
    }

    function cancelEdit() {
        setEditing(false);
    }

    return (
        <div
            className="rounded-md px-3 py-2"
            style={{
                backgroundColor: isSelected
                    ? "var(--bg-tertiary)"
                    : hovered
                      ? "color-mix(in srgb, var(--bg-tertiary) 50%, transparent)"
                      : "transparent",
                border: isSelected
                    ? "1px solid var(--accent)"
                    : "1px solid transparent",
                cursor: "pointer",
                transition:
                    "background-color 80ms ease, border-color 80ms ease",
            }}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onClick={onSelect}
        >
            {/* Title row */}
            <div className="flex items-center gap-1">
                {editing ? (
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
    );
}
