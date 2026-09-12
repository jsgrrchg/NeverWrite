import { useUnreadChatsStore } from "./store/unreadChatsStore";
import { useChatTabsStore } from "./store/chatTabsStore";
import {
    useCallback,
    useEffect,
    useMemo,
    useState,
    type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { confirm } from "@neverwrite/runtime";
import { useShallow } from "zustand/react/shallow";
import {
    ContextMenu,
    type ContextMenuEntry,
    type ContextMenuState,
} from "../../components/context-menu/ContextMenu";
import { SidebarFilterInput } from "../../components/layout/SidebarFilterInput";
import {
    isTerminalTab,
    selectFocusedEditorTab,
    useEditorStore,
} from "../../app/store/editorStore";
import { useSettingsStore } from "../../app/store/settingsStore";
import { useVaultStore } from "../../app/store/vaultStore";
import {
    safeStorageGetItem,
    safeStorageSetItem,
} from "../../app/utils/safeStorage";
import {
    openChatHistoryInWorkspace,
    openChatSessionInWorkspace,
} from "./chatPaneMovement";
import {
    createCanonicalAgent,
    createClaudeCodeAgent,
} from "./newAgentCreation";
import { emitAgentSidebarDrag } from "./agentSidebarDragEvents";
import {
    getSessionTitleText,
    getSessionUpdatedAt,
} from "./sessionPresentation";
import {
    buildAiSessionHierarchyGroups,
    countAiSessionChildren,
    type AiSessionHierarchyGroup,
} from "./sessionHierarchy";
import {
    claudeTerminalAgentSessionId,
    closeClaudeTerminalAgentSession,
    focusClaudeTerminalAgentSession,
    isClaudeTerminalAgentSession,
} from "./claudeTerminalAgentSession";
import { useChatStore } from "./store/chatStore";
import { archiveChat, unarchiveChat } from "./chatArchiving";
import { isSessionArchived, useArchivedChatsStore } from "./store/archivedChatsStore";
import { usePinnedChatsStore } from "./store/pinnedChatsStore";
import type { AIChatSession } from "./types";
import {
    CLAUDE_TERMINAL_RUNTIME_ID,
} from "./utils/runtimeMetadata";
import { useInlineRename } from "./components/useInlineRename";
import {
    AgentsSidebarItem,
    type AgentsSidebarActivityIndicator,
    type AgentsSidebarItemMetrics,
} from "./components/AgentsSidebarItem";
import { AIProviderIcon } from "./components/AIProviderIcon";
import { AgentsSidebarSection } from "./components/AgentsSidebarSection";

// Card-based Agents panel for the session list. Conversations open in the
// dedicated chat pane. The list groups them by status and supports inline
// rename, pinning, archiving and deletion.

const AGENTS_SIDEBAR_COLLAPSED_PARENTS_KEY =
    "neverwrite.ai.agentsSidebar.collapsedParents";

type ActivitySession = Pick<AIChatSession, "status">;

type AgentDragPreview = {
    x: number;
    y: number;
    title: string;
    runtimeId: string;
};

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

function formatAgentTimestamp(timestamp: number, compact = false): string {
    if (!timestamp) return "";
    const now = Date.now();
    const diffMs = now - timestamp;
    const diffMinutes = Math.floor(diffMs / 60000);

    if (diffMinutes < 1) return compact ? "Now" : "Just now";
    if (diffMinutes < 60) {
        if (compact) return `${diffMinutes}m`;
        return diffMinutes === 1
            ? "1 minute ago"
            : `${diffMinutes} minutes ago`;
    }

    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) {
        if (compact) return `${diffHours}h`;
        return diffHours === 1 ? "1 hour ago" : `${diffHours} hours ago`;
    }

    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) {
        if (compact) return `${diffDays}d`;
        return diffDays === 1 ? "Yesterday" : `${diffDays} days ago`;
    }

    return new Intl.DateTimeFormat("en", {
        month: "short",
        day: "numeric",
    }).format(timestamp);
}

function isSessionWorking(session: AIChatSession) {
    return deriveActivityIndicator(session)?.tone === "working";
}

