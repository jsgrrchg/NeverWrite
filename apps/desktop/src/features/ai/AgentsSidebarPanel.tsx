import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type MouseEvent as ReactMouseEvent,
} from "react";
import { useShallow } from "zustand/react/shallow";
import {
    ContextMenu,
    type ContextMenuEntry,
    type ContextMenuState,
} from "../../components/context-menu/ContextMenu";
import { SidebarFilterInput } from "../../components/layout/SidebarFilterInput";
import {
    isChatTab,
    selectEditorWorkspaceTabs,
    selectFocusedEditorTab,
    useEditorStore,
} from "../../app/store/editorStore";
import { useSettingsStore } from "../../app/store/settingsStore";
import { useVaultStore } from "../../app/store/vaultStore";
import {
    createNewChatInWorkspace,
    openChatHistoryInWorkspace,
    openChatSessionInWorkspace,
} from "./chatPaneMovement";
import {
    getSessionPreview,
    getSessionTitle,
    getSessionTitleText,
    getSessionUpdatedAt,
} from "./sessionPresentation";
import { useChatStore } from "./store/chatStore";
import { usePinnedChatsStore } from "./store/pinnedChatsStore";
import type { AIChatSession } from "./types";
import { getRuntimeDisplayName } from "./utils/runtimeMetadata";
import { useInlineRename } from "./components/useInlineRename";
import {
    AgentsSidebarItem,
    type AgentsSidebarActivityIndicator,
    type AgentsSidebarItemMetrics,
} from "./components/AgentsSidebarItem";
import { AgentsSidebarSection } from "./components/AgentsSidebarSection";

// Comando-style Agents panel living inside the left sidebar. Replaces the
// previous right-panel AIChatPanel for the session list (the actual
// conversations still open as center editor tabs). Groups sessions into
// Pinned / Open / All, supports inline rename, pin toggle and a right-click
// context menu for rename/pin/delete.

type ActivitySession = Pick<AIChatSession, "status">;

function deriveActivityIndicator(
    session: ActivitySession,
): AgentsSidebarActivityIndicator {
    switch (session.status) {
        case "streaming":
        case "waiting_permission":
        case "waiting_user_input":
            return { tone: "working", title: "Agent busy" };
        case "error":
            return { tone: "danger", title: "Agent error" };
        default:
            return null;
    }
}

function formatAgentTimestamp(timestamp: number): string {
    if (!timestamp) return "";
    const now = Date.now();
    const diffMs = now - timestamp;
    const diffMinutes = Math.floor(diffMs / 60000);

    if (diffMinutes < 1) return "Just now";
    if (diffMinutes < 60) {
        return diffMinutes === 1
            ? "1 minute ago"
            : `${diffMinutes} minutes ago`;
    }

    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) {
        return diffHours === 1 ? "1 hour ago" : `${diffHours} hours ago`;
    }

    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) {
        return diffDays === 1 ? "Yesterday" : `${diffDays} days ago`;
    }

    return new Intl.DateTimeFormat("en", {
        month: "short",
        day: "numeric",
    }).format(timestamp);
}

function compareByUpdatedAtDesc(a: AIChatSession, b: AIChatSession) {
    return getSessionUpdatedAt(b) - getSessionUpdatedAt(a);
}

function getRuntimeMenuLabel(name: string) {
    return name.trim().replace(/ ACP$/, "");
}

function isSessionWorking(session: AIChatSession) {
    return deriveActivityIndicator(session)?.tone === "working";
}

function compareOpenSessions(
    a: AIChatSession,
    b: AIChatSession,
    workingOrder: ReadonlyMap<string, number>,
) {
    const aOrder = workingOrder.get(a.sessionId);
    const bOrder = workingOrder.get(b.sessionId);
    const aWorking = aOrder !== undefined;
    const bWorking = bOrder !== undefined;

    if (aWorking && bWorking) {
        // Keep actively streaming agents from reshuffling on every update.
        return aOrder - bOrder;
    }
    if (aWorking !== bWorking) {
        return aWorking ? -1 : 1;
    }
    return compareByUpdatedAtDesc(a, b);
}

