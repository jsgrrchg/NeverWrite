import { Fragment, useCallback, useState } from "react";
import {
    ContextMenu,
    type ContextMenuState,
} from "../../../components/context-menu/ContextMenu";
import { useTabDragReorder } from "../../editor/useTabDragReorder";
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
import { openChatSessionInWorkspace } from "../chatPaneMovement";
import { useInlineRename } from "./useInlineRename";

interface AIChatTabsProps {
    tabs: ChatWorkspaceTab[];
    activeTabId: string | null;
    sessionsById: Record<string, AIChatSession>;
    runtimes: AIRuntimeOption[];
    density?: "comfortable" | "compact" | "tight";
    onSelectTab: (tabId: string) => void;
    onReorderTabs: (fromIndex: number, toIndex: number) => void;
    onCloseTab: (tabId: string) => void;
    onExportSession: (sessionId: string) => void;
    onRenameSession: (sessionId: string, newTitle: string | null) => void;
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
    onReorderTabs,
    onCloseTab,
    onExportSession,
    onRenameSession,
}: AIChatTabsProps) {
    const isCompact = density !== "comfortable";
    const isTight = density === "tight";
    const [contextMenu, setContextMenu] = useState<ContextMenuState<{
        tabId: string;
        sessionId: string;
        hasSession: boolean;
    }> | null>(null);
    const {
        editingKey,
        editValue,
        inputRef,
        setEditValue,
        startEditing,
        cancelEditing,
        commitEditing,
    } = useInlineRename<string>();
    const {
        draggingTabId,
        projectedDropIndex,
        tabStripRef,
        visualTabs,
        registerTabNode,
        handlePointerDown,
        handlePointerMove,
        handlePointerUp,
        handleLostPointerCapture,
        consumeSuppressedClick,
    } = useTabDragReorder({
        tabs,
        onCommitReorder: onReorderTabs,
        onActivate: onSelectTab,
        liveReorder: false,
    });
    const handleWheel = useCallback(
        (e: React.WheelEvent) => {
            if (e.deltaY !== 0 && tabStripRef.current) {
                e.preventDefault();
                tabStripRef.current.scrollLeft += e.deltaY;
            }
        },
        [tabStripRef],
    );
    const handleTabPointerDownCapture = useCallback(
        (tabId: string, event: React.PointerEvent<HTMLDivElement>) => {
            if (event.button !== 0) return;
            if ((event.target as HTMLElement).closest("button")) return;
            onSelectTab(tabId);
        },
        [onSelectTab],
    );
    const handleTabClick = useCallback(
        (tabId: string) => {
            if (editingKey === tabId) return;
            if (consumeSuppressedClick(tabId)) return;
            onSelectTab(tabId);
        },
        [consumeSuppressedClick, editingKey, onSelectTab],
    );
    const beginTabRename = useCallback(
        (tabId: string, session: AIChatSession | undefined) => {
            if (!session) return;
            onSelectTab(tabId);
            startEditing(tabId, getSessionTitle(session));
        },
        [onSelectTab, startEditing],
    );
    const draggingOriginalIndex = draggingTabId
        ? tabs.findIndex((tab) => tab.id === draggingTabId)
        : -1;
    const insertionIndicatorIndex =
        draggingOriginalIndex === -1 || projectedDropIndex == null
            ? null
            : projectedDropIndex > draggingOriginalIndex
              ? projectedDropIndex + 1
              : projectedDropIndex;

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
            ref={tabStripRef}
            role="tablist"
            aria-label="Chat tabs"
            onWheel={handleWheel}
            className={`scrollbar-hidden flex min-w-0 flex-1 items-center overflow-x-auto overflow-y-hidden ${
                isCompact ? "gap-0.5 px-0.5" : "gap-1 px-1"
            }`}
        >
            {insertionIndicatorIndex === 0 && (
                <div
                    aria-hidden="true"
                    className="shrink-0 rounded-full"
                    style={{
                        width: 3,
                        height: isTight ? 18 : 22,
                        marginRight: isCompact ? 2 : 4,
                        backgroundColor: "var(--accent)",
                        boxShadow:
                            "0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent)",
                    }}
                />
            )}
            {visualTabs.map((tab, index) => {
                const session = sessionsById[tab.sessionId];
                const status = session?.status ?? "idle";
                const isActive = tab.id === activeTabId;
                const isDragging = tab.id === draggingTabId;
                const isEditing = editingKey === tab.id;
                const title = session
                    ? getSessionTitle(session)
                    : getFallbackTitle(tab.sessionId);
                const runtimeName = session
                    ? getSessionRuntimeName(session, runtimes)
                    : getRuntimeName(tab.runtimeId, runtimes);

                return (
                    <Fragment key={tab.id}>
                        <div
                            data-tab-id={tab.id}
                            ref={(node) => registerTabNode(tab.id, node)}
                            role="tab"
                            tabIndex={0}
                            aria-selected={isActive}
                            title={`${runtimeName} • ${title}`}
                            className={`group flex min-w-0 shrink items-center rounded-md border transition-colors ${
                                isCompact ? "gap-0.5 pr-0.5" : "gap-1 pr-1"
                            }`}
                            onPointerDownCapture={(event) =>
                                isEditing
                                    ? undefined
                                    : handleTabPointerDownCapture(tab.id, event)
                            }
                            onPointerDown={(event) =>
                                isEditing
                                    ? undefined
                                    : handlePointerDown(tab.id, index, event)
                            }
                            onPointerMove={(event) =>
                                isEditing
                                    ? undefined
                                    : handlePointerMove(tab.id, event)
                            }
                            onPointerUp={(event) =>
                                isEditing
                                    ? undefined
                                    : handlePointerUp(event.pointerId, {
                                          clientX: event.clientX,
                                          clientY: event.clientY,
                                          screenX: event.screenX,
                                          screenY: event.screenY,
                                      })
                            }
                            onPointerCancel={(event) =>
                                isEditing
                                    ? undefined
                                    : handlePointerUp(event.pointerId, {
                                          clientX: event.clientX,
                                          clientY: event.clientY,
                                          screenX: event.screenX,
                                          screenY: event.screenY,
                                      })
                            }
                            onLostPointerCapture={(event) =>
                                isEditing
                                    ? undefined
                                    : handleLostPointerCapture(event.pointerId)
                            }
                            onKeyDown={(event) => {
                                if (isEditing) return;
                                if (
                                    event.key === "Enter" ||
                                    event.key === " "
                                ) {
                                    event.preventDefault();
                                    onSelectTab(tab.id);
                                }
                            }}
                            onClick={() => handleTabClick(tab.id)}
                            onContextMenu={(event) => {
                                if (isEditing) return;
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
                                opacity: isDragging ? 0.7 : 1,
                                position: "relative",
                                zIndex: isDragging ? 2 : 1,
                                cursor: isDragging ? "grabbing" : "pointer",
                            }}
                            onMouseEnter={(e) => {
                                if (isActive) return;
                                e.currentTarget.style.backgroundColor =
                                    "color-mix(in srgb, var(--bg-tertiary) 60%, var(--bg-secondary))";
                                e.currentTarget.style.color =
                                    "var(--text-primary)";
                            }}
                            onMouseLeave={(e) => {
                                if (isActive) return;
                                e.currentTarget.style.backgroundColor =
                                    "var(--bg-secondary)";
                                e.currentTarget.style.color =
                                    "var(--text-secondary)";
                            }}
                        >
                            <div
                                className={`flex min-w-0 flex-1 items-center text-left ${
                                    isCompact
                                        ? "gap-1 px-1.5 py-1"
                                        : "gap-2 px-2 py-1"
                                }`}
                            >
                                <span
                                    className="h-2 w-2 shrink-0 rounded-full"
                                    style={{
                                        backgroundColor: STATUS_COLORS[status],
                                        opacity: status === "idle" ? 0.45 : 1,
                                    }}
                                    title={STATUS_LABELS[status]}
                                />
                                {isEditing ? (
                                    <input
                                        ref={inputRef}
                                        value={editValue}
                                        onChange={(event) =>
                                            setEditValue(event.target.value)
                                        }
                                        onKeyDown={(event) => {
                                            if (event.key === "Enter") {
                                                commitEditing(
                                                    (editedTabId, value) => {
                                                        const editedTab =
                                                            tabs.find(
                                                                (candidate) =>
                                                                    candidate.id ===
                                                                    editedTabId,
                                                            );
                                                        if (!editedTab) return;
                                                        onRenameSession(
                                                            editedTab.sessionId,
                                                            value,
                                                        );
                                                    },
                                                );
                                            } else if (event.key === "Escape") {
                                                cancelEditing();
                                            }
                                        }}
                                        onBlur={() =>
                                            commitEditing(
                                                (editedTabId, value) => {
                                                    const editedTab = tabs.find(
                                                        (candidate) =>
                                                            candidate.id ===
                                                            editedTabId,
                                                    );
                                                    if (!editedTab) return;
                                                    onRenameSession(
                                                        editedTab.sessionId,
                                                        value,
                                                    );
                                                },
                                            )
                                        }
                                        onClick={(event) =>
                                            event.stopPropagation()
                                        }
                                        className={`min-w-0 flex-1 rounded bg-transparent font-medium leading-none outline-none ${
                                            isTight ? "text-[11px]" : "text-xs"
                                        }`}
                                        style={{
                                            color: "var(--text-primary)",
                                            border: "none",
                                            padding: 0,
                                            height: isTight ? 14 : 16,
                                            minHeight: 0,
                                            lineHeight: 1,
                                            boxSizing: "border-box",
                                            boxShadow:
                                                "inset 0 -1px 0 var(--accent)",
                                        }}
                                    />
                                ) : (
                                    <span
                                        className={`min-w-0 flex-1 truncate font-medium ${
                                            isTight ? "text-[11px]" : "text-xs"
                                        }`}
                                    >
                                        {title}
                                    </span>
                                )}
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
                            </div>
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
                        {insertionIndicatorIndex === index + 1 && (
                            <div
                                aria-hidden="true"
                                className="shrink-0 rounded-full"
                                style={{
                                    width: 3,
                                    height: isTight ? 18 : 22,
                                    marginLeft: isCompact ? 2 : 4,
                                    marginRight: isCompact ? 2 : 4,
                                    backgroundColor: "var(--accent)",
                                    boxShadow:
                                        "0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent)",
                                }}
                            />
                        )}
                    </Fragment>
                );
            })}
            {contextMenu && (
                <ContextMenu
                    menu={contextMenu}
                    onClose={() => setContextMenu(null)}
                    entries={[
                        {
                            label: "Rename chat",
                            action: () => {
                                const tab = tabs.find(
                                    (candidate) =>
                                        candidate.id ===
                                        contextMenu.payload.tabId,
                                );
                                beginTabRename(
                                    contextMenu.payload.tabId,
                                    tab
                                        ? sessionsById[tab.sessionId]
                                        : undefined,
                                );
                            },
                            disabled: !contextMenu.payload.hasSession,
                        },
                        {
                            label: "Export chat to Markdown",
                            action: () =>
                                onExportSession(contextMenu.payload.sessionId),
                            disabled: !contextMenu.payload.hasSession,
                        },
                        { type: "separator" },
                        {
                            label: "Open in Workspace",
                            action: () =>
                                openChatSessionInWorkspace(
                                    contextMenu.payload.sessionId,
                                ),
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
