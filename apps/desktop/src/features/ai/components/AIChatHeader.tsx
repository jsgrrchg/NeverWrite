import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getViewportSafeMenuPosition } from "../../../app/utils/menuPosition";
import { openSettingsWindow } from "../../../app/detachedWindows";
import { useVaultStore } from "../../../app/store/vaultStore";
import { useChatStore } from "../store/chatStore";
import { AIChatSessionList } from "./AIChatSessionList";
import { AIChatTabs } from "./AIChatTabs";
import { getSessionTitle } from "../sessionPresentation";
import type { AIChatSession, AIRuntimeOption } from "../types";
import type { ChatWorkspaceTab } from "../store/chatTabsStore";
import { useInlineRename } from "./useInlineRename";

interface AIChatHeaderProps {
    activeSessionId: string | null;
    activeTabId: string | null;
    tabs: ChatWorkspaceTab[];
    sessionsById: Record<string, AIChatSession>;
    panelExpanded: boolean;
    sessions: AIChatSession[];
    runtimes: AIRuntimeOption[];
    onNewChat: (runtimeId: string) => void;
    onSelectSession: (sessionId: string) => void;
    onSelectTab: (tabId: string) => void;
    onReorderTabs: (fromIndex: number, toIndex: number) => void;
    onCloseTab: (tabId: string) => void;
    onExportSession: (sessionId: string) => void;
    onDeleteSession: (sessionId: string) => void;
    onDeleteAllSessions: () => void;
    onRenameSession: (sessionId: string, newTitle: string | null) => void;
    onToggleExpanded: () => void;
}

function HeaderMenu({
    open,
    anchorRef,
    menuRef,
    children,
    minWidth,
    maxWidth,
}: {
    open: boolean;
    anchorRef: React.RefObject<HTMLElement | null>;
    menuRef: React.RefObject<HTMLDivElement | null>;
    children: React.ReactNode;
    minWidth?: number;
    maxWidth?: number | string;
}) {
    const [position, setPosition] = useState({ x: 0, y: 0 });

    useLayoutEffect(() => {
        if (!open) return;
        const anchor = anchorRef.current;
        const menu = menuRef.current;
        if (!anchor || !menu) return;

        const anchorRect = anchor.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        const safe = getViewportSafeMenuPosition(
            anchorRect.right - menuRect.width,
            anchorRect.bottom + 8,
            menuRect.width,
            menuRect.height,
        );

        setPosition(safe);
    }, [anchorRef, menuRef, open, children]);

    if (!open) return null;

    return createPortal(
        <div
            ref={menuRef}
            style={{
                position: "fixed",
                top: position.y,
                left: position.x,
                zIndex: 10010,
                minWidth,
                maxWidth,
                overflow: "hidden",
                borderRadius: 12,
                backgroundColor: "var(--bg-secondary)",
                border: "1px solid var(--border)",
                boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
            }}
        >
            {children}
        </div>,
        document.body,
    );
}