function scaleMetric(base: number, scale: number, min: number) {
    return Math.max(min, Math.round(base * scale * 10) / 10);
}

function buildAgentsSidebarMetrics(scalePercent: number): {
    item: AgentsSidebarItemMetrics;
    header: {
        fontSize: number;
        paddingX: number;
        paddingTop: number;
        paddingBottom: number;
    };
    summaryFontSize: number;
    summaryPaddingX: number;
    summaryPaddingTop: number;
    summaryPaddingBottom: number;
    actionButtonSize: number;
    actionIconSize: number;
} {
    const scale = scalePercent / 100;
    return {
        item: {
            rowPaddingX: scaleMetric(8, scale, 7),
            rowPaddingY: scaleMetric(6, scale, 5),
            rowGap: scaleMetric(2, scale, 1.5),
            inlineGap: scaleMetric(6, scale, 5),
            titleFontSize: scaleMetric(11.5, scale, 10.5),
            previewFontSize: scaleMetric(10.5, scale, 9.5),
            metaFontSize: scaleMetric(10, scale, 9),
            timestampFontSize: scaleMetric(10, scale, 9),
            indicatorFontSize: scaleMetric(9, scale, 8),
            pinButtonSize: scaleMetric(16, scale, 14),
            pinIconSize: scaleMetric(11, scale, 10),
        },
        header: {
            fontSize: scaleMetric(10, scale, 9),
            paddingX: scaleMetric(8, scale, 7),
            paddingTop: scaleMetric(8, scale, 6),
            paddingBottom: scaleMetric(4, scale, 3),
        },
        summaryFontSize: scaleMetric(10.5, scale, 9.5),
        summaryPaddingX: scaleMetric(12, scale, 10),
        summaryPaddingTop: scaleMetric(6, scale, 5),
        summaryPaddingBottom: scaleMetric(4, scale, 3),
        actionButtonSize: scaleMetric(20, scale, 18),
        actionIconSize: scaleMetric(12, scale, 11),
    };
}

