import { useMemo, useState } from "react";
import {
    DATE_GROUP_ORDER,
    getDateGroup,
    getSessionTitle,
    getSessionUpdatedAt,
    type DateGroup,
} from "../sessionPresentation";
import type { AIChatSession, AIRuntimeOption } from "../types";
import { HistorySessionCard } from "./HistorySessionCard";

interface HistorySessionListProps {
    sessions: AIChatSession[];
    runtimes: AIRuntimeOption[];
    selectedSessionId: string | null;
    onSelectSession: (sessionId: string) => void;
    onDeleteSession: (sessionId: string) => void;
    onRenameSession: (sessionId: string, newTitle: string | null) => void;
}

function matchesSearch(session: AIChatSession, query: string): boolean {
    const lower = query.toLowerCase();
    const title = getSessionTitle(session).toLowerCase();
    if (title.includes(lower)) return true;
    const preview = (session.persistedPreview ?? "").toLowerCase();
    return preview.includes(lower);
}

function groupByDate(
    sessions: AIChatSession[],
): [DateGroup, AIChatSession[]][] {
    const groups = new Map<DateGroup, AIChatSession[]>();
    for (const session of sessions) {
        const group = getDateGroup(getSessionUpdatedAt(session));
        const list = groups.get(group);
        if (list) {
            list.push(session);
        } else {
            groups.set(group, [session]);
        }
    }
    return DATE_GROUP_ORDER.filter((g) => groups.has(g)).map((g) => [
        g,
        groups.get(g)!,
    ]);
}

export function HistorySessionList({
    sessions,
    runtimes,
    selectedSessionId,
    onSelectSession,
    onDeleteSession,
    onRenameSession,
}: HistorySessionListProps) {
    const [search, setSearch] = useState("");

    const sorted = useMemo(() => {
        const copy = [...sessions];
        copy.sort((a, b) => getSessionUpdatedAt(b) - getSessionUpdatedAt(a));
        return copy;
    }, [sessions]);

    const filtered = useMemo(() => {
        if (!search.trim()) return sorted;
        return sorted.filter((s) => matchesSearch(s, search));
    }, [sorted, search]);

    const groups = useMemo(() => groupByDate(filtered), [filtered]);

    return (
        <div className="flex h-full min-h-0 flex-col">
            {/* Search bar */}
            <div
                className="shrink-0 px-3 py-2"
                style={{ borderBottom: "1px solid var(--border)" }}
            >
                <div
                    className="flex items-center gap-2 rounded-md px-2.5 py-1.5"
                    style={{
                        background: "var(--bg-primary)",
                        border: "1px solid var(--border)",
                    }}
                >
                    <svg
                        width="14"
                        height="14"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        style={{
                            color: "var(--text-secondary)",
                            opacity: 0.5,
                            flexShrink: 0,
                        }}
                    >
                        <circle cx="7" cy="7" r="5" />
                        <path d="M11 11l3.5 3.5" />
                    </svg>
                    <input
                        type="text"
                        placeholder="Search chats…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="min-w-0 flex-1 text-xs outline-none"
                        style={{
                            background: "transparent",
                            color: "var(--text-primary)",
                            border: "none",
                        }}
                    />
                    {search && (
                        <button
                            type="button"
                            onClick={() => setSearch("")}
                            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm"
                            style={{
                                background: "none",
                                border: "none",
                                color: "var(--text-secondary)",
                                opacity: 0.6,
                            }}
                        >
                            <svg
                                width="10"
                                height="10"
                                viewBox="0 0 10 10"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                            >
                                <path d="M2 2l6 6M8 2l-6 6" />
                            </svg>
                        </button>
                    )}
                </div>
            </div>

            {/* Session list */}
            <div
                className="min-h-0 flex-1 overflow-y-auto p-1"
                data-scrollbar-active="true"
            >
                {groups.length === 0 && (
                    <div
                        className="px-3 py-8 text-center text-xs"
                        style={{ color: "var(--text-secondary)" }}
                    >
                        {search
                            ? "No chats match your search."
                            : "No chat history yet."}
                    </div>
                )}

                {groups.map(([group, groupSessions]) => (
                    <div key={group} className="mb-1">
                        <div
                            className="sticky top-0 z-10 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider"
                            style={{
                                color: "var(--text-secondary)",
                                opacity: 0.6,
                                background: "var(--bg-secondary)",
                            }}
                        >
                            {group}
                        </div>
                        <div className="flex flex-col gap-0.5">
                            {groupSessions.map((session) => (
                                <HistorySessionCard
                                    key={session.sessionId}
                                    session={session}
                                    runtimes={runtimes}
                                    isSelected={
                                        session.sessionId === selectedSessionId
                                    }
                                    onSelect={() =>
                                        onSelectSession(session.sessionId)
                                    }
                                    onDelete={() =>
                                        onDeleteSession(session.sessionId)
                                    }
                                    onRename={(newTitle) =>
                                        onRenameSession(
                                            session.sessionId,
                                            newTitle,
                                        )
                                    }
                                />
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