function loadCollapsedParentSessionIds() {
    try {
        const raw = safeStorageGetItem(AGENTS_SIDEBAR_COLLAPSED_PARENTS_KEY);
        const parsed = raw ? (JSON.parse(raw) as unknown) : null;
        if (!Array.isArray(parsed)) return new Set<string>();
        return new Set(parsed.filter((id): id is string => typeof id === "string"));
    } catch {
        return new Set<string>();
    }
}

function persistCollapsedParentSessionIds(ids: ReadonlySet<string>) {
    try {
        safeStorageSetItem(
            AGENTS_SIDEBAR_COLLAPSED_PARENTS_KEY,
            JSON.stringify([...ids]),
        );
    } catch {
        // Sidebar collapse state is a convenience preference; ignore quota failures.
    }
}

function isSubagentSession(session: AIChatSession) {
    return Boolean(session.parentSessionId?.trim());
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
            rowPaddingLeft: scaleMetric(12, scale, 10),
            rowPaddingY: scaleMetric(8, scale, 6),
            inlineGap: scaleMetric(6, scale, 5),
            titleFontSize: scaleMetric(12, scale, 11),
            timestampFontSize: scaleMetric(10, scale, 9),
            providerIconSize: scaleMetric(12, scale, 10),
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
    const claudeCodeEnabled = useSettingsStore(
        (state) => state.claudeCodeEnabled,
    );
    const sessionsById = useChatStore((state) => state.sessionsById);
    const sessionOrder = useChatStore((state) => state.sessionOrder);
    const claudeCodeSetupStatus = useChatStore(
        (state) => state.setupStatusByRuntimeId[CLAUDE_TERMINAL_RUNTIME_ID],
    );
    const sessionInventoryLoaded = useChatStore(
        (state) => state.sessionInventoryLoaded,
    );
    const deleteSession = useChatStore((state) => state.deleteSession);
    const renameSession = useChatStore((state) => state.renameSession);

    const unreadEntries = useUnreadChatsStore(state => state.entries);
    const archivedEntries = useArchivedChatsStore(state => state.entries);
    const [archivedExpanded, setArchivedExpanded] = useState(false);
    const pinnedEntries = usePinnedChatsStore((state) => state.entries);
    const togglePinnedChat = usePinnedChatsStore((state) => state.togglePin);
    const unpinChat = usePinnedChatsStore((state) => state.unpin);
    const reconcilePinned = usePinnedChatsStore((state) => state.reconcile);
    // Terminal agents retain editor tabs; conversations use dedicated metadata.
    const focusedWorkspaceChatSessionId = useChatTabsStore(state => state.view.mode === "conversation" ? state.view.sessionId : null);

    // When a Claude Code terminal tab is focused, mark its agent entry as
    // selected (the entry has no chat tab of its own).
    const focusedTerminalAgentSessionId = useEditorStore(
        useShallow((state) => {
            const focused = selectFocusedEditorTab(state);
            return focused && isTerminalTab(focused)
                ? claudeTerminalAgentSessionId(focused.terminalId)
                : null;
        }),
    );

    // The store preserves positions until a turn completes.
    const sessions = useMemo(
        () =>
            sessionOrder
                .map((sessionId) => sessionsById[sessionId])
                .filter((session): session is AIChatSession => Boolean(session)),
        [sessionOrder, sessionsById],
    );

    const [filterText, setFilterText] = useState("");
    const normalizedFilter = filterText.trim().toLowerCase();
    const hasFilter = normalizedFilter.length > 0;

    const pinnedRootIds = useMemo(
        () => new Set(Object.keys(pinnedEntries)),
        [pinnedEntries],
    );
    const hierarchy = useMemo(
        () => buildAiSessionHierarchyGroups({
            sessions,
            normalizedFilter,
            pinnedSessionIds: pinnedRootIds,
            // A zero comparison retains the input order for siblings.
            compareSiblings: () => 0,
        }),
        [sessions, normalizedFilter, pinnedRootIds],
    );

    // Pins are root-owned: legacy child pins are pruned so subagents stay under
    // their parent instead of jumping into a separate Pinned bucket.
    useEffect(() => {
        if (!sessionInventoryLoaded) return;
        reconcilePinned(hierarchy.rootSessionIds);
    }, [hierarchy.rootSessionIds, reconcilePinned, sessionInventoryLoaded]);

    // Opening a chat must not move it into a different section. Pins and
    // archives remain explicit groups; all other conversations share one list.
    const { pinnedGroups, activeGroups, archivedGroups } = useMemo(() => {
        const order = new Map(sessionOrder.map((id, index) => [id, index]));
        const groupPosition = (group: AiSessionHierarchyGroup) =>
            Math.min(...group.sessionIds.map(id => order.get(id) ?? Number.MAX_SAFE_INTEGER));
        const compareGroups = (a: AiSessionHierarchyGroup, b: AiSessionHierarchyGroup) =>
            groupPosition(a) - groupPosition(b);
        const archived: AiSessionHierarchyGroup[] = [];
        const pinned: AiSessionHierarchyGroup[] = [];
        const active: AiSessionHierarchyGroup[] = [];
        for (const group of hierarchy.groups) {
            if (isSessionArchived(group.root, sessionsById, archivedEntries)) {
                archived.push(group);
            } else if (group.isPinnedRoot) {
                pinned.push(group);
            } else {
                active.push(group);
            }
        }
        pinned.sort((a, b) => {
            const aPinned = pinnedEntries[a.root.sessionId]?.pinnedAt ?? 0;
            const bPinned = pinnedEntries[b.root.sessionId]?.pinnedAt ?? 0;
            return bPinned - aPinned || compareGroups(a, b);
        });
        return {
            archivedGroups: archived.sort(compareGroups),
            pinnedGroups: pinned,
            activeGroups: active.sort(compareGroups),
        };
    }, [hierarchy.groups, sessionOrder, pinnedEntries, archivedEntries, sessionsById]);
    const totalCount = sessions.length;
    const filteredCount = hierarchy.groups.reduce(
        (count, group) => count + 1 + group.visibleChildren.length,
        0,
    );
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
        async (session: AIChatSession) => {
            const title = getSessionTitleText(session);
            const childCount = countAiSessionChildren(session, sessions);
            const preservedAgents =
                childCount === 1
                    ? "1 subagent will stay in the sidebar as a detached agent."
                    : `${childCount} subagents will stay in the sidebar as detached agents.`;
            const message =
                childCount > 0
                    ? `Delete "${title}"?\n\nThis deletes only this thread's history and workspace snapshot. ${preservedAgents}\n\nThis cannot be undone.`
                    : `Delete "${title}"?\n\nThis deletes the thread history and workspace snapshot.\n\nThis cannot be undone.`;

            const approved = await confirm(message, {
                title: "Delete thread?",
                kind: "warning",
            });
            if (!approved) return;

            await deleteSession(session.sessionId);
            unpinChat(session.sessionId);
        },
        [deleteSession, sessions, unpinChat],
    );

    const handleCloseClaudeTerminal = useCallback(
        async (session: AIChatSession) => {
            const title = getSessionTitleText(session);
            const approved = await confirm(
                `Close terminal "${title}"?\n\nThis closes the Claude Code terminal backing this Agents entry. The entry will disappear from the sidebar when the terminal closes.`,
                {
                    title: "Close terminal?",
                    kind: "warning",
                },
            );
            if (!approved) return;

            await closeClaudeTerminalAgentSession(session);
        },
        [],
    );

    // --- Context menu ------------------------------------------------------
    const [contextMenu, setContextMenu] = useState<
        ContextMenuState<AIChatSession> | null
    >(null);
    const [newChatMenu, setNewChatMenu] =
        useState<ContextMenuState<void> | null>(null);
    const [dragPreview, setDragPreview] = useState<AgentDragPreview | null>(
        null,
    );
    const newChatMenuEntries = useMemo<ContextMenuEntry[]>(() => {
        return [
            {
                label: "New Agent",
                action: () => {
                    void createCanonicalAgent();
                },
            },
            {
                label: "Claude Code",
                action: () => {
                    void createClaudeCodeAgent();
                },
            },
        ];
    }, []);

    const showClaudeCodeCreation =
        claudeCodeEnabled &&
        claudeCodeSetupStatus?.authReady === true &&
        !claudeCodeSetupStatus.onboardingRequired;

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

    const activeSidebarId =
        focusedWorkspaceChatSessionId ??
        (focusedTerminalAgentSessionId &&
        sessionsById[focusedTerminalAgentSessionId]
            ? focusedTerminalAgentSessionId
            : null);
    const metrics = useMemo(
        () => buildAgentsSidebarMetrics(agentsSidebarScale),
        [agentsSidebarScale],
    );
    const [collapsedParentIds, setCollapsedParentIds] = useState(
        loadCollapsedParentSessionIds,
    );

    const toggleCollapsedParent = useCallback((sessionId: string) => {
        setCollapsedParentIds((current) => {
            const next = new Set(current);
            if (next.has(sessionId)) {
                next.delete(sessionId);
            } else {
                next.add(sessionId);
            }
            persistCollapsedParentSessionIds(next);
            return next;
        });
    }, []);

    const renderItem = (
        session: AIChatSession,
        options?: {
            depth?: number;
            childCount?: number;
            isCollapsed?: boolean;
            canPin?: boolean;
            canRename?: boolean;
            onToggleCollapse?: () => void;
        },
    ) => {
        const isSubagent = isSubagentSession(session);
        const canPin = options?.canPin ?? !isSubagent;
        const canRename = options?.canRename ?? !isSubagent;
        const isPinned = Boolean(pinnedEntries[session.sessionId]);
        const indicator = deriveActivityIndicator(session);
        const updatedAt = getSessionUpdatedAt(session);
        const timestampLabel = formatAgentTimestamp(updatedAt, isSubagent || isSessionArchived(session, sessionsById, archivedEntries));
        const dragTitle = getSessionTitleText(session);
        const updateDragPreview = (clientX: number, clientY: number) => {
            setDragPreview({
                x: clientX,
                y: clientY,
                title: dragTitle,
                runtimeId: session.runtimeId,
            });
        };
        return (
            <AgentsSidebarItem
                key={session.sessionId}
                session={session}
                title={getSessionTitleText(session)}
                timestampLabel={timestampLabel}
                isActive={activeSidebarId === session.sessionId}
                isPinned={canPin && isPinned}
                compact={isSubagent}
                isArchived={isSessionArchived(session, sessionsById, archivedEntries)}
                onToggleArchive={!isSubagent && !isClaudeTerminalAgentSession(session) ? () => isSessionArchived(session, sessionsById, archivedEntries) ? unarchiveChat(session.sessionId) : archiveChat(session.sessionId) : undefined}
                canPin={canPin && !isSessionArchived(session, sessionsById, archivedEntries)}
                canRename={canRename}
                depth={options?.depth ?? (isSubagent ? 1 : 0)}
                indicator={indicator}
                isUnread={Boolean(unreadEntries[session.sessionId])}
                childCount={options?.childCount ?? 0}
                isCollapsed={options?.isCollapsed ?? false}
                isRenaming={editingKey === session.sessionId}
                renameValue={editValue}
                onRenameChange={setEditValue}
                onRenameCommit={handleCommitRename}
                onRenameCancel={cancelEditing}
                renameInputRef={inputRef}
                onOpen={() => {
                    if (session.runtimeId === CLAUDE_TERMINAL_RUNTIME_ID) {
                        focusClaudeTerminalAgentSession(session);
                        return;
                    }
                    void openChatSessionInWorkspace(session.sessionId);
                }}
                onStartRename={() => {
                    if (canRename) handleStartRename(session);
                }}
                onTogglePin={() => {
                    if (canPin) togglePinnedChat(session.sessionId);
                }}
                onToggleCollapse={options?.onToggleCollapse}
                onContextMenu={(event) => handleContextMenu(event, session)}
                onDragStart={({ clientX, clientY }) => {
                    updateDragPreview(clientX, clientY);
                    emitAgentSidebarDrag({
                        phase: "start",
                        x: clientX,
                        y: clientY,
                        sessionId: session.sessionId,
                        title: dragTitle,
                    });
                }}
                onDragMove={({ clientX, clientY }) => {
                    updateDragPreview(clientX, clientY);
                    emitAgentSidebarDrag({
                        phase: "move",
                        x: clientX,
                        y: clientY,
                        sessionId: session.sessionId,
                        title: dragTitle,
                    });
                }}
                onDragEnd={({ clientX, clientY }) => {
                    setDragPreview(null);
                    emitAgentSidebarDrag({
                        phase: "end",
                        x: clientX,
                        y: clientY,
                        sessionId: session.sessionId,
                        title: dragTitle,
                    });
                }}
                onDragCancel={() => {
                    setDragPreview(null);
                    emitAgentSidebarDrag({
                        phase: "cancel",
                        x: 0,
                        y: 0,
                        sessionId: session.sessionId,
                        title: dragTitle,
                    });
                }}
                metrics={metrics.item}
            />
        );
    };

    const renderGroup = (group: AiSessionHierarchyGroup) => {
        const collapsed = collapsedParentIds.has(group.root.sessionId);
        const forceChildrenVisible =
            hasFilter ||
            group.visibleChildren.some(
                (child) =>
                    child.sessionId === activeSidebarId ||
                    isSessionWorking(child),
            );
        const showChildren =
            group.visibleChildren.length > 0 &&
            (!collapsed || forceChildrenVisible);

        return (
            <div key={group.root.sessionId} className="flex flex-col">
                {renderItem(group.root, {
                    childCount: group.children.length,
                    isCollapsed: collapsed && !forceChildrenVisible,
                    onToggleCollapse:
                        group.children.length > 0
                            ? () => toggleCollapsedParent(group.root.sessionId)
                            : undefined,
                    canPin: !group.isDetachedAgent,
                    canRename: !group.isDetachedAgent,
                })}
                {showChildren
                    ? group.visibleChildren.map((child) =>
                          renderItem(child, {
                              depth: 1,
                              canPin: false,
                              canRename: false,
                          }),
                      )
                    : null}
            </div>
        );
    };

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="shrink-0 px-2 pt-2 pb-2">
                <SidebarFilterInput
                    value={filterText}
                    onChange={setFilterText}
                    placeholder="Filter threads..."
                    ariaLabel="Filter threads"
                />
            </div>

            <div
                className="flex shrink-0 items-center justify-end px-3 pt-1.5 pb-1 text-[10.5px]"
                style={{
                    color: "var(--text-secondary)",
                    fontSize: metrics.summaryFontSize,
                    padding: `${metrics.summaryPaddingTop}px ${metrics.summaryPaddingX}px ${metrics.summaryPaddingBottom}px`,
                }}
            >
                <div className="flex items-center gap-1">
                    <button
                        type="button"
                        onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            if (!showClaudeCodeCreation) {
                                void createCanonicalAgent();
                                return;
                            }
                            const rect =
                                event.currentTarget.getBoundingClientRect();
                            setContextMenu(null);
                            setNewChatMenu({
                                x: rect.left,
                                y: rect.bottom + 4,
                                payload: undefined,
                            });
                        }}
                        title="New agent"
                        aria-label="New agent"
                        className="ub-chrome-btn flex h-5 w-5 cursor-pointer items-center justify-center rounded"
                        style={{
                            width: metrics.actionButtonSize,
                            height: metrics.actionButtonSize,
                            color: "var(--text-secondary)",
                            background: "transparent",
                            border: "1px solid transparent",
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
                        className="ub-chrome-btn cursor-pointer rounded px-1.5 py-0.5 text-[10.5px]"
                        style={{
                            color: "var(--text-secondary)",
                            background: "transparent",
                            border: "1px solid transparent",
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
                            count={pinnedGroups.length}
                            headerMetrics={metrics.header}
                        >
                            {pinnedGroups.map(renderGroup)}
                        </AgentsSidebarSection>
                        <AgentsSidebarSection
                            title="Chats"
                            count={activeGroups.length}
                            showHeader={pinnedGroups.length > 0}
                            headerMetrics={metrics.header}
                        >
                            {activeGroups.map(renderGroup)}
                        </AgentsSidebarSection>
                        {archivedGroups.length > 0 && <section className="mt-3" aria-label="Archived chats">
                            <button
                                type="button"
                                className="flex w-full items-center gap-2 px-2 py-2 text-left text-xs"
                                style={{ color: "var(--text-secondary)" }}
                                aria-expanded={hasFilter || archivedExpanded}
                                onClick={() => setArchivedExpanded(value => !value)}
                            >
                                <span>Archived ({archivedGroups.length})</span>
                                <span className="h-px min-w-0 flex-1" style={{ background: "var(--border)" }} aria-hidden="true" />
                                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true" style={{ transform: hasFilter || archivedExpanded ? undefined : "rotate(-90deg)" }}>
                                    <path d="m4 6 4 4 4-4" />
                                </svg>
                            </button>
                            {(hasFilter || archivedExpanded) && <div className="flex flex-col gap-0.5">{archivedGroups.map(renderGroup)}</div>}
                        </section>}
                    </>
                )}
            </div>

            {contextMenu && (
                <ContextMenu
                    menu={contextMenu}
                    onClose={() => setContextMenu(null)}
                    entries={[
                        ...(!isSubagentSession(contextMenu.payload) && !isClaudeTerminalAgentSession(contextMenu.payload) ? [{
                            label: isSessionArchived(contextMenu.payload, sessionsById, archivedEntries) ? "Unarchive" : "Archive",
                            action: () => isSessionArchived(contextMenu.payload, sessionsById, archivedEntries) ? unarchiveChat(contextMenu.payload.sessionId) : archiveChat(contextMenu.payload.sessionId),
                        }] : []),
                        {
                            label: pinnedEntries[contextMenu.payload.sessionId]
                                ? "Unpin from Sidebar"
                                : "Pin to Sidebar",
                            disabled: isSubagentSession(contextMenu.payload) || isSessionArchived(contextMenu.payload, sessionsById, archivedEntries),
                            action: () =>
                                togglePinnedChat(contextMenu.payload.sessionId),
                        },
                        {
                            label: "Rename",
                            disabled: isSubagentSession(contextMenu.payload),
                            action: () =>
                                handleStartRename(contextMenu.payload),
                        },
                        { type: "separator" },
                        isClaudeTerminalAgentSession(contextMenu.payload)
                            ? {
                                  label: "Close Terminal",
                                  danger: true,
                                  action: () => {
                                      void handleCloseClaudeTerminal(
                                          contextMenu.payload,
                                      );
                                  },
                              }
                            : {
                                  label: "Delete",
                                  danger: true,
                                  action: () => {
                                      void handleDelete(contextMenu.payload);
                                  },
                              },
                    ]}
                />
            )}
            {newChatMenu && showClaudeCodeCreation && (
                <ContextMenu
                    menu={newChatMenu}
                    onClose={() => setNewChatMenu(null)}
                    entries={newChatMenuEntries}
                    minWidth={132}
                />
            )}
            {dragPreview && typeof document !== "undefined"
                ? createPortal(
                      <AgentSidebarDragGhost preview={dragPreview} />,
                      document.body,
                  )
                : null}
        </div>
    );
}

function AgentSidebarDragGhost({ preview }: { preview: AgentDragPreview }) {
    return (
        <div
            aria-hidden="true"
            data-testid="agent-sidebar-drag-preview"
            style={{
                position: "fixed",
                left: preview.x + 14,
                top: preview.y + 14,
                pointerEvents: "none",
                zIndex: 10050,
                display: "flex",
                alignItems: "center",
                gap: 6,
                maxWidth: 220,
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "var(--bg-secondary)",
                color: "var(--text-primary)",
                boxShadow: "0 8px 18px rgba(0,0,0,0.18)",
                padding: "10px 12px",
                transform: "translate3d(0, 0, 0)",
            }}
        >
            <AIProviderIcon
                runtimeId={preview.runtimeId}
                size={12}
                className="shrink-0 opacity-70"
            />
            <span className="min-w-0 truncate text-[11.5px] font-medium leading-tight">
                {preview.title}
            </span>
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