export function AgentsSidebarPanel() {
    const vaultPath = useVaultStore((state) => state.vaultPath);
    const agentsSidebarScale = useSettingsStore(
        (state) => state.agentsSidebarScale,
    );
    const activeSessionId = useChatStore((state) => state.activeSessionId);
    const sessionsById = useChatStore((state) => state.sessionsById);
    const sessionOrder = useChatStore((state) => state.sessionOrder);
    const runtimes = useChatStore((state) => state.runtimes);
    const selectedRuntimeId = useChatStore((state) => state.selectedRuntimeId);
    const deleteSession = useChatStore((state) => state.deleteSession);
    const renameSession = useChatStore((state) => state.renameSession);

    const pinnedEntries = usePinnedChatsStore((state) => state.entries);
    const togglePinnedChat = usePinnedChatsStore((state) => state.togglePin);
    const unpinChat = usePinnedChatsStore((state) => state.unpin);
    const reconcilePinned = usePinnedChatsStore((state) => state.reconcile);

    // Sessions currently open as editor tabs across any pane. Drives the
    // "Open" section — mirrors Comando's behaviour of bubbling live tabs to
    // the top of the list.
    const openSessionIds = useEditorStore(
        useShallow((state) => {
            const ids = new Set<string>();
            for (const tab of selectEditorWorkspaceTabs(state)) {
                if (isChatTab(tab)) ids.add(tab.sessionId);
            }
            return ids;
        }),
    );

    const focusedWorkspaceChatSessionId = useEditorStore(
        useShallow((state) => {
            const focused = selectFocusedEditorTab(state);
            return focused && isChatTab(focused) ? focused.sessionId : null;
        }),
    );

    // Raw chronological list (persisted order already reflects updatedAt).
    const sessions = useMemo(
        () =>
            sessionOrder
                .map((sessionId) => sessionsById[sessionId])
                .filter((session): session is AIChatSession => Boolean(session)),
        [sessionOrder, sessionsById],
    );

    // Prune pins that no longer correspond to a live session on load/update.
    useEffect(() => {
        reconcilePinned(sessions.map((session) => session.sessionId));
    }, [reconcilePinned, sessions]);

    const [filterText, setFilterText] = useState("");
    const normalizedFilter = filterText.trim().toLowerCase();
    const hasFilter = normalizedFilter.length > 0;

    const filteredSessions = useMemo(() => {
        if (!hasFilter) return sessions;
        return sessions.filter((session) => {
            const title = getSessionTitleText(session).toLowerCase();
            if (title.includes(normalizedFilter)) return true;
            const preview = getSessionPreview(session).toLowerCase();
            return preview.includes(normalizedFilter);
        });
    }, [hasFilter, normalizedFilter, sessions]);

    const workingOrderRef = useRef<Map<string, number>>(new Map());
    const workingCounterRef = useRef(0);
    const [workingOrderRevision, setWorkingOrderRevision] = useState(0);

    useEffect(() => {
        const map = workingOrderRef.current;
        const liveSessionIds = new Set<string>();
        let changed = false;

        for (const session of sessions) {
            liveSessionIds.add(session.sessionId);
            const working = isSessionWorking(session);
            const tracked = map.has(session.sessionId);
            if (working && !tracked) {
                workingCounterRef.current += 1;
                map.set(session.sessionId, workingCounterRef.current);
                changed = true;
            } else if (!working && tracked) {
                map.delete(session.sessionId);
                changed = true;
            }
        }

        for (const trackedId of Array.from(map.keys())) {
            if (!liveSessionIds.has(trackedId)) {
                map.delete(trackedId);
                changed = true;
            }
        }

        if (changed) {
            setWorkingOrderRevision((value) => value + 1);
        }
    }, [sessions]);

    const { pinnedSessions, openSessions, otherSessions } = useMemo(() => {
        const pinned: AIChatSession[] = [];
        const open: AIChatSession[] = [];
        const other: AIChatSession[] = [];
        for (const session of filteredSessions) {
            if (pinnedEntries[session.sessionId]) {
                pinned.push(session);
            } else if (openSessionIds.has(session.sessionId)) {
                open.push(session);
            } else {
                other.push(session);
            }
        }
        pinned.sort((a, b) => {
            const aPinned = pinnedEntries[a.sessionId]?.pinnedAt ?? 0;
            const bPinned = pinnedEntries[b.sessionId]?.pinnedAt ?? 0;
            if (bPinned !== aPinned) return bPinned - aPinned;
            return compareByUpdatedAtDesc(a, b);
        });
        open.sort((a, b) =>
            compareOpenSessions(a, b, workingOrderRef.current),
        );
        other.sort(compareByUpdatedAtDesc);
        return {
            pinnedSessions: pinned,
            openSessions: open,
            otherSessions: other,
        };
        // workingOrderRevision keeps this memo in sync with the ref-backed map.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filteredSessions, openSessionIds, pinnedEntries, workingOrderRevision]);

    const totalCount = sessions.length;
    const filteredCount = filteredSessions.length;
    // Only decorate Open/All headers when there is more than one non-pinned
    // section or when Pinned is already showing — otherwise a single "Open"
    // header above a lonely list reads as noise.
    const showOpenAllHeaders =
        pinnedSessions.length > 0 ||
        (openSessions.length > 0 && otherSessions.length > 0);

    const {
        editingKey,
        editValue,
        inputRef,
        setEditValue,
        startEditing,
        cancelEditing,
        commitEditing,
    } = useInlineRename<string>();

    const handleStartRename = useCallback(
        (session: AIChatSession) => {
            startEditing(session.sessionId, getSessionTitleText(session));
        },
        [startEditing],
    );

    const handleCommitRename = useCallback(() => {
        commitEditing((key, value) => {
            renameSession(key, value);
        });
    }, [commitEditing, renameSession]);

    const handleDelete = useCallback(
        (session: AIChatSession) => {
            unpinChat(session.sessionId);
            void deleteSession(session.sessionId);
        },
        [deleteSession, unpinChat],
    );

    // --- Context menu ------------------------------------------------------
    const [contextMenu, setContextMenu] = useState<
        ContextMenuState<AIChatSession> | null
    >(null);
    const [newChatMenu, setNewChatMenu] =
        useState<ContextMenuState<void> | null>(null);

    const newChatMenuEntries = useMemo<ContextMenuEntry[]>(() => {
        const sortedRuntimes = [...runtimes].sort((left, right) => {
            if (left.runtime.id === selectedRuntimeId) return -1;
            if (right.runtime.id === selectedRuntimeId) return 1;
            return left.runtime.name.localeCompare(right.runtime.name);
        });

        if (sortedRuntimes.length === 0) {
            return [{ label: "No providers available", disabled: true }];
        }

        return sortedRuntimes.map((runtime) => ({
            label: getRuntimeMenuLabel(runtime.runtime.name),
            action: () => {
                void createNewChatInWorkspace(runtime.runtime.id);
            },
        }));
    }, [runtimes, selectedRuntimeId]);

    const handleContextMenu = useCallback(
        (event: ReactMouseEvent<HTMLElement>, session: AIChatSession) => {
            event.preventDefault();
            event.stopPropagation();
            setNewChatMenu(null);
            setContextMenu({
                x: event.clientX,
                y: event.clientY,
                payload: session,
            });
        },
        [],
    );

    const activeSidebarId = focusedWorkspaceChatSessionId ?? activeSessionId;
    const metrics = useMemo(
        () => buildAgentsSidebarMetrics(agentsSidebarScale),
        [agentsSidebarScale],
    );

    const renderItem = (session: AIChatSession) => {
        const isPinned = Boolean(pinnedEntries[session.sessionId]);
        const indicator = deriveActivityIndicator(session);
        const updatedAt = getSessionUpdatedAt(session);
        const runtimeDescriptor = runtimes.find(
            (descriptor) => descriptor.runtime.id === session.runtimeId,
        );
        const runtimeLabel = getRuntimeDisplayName(
            session.runtimeId,
            runtimeDescriptor?.runtime.name,
        );
        const messageCount =
            session.persistedMessageCount ?? session.messages.length;
        const timestampLabel = indicator
            ? indicator.tone === "danger"
                ? "Error"
                : "Working…"
            : formatAgentTimestamp(updatedAt);

        return (
            <AgentsSidebarItem
                key={session.sessionId}
                session={session}
                title={getSessionTitle(session)}
                preview={getSessionPreview(session)}
                runtimeLabel={runtimeLabel}
                messageCount={messageCount}
                timestampLabel={timestampLabel}
                isActive={activeSidebarId === session.sessionId}
                isPinned={isPinned}
                indicator={indicator}
                isRenaming={editingKey === session.sessionId}
                renameValue={editValue}
                onRenameChange={setEditValue}
                onRenameCommit={handleCommitRename}
                onRenameCancel={cancelEditing}
                renameInputRef={inputRef}
                onOpen={() => {
                    void openChatSessionInWorkspace(session.sessionId);
                }}
                onStartRename={() => handleStartRename(session)}
                onTogglePin={() => togglePinnedChat(session.sessionId)}
                onContextMenu={(event) => handleContextMenu(event, session)}
                metrics={metrics.item}
            />
        );
    };

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div
                className="shrink-0"
                style={{ borderBottom: "1px solid var(--border)" }}
            >
                <div className="px-2 pb-2">
                    <SidebarFilterInput
                        value={filterText}
                        onChange={setFilterText}
                        placeholder="Filter threads..."
                        ariaLabel="Filter threads"
                    />
                </div>
            </div>

            <div
                className="flex shrink-0 items-center justify-between px-3 pt-1.5 pb-1 text-[10.5px]"
                style={{
                    color: "var(--text-secondary)",
                    fontSize: metrics.summaryFontSize,
                    padding: `${metrics.summaryPaddingTop}px ${metrics.summaryPaddingX}px ${metrics.summaryPaddingBottom}px`,
                }}
            >
                <span>
                    {hasFilter
                        ? `${filteredCount} of ${totalCount}`
                        : totalCount === 1
                          ? "1 thread"
                          : `${totalCount} threads`}
                </span>
                <div className="flex items-center gap-1">
                    <button
                        type="button"
                        onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            const rect =
                                event.currentTarget.getBoundingClientRect();
                            setContextMenu(null);
                            setNewChatMenu({
                                x: rect.left,
                                y: rect.bottom + 4,
                                payload: undefined,
                            });
                        }}
                        title="New chat"
                        aria-label="New chat"
                        className="flex h-5 w-5 items-center justify-center rounded"
                        style={{
                            width: metrics.actionButtonSize,
                            height: metrics.actionButtonSize,
                            color: "var(--text-secondary)",
                            background: "transparent",
                        }}
                    >
                        <svg
                            width={metrics.actionIconSize}
                            height={metrics.actionIconSize}
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.6"
                            strokeLinecap="round"
                        >
                            <path d="M8 3v10M3 8h10" />
                        </svg>
                    </button>
                    <button
                        type="button"
                        onClick={() => openChatHistoryInWorkspace()}
                        title="Open chat history"
                        className="rounded px-1.5 py-0.5 text-[10.5px]"
                        style={{
                            color: "var(--text-secondary)",
                            background: "transparent",
                            fontSize: metrics.summaryFontSize,
                        }}
                    >
                        History
                    </button>
                </div>
            </div>

            <div
                className="min-h-0 flex-1 overflow-y-auto px-1 pb-2"
                data-scrollbar-active="true"
            >
                {totalCount === 0 ? (
                    <PlaceholderMessage
                        body={
                            vaultPath
                                ? "No chats yet for this vault."
                                : "Open a vault to start chatting."
                        }
                    />
                ) : filteredCount === 0 ? (
                    <PlaceholderMessage
                        body={`No threads match "${filterText.trim()}".`}
                    />
                ) : (
                    <>
                        <AgentsSidebarSection
                            title="Pinned"
                            count={pinnedSessions.length}
                            headerMetrics={metrics.header}
                        >
                            {pinnedSessions.map(renderItem)}
                        </AgentsSidebarSection>
                        <AgentsSidebarSection
                            title="Open"
                            count={openSessions.length}
                            showHeader={showOpenAllHeaders}
                            headerMetrics={metrics.header}
                        >
                            {openSessions.map(renderItem)}
                        </AgentsSidebarSection>
                        <AgentsSidebarSection
                            title="All"
                            count={otherSessions.length}
                            showHeader={showOpenAllHeaders}
                            headerMetrics={metrics.header}
                        >
                            {otherSessions.map(renderItem)}
                        </AgentsSidebarSection>
                    </>
                )}
            </div>

            {contextMenu && (
                <ContextMenu
                    menu={contextMenu}
                    onClose={() => setContextMenu(null)}
                    entries={[
                        {
                            label: pinnedEntries[contextMenu.payload.sessionId]
                                ? "Unpin from Sidebar"
                                : "Pin to Sidebar",
                            action: () =>
                                togglePinnedChat(contextMenu.payload.sessionId),
                        },
                        {
                            label: "Rename",
                            action: () =>
                                handleStartRename(contextMenu.payload),
                        },
                        { type: "separator" },
                        {
                            label: "Delete",
                            danger: true,
                            action: () => handleDelete(contextMenu.payload),
                        },
                    ]}
                />
            )}
            {newChatMenu && (
                <ContextMenu
                    menu={newChatMenu}
                    onClose={() => setNewChatMenu(null)}
                    entries={newChatMenuEntries}
                    minWidth={132}
                />
            )}
        </div>
    );
}

function PlaceholderMessage({ body }: { body: string }) {
    return (
        <div className="flex min-h-[80px] items-center justify-center px-3 py-6">
            <p
                className="text-center text-[11px] leading-[1.5]"
                style={{ color: "var(--text-secondary)" }}
            >
                {body}
            </p>
        </div>
    );
}
