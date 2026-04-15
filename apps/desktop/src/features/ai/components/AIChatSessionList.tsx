import { useState } from "react";
import {
    formatSessionTime,
    getRuntimeName,
    getSessionTitle,
    getSessionUpdatedAt,
    hasCustomTitle,
} from "../sessionPresentation";
import type { AIChatSession, AIRuntimeOption } from "../types";
import { useInlineRename } from "./useInlineRename";

interface AIChatSessionListProps {
    activeSessionId: string | null;
    sessions: AIChatSession[];
    runtimes: AIRuntimeOption[];
    onSelectSession: (sessionId: string) => void;
    onDeleteSession: (sessionId: string) => void;
    onRenameSession: (sessionId: string, newTitle: string | null) => void;
}

export function AIChatSessionList({
    activeSessionId,
    sessions,
    runtimes,
    onSelectSession,
    onDeleteSession,
    onRenameSession,
}: AIChatSessionListProps) {
    const [hoveredId, setHoveredId] = useState<string | null>(null);
    const {
        editingKey,
        editValue,
        inputRef,
        setEditValue,
        startEditing: beginInlineRename,
        cancelEditing,
        commitEditing,
    } = useInlineRename<string>();

    function startEditing(session: AIChatSession) {
        beginInlineRename(session.sessionId, getSessionTitle(session));
    }

    function commitEdit(sessionId: string) {
        if (editingKey !== sessionId) return;
        commitEditing(onRenameSession);
    }

    function cancelEdit() {
        cancelEditing();
    }

    if (!sessions.length) {
        return (
            <div
                className="px-3 py-4 text-center text-xs"
                style={{ color: "var(--text-secondary)" }}
            >
                No chats yet.
            </div>
        );
    }

    return (
        <div
            className="min-h-0 flex-1 overflow-y-auto p-1"
            data-scrollbar-active="true"
        >
            {sessions.map((session) => {
                const isActive = session.sessionId === activeSessionId;
                const isHovered = hoveredId === session.sessionId;
                const isEditing = editingKey === session.sessionId;
                const updatedAt = getSessionUpdatedAt(session);
                const runtimeLabel = getRuntimeName(
                    session.runtimeId,
                    runtimes,
                ).replace(/ ACP$/, "");

                return (
                    <div
                        key={session.sessionId}
                        className="group flex w-full items-center gap-1 rounded"
                        style={{
                            backgroundColor:
                                isActive || isHovered
                                    ? "var(--bg-tertiary)"
                                    : "transparent",
                            transition: "background-color 80ms ease",
                        }}
                        onMouseEnter={() => setHoveredId(session.sessionId)}
                        onMouseLeave={() => setHoveredId(null)}
                    >
                        {isEditing ? (
                            <input
                                ref={inputRef}
                                className="min-w-0 flex-1 rounded px-2.5 py-1.5 text-xs outline-none"
                                style={{
                                    background: "var(--bg-primary)",
                                    color: "var(--text-primary)",
                                    border: "1px solid var(--accent)",
                                }}
                                value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                        commitEdit(session.sessionId);
                                    } else if (e.key === "Escape") {
                                        cancelEdit();
                                    }
                                }}
                                onBlur={() => commitEdit(session.sessionId)}
                            />
                        ) : (
                            <button
                                type="button"
                                onClick={() =>
                                    onSelectSession(session.sessionId)
                                }
                                onDoubleClick={(e) => {
                                    e.preventDefault();
                                    startEditing(session);
                                }}
                                className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left"
                                style={{ background: "none", border: "none" }}
                            >
                                <span
                                    className="min-w-0 flex-1 truncate text-xs"
                                    style={{
                                        color: isActive
                                            ? "var(--accent)"
                                            : "var(--text-primary)",
                                    }}
                                >
                                    {getSessionTitle(session)}
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
                                            style={{
                                                opacity: 0.4,
                                            }}
                                        >
                                            <path d="M7.5 2l2.5 2.5M3 7.5 8.5 2l2 2L5 9.5 2 10l1-2.5z" />
                                        </svg>
                                    )}
                                </span>
                                <span
                                    className="shrink-0 text-[10px]"
                                    style={{
                                        color: "var(--text-secondary)",
                                        opacity: 0.7,
                                    }}
                                >
                                    {runtimeLabel}
                                </span>
                                {updatedAt > 0 && !isHovered && (
                                    <span
                                        className="shrink-0 text-[11px]"
                                        style={{
                                            color: "var(--text-secondary)",
                                            opacity: 0.7,
                                        }}
                                    >
                                        {formatSessionTime(updatedAt)}
                                    </span>
                                )}
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation();
                                onDeleteSession(session.sessionId);
                            }}
                            className="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded"
                            style={{
                                background: "none",
                                border: "none",
                                color: "var(--text-secondary)",
                                opacity: 0.6,
                                visibility: isHovered ? "visible" : "hidden",
                            }}
                            title="Delete chat"
                        >
                            <svg
                                width="16"
                                height="16"
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
                );
            })}
        </div>
    );
}