export function AIChatHeader({
    activeSessionId,
    activeTabId,
    tabs,
    sessionsById,
    panelExpanded,
    sessions,
    runtimes,
    onNewChat,
    onSelectSession,
    onSelectTab,
    onReorderTabs,
    onCloseTab,
    onExportSession,
    onDeleteSession,
    onDeleteAllSessions,
    onRenameSession,
    onToggleExpanded,
}: AIChatHeaderProps) {
    const vaultPath = useVaultStore((s) => s.vaultPath);
    const [newMenuOpen, setNewMenuOpen] = useState(false);
    const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
    const [headerWidth, setHeaderWidth] = useState<number | null>(null);
    const headerRef = useRef<HTMLDivElement>(null);
    const newMenuRef = useRef<HTMLDivElement>(null);
    const sessionMenuRef = useRef<HTMLDivElement>(null);
    const newMenuContentRef = useRef<HTMLDivElement>(null);
    const sessionMenuContentRef = useRef<HTMLDivElement>(null);
    const {
        editingKey,
        editValue,
        inputRef,
        setEditValue,
        startEditing,
        cancelEditing,
        commitEditing,
    } = useInlineRename<string>();
    const isCompact = headerWidth !== null && headerWidth < 420;
    const isTight = headerWidth !== null && headerWidth < 330;
    const activeTabSessionId =
        tabs.find((tab) => tab.id === activeTabId)?.sessionId ?? null;
    const currentSession =
        (activeTabSessionId
            ? sessionsById[activeTabSessionId]
            : activeSessionId
              ? sessionsById[activeSessionId]
              : null) ?? null;
    const showTabs = tabs.length > 1;
    const headerTitle = currentSession
        ? getSessionTitle(currentSession)
        : "New chat";

    useEffect(() => {
        const node = headerRef.current;
        if (!node) return;

        setHeaderWidth(node.getBoundingClientRect().width);
        if (typeof ResizeObserver === "undefined") {
            return;
        }

        const observer = new ResizeObserver((entries) => {
            const entry = entries[0];
            if (!entry) return;
            setHeaderWidth(entry.contentRect.width);
        });
        observer.observe(node);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        if (!newMenuOpen && !sessionMenuOpen) return;

        const handleDown = (event: MouseEvent) => {
            const target = event.target as Node | null;
            if (!target) return;
            if (newMenuRef.current?.contains(target)) return;
            if (sessionMenuRef.current?.contains(target)) return;
            if (newMenuContentRef.current?.contains(target)) return;
            if (sessionMenuContentRef.current?.contains(target)) return;
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

    function startTitleEdit() {
        if (!currentSession) return;
        startEditing(currentSession.sessionId, getSessionTitle(currentSession));
    }

    function commitTitleEdit() {
        commitEditing(onRenameSession);
    }

    return (
        <div
            ref={headerRef}
            className={`flex items-center justify-between ${
                isCompact ? "gap-1 px-1.5 py-1" : "gap-2 px-2 py-1"
            }`}
            style={{
                height: 39,
                boxSizing: "border-box",
                borderBottom: "1px solid var(--border)",
            }}
        >
            {showTabs ? (
                <AIChatTabs
                    tabs={tabs}
                    activeTabId={activeTabId}
                    sessionsById={sessionsById}
                    runtimes={runtimes}
                    density={
                        isTight
                            ? "tight"
                            : isCompact
                              ? "compact"
                              : "comfortable"
                    }
                    onSelectTab={onSelectTab}
                    onReorderTabs={onReorderTabs}
                    onCloseTab={onCloseTab}
                    onExportSession={onExportSession}
                    onRenameSession={onRenameSession}
                />
            ) : (
                <div
                    className="flex min-w-0 flex-1 items-center px-1"
                    style={{ color: "var(--text-primary)" }}
                >
                    {editingKey !== null ? (
                        <input
                            ref={inputRef}
                            className={`min-w-0 flex-1 rounded bg-transparent font-medium outline-none ${
                                isCompact ? "text-[11px]" : "text-xs"
                            }`}
                            style={{
                                color: "var(--text-primary)",
                                border: "none",
                                padding: 0,
                                borderBottom: "1px solid var(--accent)",
                            }}
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                    commitTitleEdit();
                                } else if (e.key === "Escape") {
                                    cancelEditing();
                                }
                            }}
                            onBlur={commitTitleEdit}
                        />
                    ) : (
                        <span
                            className={`cursor-default truncate font-medium ${
                                isCompact ? "text-[11px]" : "text-xs"
                            }`}
                            onDoubleClick={startTitleEdit}
                            title="Double-click to rename"
                        >
                            {headerTitle}
                        </span>
                    )}
                </div>
            )}

            <div
                className={`flex shrink-0 items-center ${
                    isCompact ? "gap-1" : "gap-2"
                }`}
            >
                <div
                    ref={newMenuRef}
                    className={`relative flex items-center ${
                        isCompact ? "gap-1" : "gap-2"
                    }`}
                >
                    <div ref={sessionMenuRef} className="relative">
                        <button
                            type="button"
                            onClick={() => {
                                setSessionMenuOpen((open) => !open);
                                setNewMenuOpen(false);
                            }}
                            className={`flex h-6 items-center rounded ${
                                isCompact ? "gap-0.5 px-1.5" : "gap-1 px-2"
                            }`}
                            style={{
                                color: sessionMenuOpen
                                    ? "var(--text-primary)"
                                    : "var(--text-secondary)",
                                backgroundColor: sessionMenuOpen
                                    ? "var(--bg-tertiary)"
                                    : "transparent",
                                border: "1px solid var(--border)",
                                transition:
                                    "background-color 100ms ease, color 100ms ease",
                            }}
                            onMouseEnter={(e) => {
                                if (sessionMenuOpen) return;
                                e.currentTarget.style.backgroundColor =
                                    "color-mix(in srgb, var(--bg-tertiary) 80%, transparent)";
                                e.currentTarget.style.color =
                                    "var(--text-primary)";
                            }}
                            onMouseLeave={(e) => {
                                if (sessionMenuOpen) return;
                                e.currentTarget.style.backgroundColor =
                                    "transparent";
                                e.currentTarget.style.color =
                                    "var(--text-secondary)";
                            }}
                            title="Recent chats"
                        >
                            <span
                                className={`font-medium ${
                                    isCompact ? "text-[10px]" : "text-[11px]"
                                }`}
                            >
                                Recent
                            </span>
                            {!isTight && (
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
                                        opacity: 0.7,
                                        transform: sessionMenuOpen
                                            ? "rotate(180deg)"
                                            : "none",
                                        transition: "transform 0.12s ease",
                                    }}
                                >
                                    <path d="M2.5 4L5 6.5L7.5 4" />
                                </svg>
                            )}
                        </button>

                        <HeaderMenu
                            open={sessionMenuOpen}
                            anchorRef={sessionMenuRef}
                            menuRef={sessionMenuContentRef}
                            minWidth={260}
                            maxWidth={320}
                        >
                            <div>
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
                                    onRenameSession={onRenameSession}
                                />
                                <div
                                    style={{
                                        borderTop: "1px solid var(--border)",
                                        margin: "2px 0",
                                    }}
                                />
                                <div className="p-1">
                                    <ChatHistoryMenuButton
                                        onClose={() =>
                                            setSessionMenuOpen(false)
                                        }
                                    />
                                </div>
                                {sessions.length > 1 && (
                                    <>
                                        <div
                                            style={{
                                                borderTop:
                                                    "1px solid var(--border)",
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
                                                    transition:
                                                        "background-color 80ms ease",
                                                }}
                                                onMouseEnter={(e) => {
                                                    e.currentTarget.style.backgroundColor =
                                                        "color-mix(in srgb, #ef4444 10%, var(--bg-secondary))";
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
                        </HeaderMenu>
                    </div>

                    <button
                        type="button"
                        onClick={onToggleExpanded}
                        className={`flex items-center justify-center rounded ${
                            isCompact ? "h-5 w-5" : "h-6 w-6"
                        }`}
                        style={{
                            color: panelExpanded
                                ? "var(--accent)"
                                : "var(--text-secondary)",
                            backgroundColor: panelExpanded
                                ? "color-mix(in srgb, var(--accent) 14%, transparent)"
                                : "transparent",
                            border: "none",
                            transition:
                                "background-color 100ms ease, color 100ms ease",
                        }}
                        onMouseEnter={(e) => {
                            if (panelExpanded) return;
                            e.currentTarget.style.backgroundColor =
                                "color-mix(in srgb, var(--bg-tertiary) 80%, transparent)";
                            e.currentTarget.style.color = "var(--text-primary)";
                        }}
                        onMouseLeave={(e) => {
                            if (panelExpanded) return;
                            e.currentTarget.style.backgroundColor =
                                "transparent";
                            e.currentTarget.style.color =
                                "var(--text-secondary)";
                        }}
                        title={
                            panelExpanded
                                ? "Restore chat panel"
                                : "Expand chat panel"
                        }
                    >
                        <svg
                            width="14"
                            height="14"
                            viewBox="0 0 14 14"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            {panelExpanded ? (
                                <>
                                    <path d="M5 2.5H2.5V5" />
                                    <path d="M9 2.5h2.5V5" />
                                    <path d="M5 11.5H2.5V9" />
                                    <path d="M9 11.5h2.5V9" />
                                </>
                            ) : (
                                <>
                                    <path d="M5 5 2.5 2.5" />
                                    <path d="M9 5 11.5 2.5" />
                                    <path d="M5 9 2.5 11.5" />
                                    <path d="M9 9 11.5 11.5" />
                                </>
                            )}
                        </svg>
                    </button>

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
                            transition:
                                "background-color 100ms ease, color 100ms ease",
                        }}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.backgroundColor =
                                "color-mix(in srgb, var(--bg-tertiary) 80%, transparent)";
                            e.currentTarget.style.color = "var(--text-primary)";
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.backgroundColor =
                                "transparent";
                            e.currentTarget.style.color =
                                "var(--text-secondary)";
                        }}
                        title="New chat"
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

                    <HeaderMenu
                        open={newMenuOpen}
                        anchorRef={newMenuRef}
                        menuRef={newMenuContentRef}
                        minWidth={160}
                    >
                        <div style={{ padding: 4 }}>
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
                                        transition:
                                            "background-color 80ms ease",
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
                            <div
                                style={{
                                    height: 1,
                                    backgroundColor: "var(--border)",
                                    margin: "4px 0",
                                }}
                            />
                            <button
                                type="button"
                                onClick={() => {
                                    setNewMenuOpen(false);
                                    void openSettingsWindow(vaultPath);
                                }}
                                className="flex w-full items-center gap-1.5 rounded px-2.5 py-1.5 text-left text-xs"
                                style={{
                                    color: "var(--text-secondary)",
                                    backgroundColor: "transparent",
                                    border: "none",
                                    transition: "background-color 80ms ease",
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
                                <svg
                                    width="12"
                                    height="12"
                                    viewBox="0 0 14 14"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.8"
                                    strokeLinecap="round"
                                >
                                    <path d="M7 2v10M2 7h10" />
                                </svg>
                                Add providers
                            </button>
                        </div>
                    </HeaderMenu>
                </div>
            </div>
        </div>
    );
}

function ChatHistoryMenuButton({ onClose }: { onClose: () => void }) {
    const openHistoryView = useChatStore((s) => s.openHistoryView);

    return (
        <button
            type="button"
            onClick={() => {
                openHistoryView();
                onClose();
            }}
            className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs"
            style={{
                color: "var(--text-primary)",
                background: "none",
                border: "none",
                transition: "background-color 80ms ease",
            }}
            onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = "var(--bg-tertiary)";
            }}
            onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = "transparent";
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
                style={{ opacity: 0.7 }}
            >
                <circle cx="8" cy="8" r="6" />
                <path d="M8 5v3l2 2" />
            </svg>
            Chat History
        </button>
    );
}
