import { useCallback, useRef, useState } from "react";
import {
    ContextMenu,
    type ContextMenuState,
} from "../../../components/context-menu/ContextMenu";
import {
    getRuntimeName,
    getSessionRuntimeName,
    getSessionTitle,
} from "../sessionPresentation";
import type {
    AIChatSession,
    AIChatSessionStatus,
    AIRuntimeOption,
} from "../types";
import type { ChatWorkspaceTab } from "../store/chatTabsStore";

interface AIChatTabsProps {
    tabs: ChatWorkspaceTab[];
    activeTabId: string | null;
    sessionsById: Record<string, AIChatSession>;
    runtimes: AIRuntimeOption[];
    density?: "comfortable" | "compact" | "tight";
    onSelectTab: (tabId: string) => void;
    onCloseTab: (tabId: string) => void;
    onExportSession: (sessionId: string) => void;
}

const STATUS_COLORS: Record<AIChatSessionStatus, string> = {
    idle: "var(--text-secondary)",
    streaming: "var(--accent)",
    waiting_permission: "#d97706",
    waiting_user_input: "#c2410c",
    review_required: "#0891b2",
    error: "#dc2626",
};

const STATUS_LABELS: Record<AIChatSessionStatus, string> = {
    idle: "Idle",
    streaming: "Streaming",
    waiting_permission: "Waiting for approval",
    waiting_user_input: "Waiting for input",
    review_required: "Review required",
    error: "Error",
};

function getFallbackTitle(sessionId: string) {
    return sessionId.startsWith("persisted:") ? "Saved chat" : "Chat";
}

