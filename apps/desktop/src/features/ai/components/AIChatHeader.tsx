import { useEffect, useRef, useState } from "react";
import { AIChatSessionList } from "./AIChatSessionList";
import { getSessionRuntimeName, getSessionTitle } from "../sessionPresentation";
import type {
    AIChatSession,
    AIChatSessionStatus,
    AIRuntimeOption,
} from "../types";

interface AIChatHeaderProps {
    activeSessionId: string | null;
    currentSession: AIChatSession | null;
    sessions: AIChatSession[];
    runtimes: AIRuntimeOption[];
    status: AIChatSessionStatus;
    onNewChat: (runtimeId: string) => void;
    onSelectSession: (sessionId: string) => void;
    onDeleteSession: (sessionId: string) => void;
    onDeleteAllSessions: () => void;
}

const STATUS_LABELS: Record<AIChatSessionStatus, string> = {
    idle: "Idle",
    streaming: "Streaming",
    waiting_permission: "Waiting for approval",
    review_required: "Review required",
    error: "Error",
};

const STATUS_COLORS: Record<AIChatSessionStatus, string> = {
    idle: "var(--text-secondary)",
    streaming: "var(--accent)",
    waiting_permission: "#d97706",
    review_required: "#0891b2",
    error: "#dc2626",
};

