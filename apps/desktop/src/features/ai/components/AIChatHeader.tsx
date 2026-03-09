import { useEffect, useRef, useState } from "react";
import { AIChatSessionList } from "./AIChatSessionList";
import {
    getSessionRuntimeName,
    getSessionTitle,
} from "../sessionPresentation";
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
}: AIChatHeaderProps) {
    const [newMenuOpen, setNewMenuOpen] = useState(false);
    const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
    const newMenuRef = useRef<HTMLDivElement>(null);
    const sessionMenuRef = useRef<HTMLDivElement>(null);
    const currentRuntime = currentSession
        ? getSessionRuntimeName(currentSession, runtimes)
        : "Agent";
    const currentTitle = currentSession ? getSessionTitle(currentSession) : "New chat";

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
            className="flex items-center justify-between gap-3 px-3 py-2"
            style={{ borderBottom: "1px solid var(--border)" }}
        >
            <div ref={sessionMenuRef} className="relative min-w-0 flex-1">
                <button
                    type="button"
                    onClick={() => {
                        setSessionMenuOpen((open) => !open);
                        setNewMenuOpen(false);
                    }}
                    className="flex min-w-0 max-w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left"
                    style={{
                        backgroundColor: "transparent",
                        border: "1px solid transparent",
                    }}
                    title="Recent chats"
                >
                    <div className="min-w-0">
                        <div
                            className="truncate text-sm font-medium"
                            style={{ color: "var(--text-primary)" }}
                        >
                            {currentTitle}
                        </div>
                        <div
                            className="mt-0.5 flex items-center gap-2 text-[11px]"
                            style={{ color: "var(--text-secondary)" }}
                        >
                            <span>{currentRuntime}</span>
                            <span>•</span>
                            <span>{sessions.length} chats</span>
                        </div>
                    </div>
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
                            color: "var(--text-secondary)",
                            opacity: 0.7,
                            flexShrink: 0,
                            transform: sessionMenuOpen ? "rotate(180deg)" : "none",
                            transition: "transform 0.12s ease",
                        }}
                    >
                        <path d="M2.5 4L5 6.5L7.5 4" />
                    </svg>
                </button>

                {sessionMenuOpen && (
                    <div
                        className="absolute left-0 top-full z-20 mt-2 min-w-[320px] max-w-[360px] overflow-hidden rounded-xl"
                        style={{
                            backgroundColor: "var(--bg-elevated)",
                            border: "1px solid var(--border)",
                            boxShadow: "var(--shadow-soft)",
                        }}
                    >
                        <div
                            className="flex items-center justify-between gap-3 px-3 py-2"
                            style={{ borderBottom: "1px solid var(--border)" }}
                        >
                            <div>
                                <div
                                    className="text-[11px] uppercase tracking-[0.14em]"
                                    style={{ color: "var(--text-secondary)" }}
                                >
                                    Chats
                                </div>
                                <div
                                    className="mt-1 text-xs"
                                    style={{ color: "var(--text-secondary)" }}
                                >
                                    Switch between recent conversations
                                </div>
                            </div>
                        </div>
                        <AIChatSessionList
                            activeSessionId={activeSessionId}
                            sessions={sessions}
                            runtimes={runtimes}
                            onSelectSession={(sessionId) => {
                                onSelectSession(sessionId);
                                setSessionMenuOpen(false);
                            }}
                        />
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

                <div ref={newMenuRef} className="relative flex items-center gap-2">
                    <button
                        type="button"
                        onClick={() => {
                            setNewMenuOpen((open) => !open);
                            setSessionMenuOpen(false);
                        }}
                        className="rounded-md px-2 py-1 text-xs"
                        style={{
                            color:
                                status === "idle"
                                    ? "var(--text-secondary)"
                                    : "var(--text-primary)",
                            backgroundColor: "transparent",
                            border: "1px solid transparent",
                        }}
                        title={`New chat • ${STATUS_LABELS[status]}`}
                    >
                        New agent
                    </button>

                    {newMenuOpen && (
                        <div
                            className="absolute right-0 top-full z-20 mt-2 min-w-[220px] overflow-hidden rounded-xl"
                            style={{
                                backgroundColor: "var(--bg-elevated)",
                                border: "1px solid var(--border)",
                                boxShadow: "var(--shadow-soft)",
                            }}
                        >
                            <div
                                className="px-3 py-2 text-[11px] uppercase tracking-[0.14em]"
                                style={{
                                    color: "var(--text-secondary)",
                                    borderBottom: "1px solid var(--border)",
                                }}
                            >
                                Start new chat
                            </div>
                            <div className="p-2">
                                {runtimes.map((runtime) => (
                                    <button
                                        key={runtime.id}
                                        type="button"
                                        onClick={() => {
                                            onNewChat(runtime.id);
                                            setNewMenuOpen(false);
                                        }}
                                        className="flex w-full flex-col rounded-lg px-3 py-2 text-left"
                                        style={{
                                            color: "var(--text-primary)",
                                            backgroundColor: "transparent",
                                            border: "none",
                                        }}
                                    >
                                        <span className="text-sm font-medium">
                                            {runtime.name}
                                        </span>
                                        <span
                                            className="mt-0.5 text-xs"
                                            style={{ color: "var(--text-secondary)" }}
                                        >
                                            {runtime.description}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