export function AIChatTabs({
    tabs,
    activeTabId,
    sessionsById,
    runtimes,
    density = "comfortable",
    onSelectTab,
    onCloseTab,
    onExportSession,
}: AIChatTabsProps) {
    const isCompact = density !== "comfortable";
    const isTight = density === "tight";
    const [contextMenu, setContextMenu] = useState<ContextMenuState<{
        tabId: string;
        sessionId: string;
        hasSession: boolean;
    }> | null>(null);
    const tabListRef = useRef<HTMLDivElement>(null);
    const handleWheel = useCallback((e: React.WheelEvent) => {
        if (e.deltaY !== 0 && tabListRef.current) {
            e.preventDefault();
            tabListRef.current.scrollLeft += e.deltaY;
        }
    }, []);

    if (!tabs.length) {
        return (
            <div
                className="flex min-w-0 flex-1 items-center px-1"
                style={{ color: "var(--text-secondary)" }}
            >
                <span className="truncate px-2 text-xs">No open chats</span>
            </div>
        );
    }

    return (
        <div
            ref={tabListRef}
            role="tablist"
            aria-label="Chat tabs"
            onWheel={handleWheel}
            className={`scrollbar-hidden flex min-w-0 flex-1 items-center overflow-x-auto overflow-y-hidden ${
                isCompact ? "gap-0.5 px-0.5" : "gap-1 px-1"
            }`}
        >
            {tabs.map((tab) => {
                const session = sessionsById[tab.sessionId];
                const status = session?.status ?? "idle";
                const isActive = tab.id === activeTabId;
                const title = session
                    ? getSessionTitle(session)
                    : getFallbackTitle(tab.sessionId);
                const runtimeName = session
                    ? getSessionRuntimeName(session, runtimes)
                    : getRuntimeName(tab.runtimeId, runtimes);

                return (
                    <div
                        key={tab.id}
                        className={`group flex min-w-0 shrink items-center rounded-md border transition-colors ${
                            isCompact ? "gap-0.5 pr-0.5" : "gap-1 pr-1"
                        }`}
                        onContextMenu={(event) => {
                            event.preventDefault();
                            setContextMenu({
                                x: event.clientX,
                                y: event.clientY,
                                payload: {
                                    tabId: tab.id,
                                    sessionId: tab.sessionId,
                                    hasSession: Boolean(session),
                                },
                            });
                        }}
                        style={{
                            width: isTight ? 88 : isCompact ? 112 : 172,
                            minWidth: isTight ? 42 : isCompact ? 52 : 58,
                            flexShrink: 0,
                            borderColor: isActive
                                ? "color-mix(in srgb, var(--accent) 45%, var(--border))"
                                : "var(--border)",
                            backgroundColor: isActive
                                ? "color-mix(in srgb, var(--accent) 12%, var(--bg-secondary))"
                                : "var(--bg-secondary)",
                            color: isActive
                                ? "var(--text-primary)"
                                : "var(--text-secondary)",
                        }}
                        onMouseEnter={(e) => {
                            if (isActive) return;
                            e.currentTarget.style.backgroundColor =
                                "color-mix(in srgb, var(--bg-tertiary) 60%, var(--bg-secondary))";
                            e.currentTarget.style.color = "var(--text-primary)";
                        }}
                        onMouseLeave={(e) => {
                            if (isActive) return;
                            e.currentTarget.style.backgroundColor =
                                "var(--bg-secondary)";
                            e.currentTarget.style.color =
                                "var(--text-secondary)";
                        }}
                    >
                        <button
                            role="tab"
                            type="button"
                            aria-selected={isActive}
                            onClick={() => onSelectTab(tab.id)}
                            className={`flex min-w-0 flex-1 items-center text-left ${
                                isCompact
                                    ? "gap-1 px-1.5 py-1"
                                    : "gap-2 px-2 py-1"
                            }`}
                            style={{
                                background: "none",
                                border: "none",
                            }}
                            title={`${runtimeName} • ${title}`}
                        >
                            <span
                                className="h-2 w-2 shrink-0 rounded-full"
                                style={{
                                    backgroundColor: STATUS_COLORS[status],
                                    opacity: status === "idle" ? 0.45 : 1,
                                }}
                                title={STATUS_LABELS[status]}
                            />
                            <span
                                className={`min-w-0 flex-1 truncate font-medium ${
                                    isTight ? "text-[11px]" : "text-xs"
                                }`}
                            >
                                {title}
                            </span>
                            {!isCompact && (
                                <span
                                    className="truncate text-[10px]"
                                    style={{
                                        color: "var(--text-secondary)",
                                        opacity: isActive ? 0.85 : 0.6,
                                        maxWidth: 72,
                                    }}
                                >
                                    {runtimeName.replace(/ ACP$/, "")}
                                </span>
                            )}
                        </button>
                        <button
                            type="button"
                            aria-label={`Close ${title}`}
                            onClick={(event) => {
                                event.stopPropagation();
                                onCloseTab(tab.id);
                            }}
                            className={`flex shrink-0 items-center justify-center rounded text-[10px] ${
                                isTight ? "h-4 w-4" : "h-5 w-5"
                            }`}
                            style={{
                                background: "none",
                                border: "none",
                                color: "var(--text-secondary)",
                                opacity: isActive ? 0.8 : 0.5,
                            }}
                        >
                            <svg
                                width="10"
                                height="10"
                                viewBox="0 0 10 10"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.6"
                                strokeLinecap="round"
                            >
                                <path d="M2 2L8 8M8 2L2 8" />
                            </svg>
                        </button>
                    </div>
                );
            })}
            {contextMenu && (
                <ContextMenu
                    menu={contextMenu}
                    onClose={() => setContextMenu(null)}
                    entries={[
                        {
                            label: "Export chat to Markdown",
                            action: () =>
                                onExportSession(contextMenu.payload.sessionId),
                            disabled: !contextMenu.payload.hasSession,
                        },
                        { type: "separator" },
                        {
                            label: "Close tab",
                            action: () => onCloseTab(contextMenu.payload.tabId),
                        },
                    ]}
                />
            )}
        </div>
    );
}
