import { useState } from "react";
import {
    formatSessionTime,
    getRuntimeName,
    getSessionTitle,
    getSessionUpdatedAt,
} from "../sessionPresentation";
import type { AIChatSession, AIRuntimeOption } from "../types";

interface AIChatSessionListProps {
    activeSessionId: string | null;
    sessions: AIChatSession[];
    runtimes: AIRuntimeOption[];
    onSelectSession: (sessionId: string) => void;
    onDeleteSession: (sessionId: string) => void;
}

export function AIChatSessionList({
    activeSessionId,
    sessions,
    runtimes,
    onSelectSession,
    onDeleteSession,
}: AIChatSessionListProps) {
    const [hoveredId, setHoveredId] = useState<string | null>(null);

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
            className="max-h-75 overflow-y-auto p-1"
            data-scrollbar-active="true"
        >
            {sessions.map((session) => {
                const isActive = session.sessionId === activeSessionId;
                const isHovered = hoveredId === session.sessionId;
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
                        }}
                        onMouseEnter={() => setHoveredId(session.sessionId)}
                        onMouseLeave={() => setHoveredId(null)}
                    >
                        <button
                            type="button"
                            onClick={() => onSelectSession(session.sessionId)}
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
