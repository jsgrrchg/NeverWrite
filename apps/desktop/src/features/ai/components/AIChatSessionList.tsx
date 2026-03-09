import {
    formatSessionTime,
    getSessionPreview,
    getSessionRuntimeName,
    getSessionTitle,
    getSessionUpdatedAt,
} from "../sessionPresentation";
import type { AIChatSession, AIRuntimeOption } from "../types";

interface AIChatSessionListProps {
    activeSessionId: string | null;
    sessions: AIChatSession[];
    runtimes: AIRuntimeOption[];
    onSelectSession: (sessionId: string) => void;
}

const STATUS_COLORS = {
    idle: "var(--text-secondary)",
    streaming: "var(--accent)",
    waiting_permission: "#d97706",
    review_required: "#0891b2",
    error: "#dc2626",
} as const;

export function AIChatSessionList({
    activeSessionId,
    sessions,
    runtimes,
    onSelectSession,
}: AIChatSessionListProps) {
    if (!sessions.length) {
        return (
            <div
                className="px-3 py-6 text-center text-sm"
                style={{ color: "var(--text-secondary)" }}
            >
                No chats yet.
            </div>
        );
    }

    return (
        <div className="max-h-[360px] overflow-y-auto p-2" data-scrollbar-active="true">
            <div className="flex flex-col gap-1">
                {sessions.map((session) => {
                    const isActive = session.sessionId === activeSessionId;
                    const updatedAt = getSessionUpdatedAt(session);

                    return (
                        <button
                            key={session.sessionId}
                            type="button"
                            onClick={() => onSelectSession(session.sessionId)}
                            className="w-full rounded-xl px-3 py-2 text-left"
                            style={{
                                backgroundColor: isActive
                                    ? "color-mix(in srgb, var(--accent) 10%, transparent)"
                                    : "transparent",
                                border: `1px solid ${
                                    isActive
                                        ? "color-mix(in srgb, var(--accent) 32%, var(--border))"
                                        : "transparent"
                                }`,
                            }}
                        >
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                    <div
                                        className="truncate text-sm font-medium"
                                        style={{ color: "var(--text-primary)" }}
                                    >
                                        {getSessionTitle(session)}
                                    </div>
                                    <div
                                        className="mt-1 truncate text-xs"
                                        style={{ color: "var(--text-secondary)" }}
                                    >
                                        {getSessionPreview(session)}
                                    </div>
                                </div>
                                {updatedAt ? (
                                    <div
                                        className="shrink-0 text-[11px]"
                                        style={{ color: "var(--text-secondary)" }}
                                    >
                                        {formatSessionTime(updatedAt)}
                                    </div>
                                ) : null}
                            </div>
                            <div className="mt-2 flex items-center gap-2">
                                <div
                                    className="h-1.5 w-1.5 rounded-full"
                                    style={{
                                        backgroundColor: STATUS_COLORS[session.status],
                                        opacity: session.status === "idle" ? 0.55 : 1,
                                    }}
                                />
                                <span
                                    className="truncate text-[11px]"
                                    style={{ color: "var(--text-secondary)" }}
                                >
                                    {getSessionRuntimeName(session, runtimes)}
                                </span>
                            </div>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