export function AIChatHeader({
    activeSessionId,
    currentSession,
    sessions,
    runtimes,
    status,
    onNewChat,
    onSelectSession,
    onDeleteSession,
    onDeleteAllSessions,
}: AIChatHeaderProps) {
    const [newMenuOpen, setNewMenuOpen] = useState(false);
    const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
    const newMenuRef = useRef<HTMLDivElement>(null);
    const sessionMenuRef = useRef<HTMLDivElement>(null);
    const currentRuntime = currentSession
        ? getSessionRuntimeName(currentSession, runtimes)
        : "Agent";
    const currentTitle = currentSession
        ? getSessionTitle(currentSession)
        : "New chat";

    useEffect(() => {
        if (!newMenuOpen && !sessionMenuOpen) return;

        const handleDown = (event: MouseEvent) => {
            const target = event.target as Node | null;
            if (!target) return;
            if (newMenuRef.current?.contains(target)) return;
            if (sessionMenuRef.current?.contains(target)) return;
            setNewMenuOpen(false);
            setSessionMenuOpen(false);
        };

        const handleKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setNewMenuOpen(false);
                setSessionMenuOpen(false);
            }
        };

        document.addEventListener("mousedown", handleDown);
        document.addEventListener("keydown", handleKey);
        return () => {
            document.removeEventListener("mousedown", handleDown);
            document.removeEventListener("keydown", handleKey);
        };
    }, [newMenuOpen, sessionMenuOpen]);

    return (
        <div
            className="flex items-center justify-between gap-2 px-2 py-1"
            style={{ borderBottom: "1px solid var(--border)" }}
        >
            <div ref={sessionMenuRef} className="relative min-w-0 flex-1">
                <button
                    type="button"
                    onClick={() => {
                        setSessionMenuOpen((open) => !open);
                        setNewMenuOpen(false);
                    }}
                    className="flex min-w-0 max-w-full items-center gap-1.5 rounded px-1.5 py-1 text-left"
                    style={{
                        backgroundColor: "transparent",
                        border: "none",
                    }}
                    title="Recent chats"
                >
                    <span
                        className="truncate text-xs font-medium"
                        style={{ color: "var(--text-secondary)" }}
                    >
                        {currentRuntime}
                    </span>
                    <span
                        style={{
                            color: "var(--text-secondary)",
                            opacity: 0.4,
                            fontSize: 10,
                        }}
                    >
                        ·
                    </span>
                    <span
                        className="truncate text-xs"
                        style={{ color: "var(--text-primary)" }}
                    >
                        {currentTitle}
                    </span>
                    <svg
                        width="8"
                        height="8"
                        viewBox="0 0 10 10"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        style={{
                            color: "var(--text-secondary)",
                            opacity: 0.5,
                            flexShrink: 0,
                            transform: sessionMenuOpen
                                ? "rotate(180deg)"
                                : "none",
                            transition: "transform 0.12s ease",
                        }}
                    >
                        <path d="M2.5 4L5 6.5L7.5 4" />
                    </svg>
                </button>

                {sessionMenuOpen && (
                    <div
                        className="absolute left-0 top-full z-20 mt-2 min-w-[260px] max-w-[320px] overflow-hidden rounded-xl"
                        style={{
                            backgroundColor: "var(--bg-secondary)",
                            border: "1px solid var(--border)",
                            boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
                        }}
                    >
                        <AIChatSessionList
                            activeSessionId={activeSessionId}
                            sessions={sessions}
                            runtimes={runtimes}
                            onSelectSession={(sessionId) => {
                                onSelectSession(sessionId);
                                setSessionMenuOpen(false);
                            }}
                            onDeleteSession={(sessionId) => {
                                onDeleteSession(sessionId);
                            }}
                        />
                        {sessions.length > 1 && (
                            <>
                                <div
                                    style={{
                                        borderTop: "1px solid var(--border)",
                                        margin: "2px 0",
                                    }}
                                />
                                <div className="p-1">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            onDeleteAllSessions();
                                            setSessionMenuOpen(false);
                                        }}
                                        className="flex w-full items-center rounded px-2.5 py-1.5 text-left text-xs"
                                        style={{
                                            color: "#ef4444",
                                            background: "none",
                                            border: "none",
                                        }}
                                        onMouseEnter={(e) => {
                                            e.currentTarget.style.backgroundColor =
                                                "var(--bg-tertiary)";
                                        }}
                                        onMouseLeave={(e) => {
                                            e.currentTarget.style.backgroundColor =
                                                "transparent";
                                        }}
                                    >
                                        Clear all chats
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                )}
            </div>

            <div className="flex items-center gap-2">
                <div
                    className="h-2 w-2 rounded-full"
                    style={{
                        backgroundColor: STATUS_COLORS[status],
                        opacity: status === "idle" ? 0.45 : 1,
                    }}
                    title={STATUS_LABELS[status]}
                />

                <div
                    ref={newMenuRef}
                    className="relative flex items-center gap-2"
                >
                    <button
                        type="button"
                        onClick={() => {
                            setNewMenuOpen((open) => !open);
                            setSessionMenuOpen(false);
                        }}
                        className="flex h-6 w-6 items-center justify-center rounded"
                        style={{
                            color: "var(--text-secondary)",
                            backgroundColor: "transparent",
                            border: "none",
                        }}
                        title={`New chat • ${STATUS_LABELS[status]}`}
                    >
                        <svg
                            width="14"
                            height="14"
                            viewBox="0 0 14 14"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                        >
                            <path d="M7 2v10M2 7h10" />
                        </svg>
                    </button>

                    {newMenuOpen && (
                        <div
                            className="absolute right-0 top-full z-20 mt-2 overflow-hidden rounded-xl"
                            style={{
                                backgroundColor: "var(--bg-secondary)",
                                border: "1px solid var(--border)",
                                boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
                                padding: 4,
                                minWidth: 160,
                            }}
                        >
                            {runtimes.map((runtime) => (
                                <button
                                    key={runtime.id}
                                    type="button"
                                    onClick={() => {
                                        onNewChat(runtime.id);
                                        setNewMenuOpen(false);
                                    }}
                                    className="flex w-full items-center rounded px-2.5 py-1.5 text-left text-xs"
                                    style={{
                                        color: "var(--text-primary)",
                                        backgroundColor: "transparent",
                                        border: "none",
                                    }}
                                    onMouseEnter={(e) => {
                                        e.currentTarget.style.backgroundColor =
                                            "var(--bg-tertiary)";
                                    }}
                                    onMouseLeave={(e) => {
                                        e.currentTarget.style.backgroundColor =
                                            "transparent";
                                    }}
                                >
                                    {runtime.name}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
