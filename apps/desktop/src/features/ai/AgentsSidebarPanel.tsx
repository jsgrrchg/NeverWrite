import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
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
    isChatTab,
    isTerminalTab,
    selectFocusedEditorTab,
    useEditorStore,
} from "../../app/store/editorStore";
import { useSettingsStore } from "../../app/store/settingsStore";
import { useVaultStore } from "../../app/store/vaultStore";
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
    getSessionTitle,
    getSessionTitleText,
    getSessionUpdatedAt,
} from "./sessionPresentation";
import { countAiSessionChildren } from "./sessionHierarchy";
import {
    claudeTerminalAgentSessionId,
    closeClaudeTerminalAgentSession,
    focusClaudeTerminalAgentSession,
    isClaudeTerminalAgentSession,
} from "./claudeTerminalAgentSession";
import { useChatStore } from "./store/chatStore";
import {
    useAgentSidebarStore,
    type ChatFolder,
} from "./store/agentSidebarStore";
import type { AIChatSession } from "./types";
import {
    CLAUDE_TERMINAL_RUNTIME_ID,
} from "./utils/runtimeMetadata";
import { useInlineRename } from "./components/useInlineRename";
import {
    AgentsSidebarItem,
    type AgentsSidebarItemMetrics,
} from "./components/AgentsSidebarItem";
import { AIProviderIcon } from "./components/AIProviderIcon";
import { AgentsSidebarSection } from "./components/AgentsSidebarSection";
import { AgentsSidebarShelf } from "./components/AgentsSidebarShelf";
import {
    buildAgentSidebarProjection,
    agentSidebarStatusNeedsAttention,
    canCompleteAgentSidebarStatus,
    isEffectivelyCompleted,
    resolveAgentSidebarSessionStatus,
    type AgentSidebarGroup,
    type AgentSidebarStatus,
} from "./agentSidebarModel";
import {
    AGENT_SNOOZE_PRESETS,
    formatSnoozeWakeLabel,
    getSafeSnoozeDelay,
    resolveAgentSnoozeTimestamp,
} from "./agentSidebarSnooze";

// Comando-style Agents panel living inside the left sidebar. Replaces the
// previous right-panel AIChatPanel for the session list (the actual
// conversations still open as center editor tabs). Groups sessions into
// Pinned / Open / All, supports inline rename, pin toggle and a right-click
// context menu for rename/pin/delete.

type AgentDragPreview = {
    x: number;
    y: number;
    title: string;
    runtimeId: string;
};

type EditingFolder = {
    folderId: string;
    name: string;
};

type FolderDropTarget = {
    folderId: string;
    position: "before" | "after";
};

type ChatSidebarDropTarget =
    | { kind: "folder"; folderId: string }
    | { kind: "unfiled" }
    | null;

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

function formatElapsed(startedAt: number | null, now: number) {
    if (startedAt === null) return "";
    const seconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h`;
}

function formatStatusLabel(
    status: AgentSidebarStatus,
    timestampLabel: string,
    workingStartedAt: number | null,
    now: number,
) {
    switch (status) {
        case "review":
            return "Review";
        case "approval":
            return "Approval";
        case "input":
            return "Input";
        case "working": {
            const elapsed = formatElapsed(workingStartedAt, now);
            return elapsed ? `Working ${elapsed}` : "Working";
        }
        case "failed":
            return "Failed";
        case "done":
            return "Done";
        case "ready":
            return timestampLabel;
    }
}

function isSubagentSession(session: AIChatSession) {
    return Boolean(session.parentSessionId?.trim());
}

function scaleMetric(base: number, scale: number, min: number) {
    return Math.max(min, Math.round(base * scale * 10) / 10);
}

function getChatSidebarDropTargetAtPoint(
    clientX: number,
    clientY: number,
): ChatSidebarDropTarget {
    if (
        typeof document === "undefined" ||
        typeof document.elementFromPoint !== "function"
    ) {
        return null;
    }
    const target = document.elementFromPoint(clientX, clientY);
    if (!(target instanceof Element)) return null;
    const folderId = target.closest<HTMLElement>("[data-chat-folder-id]")
        ?.dataset.chatFolderId;
    if (folderId) return { kind: "folder", folderId };
    return target.closest("[data-chat-unfiled-drop-zone]")
        ? { kind: "unfiled" }
        : null;
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
            rowPaddingY: scaleMetric(4, scale, 3),
            inlineGap: scaleMetric(6, scale, 5),
            titleFontSize: scaleMetric(11.5, scale, 10.5),
            timestampFontSize: scaleMetric(10, scale, 9),
            providerIconSize: scaleMetric(12, scale, 10),
            pinButtonSize: scaleMetric(16, scale, 14),
            pinIconSize: scaleMetric(11, scale, 10),
            cardMinHeight: scaleMetric(78, scale, 66),
            cardRadius: scaleMetric(9, scale, 7),
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
    const activeSessionId = useChatStore((state) => state.activeSessionId);
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

    const sessionMetadata = useAgentSidebarStore((state) => state.sessionMetadata);
    const pinnedEntries = useMemo(
        () =>
            Object.fromEntries(
                Object.entries(sessionMetadata).flatMap(([sessionId, metadata]) =>
                    metadata.pinnedAt === null
                        ? []
                        : [[sessionId, { pinnedAt: metadata.pinnedAt }]],
                ),
            ),
        [sessionMetadata],
    );
    const sessionFolderIds = useMemo(
        () =>
            Object.fromEntries(
                Object.entries(sessionMetadata).flatMap(([sessionId, metadata]) =>
                    metadata.folderId ? [[sessionId, metadata.folderId]] : [],
                ),
            ),
        [sessionMetadata],
    );
    const togglePinnedChat = useAgentSidebarStore((state) => state.togglePin);
    const unpinChat = useAgentSidebarStore((state) => state.unpinSession);
    const chatFolders = useAgentSidebarStore((state) => state.folders);
    const collapsedFolderIds = useAgentSidebarStore(
        (state) => state.collapsedFolderIds,
    );
    const collapsedParentSessionIds = useAgentSidebarStore(
        (state) => state.collapsedParentSessionIds,
    );
    const folderOrder = useAgentSidebarStore((state) => state.folderOrder);
    const pinnedOrder = useAgentSidebarStore((state) => state.pinnedOrder);
    const activeOrder = useAgentSidebarStore((state) => state.activeOrder);
    const createFolder = useAgentSidebarStore((state) => state.createFolder);
    const renameFolder = useAgentSidebarStore((state) => state.renameFolder);
    const deleteFolder = useAgentSidebarStore((state) => state.deleteFolder);
    const reorderFolder = useAgentSidebarStore((state) => state.reorderFolder);
    const moveSessionToFolder = useAgentSidebarStore(
        (state) => state.moveSessionToFolder,
    );
    const toggleFolderCollapsed = useAgentSidebarStore(
        (state) => state.toggleFolderCollapsed,
    );
    const toggleCollapsedParent = useAgentSidebarStore(
        (state) => state.toggleParentCollapsed,
    );
    const migrateLegacyMetadata = useAgentSidebarStore(
        (state) => state.migrateLegacyMetadata,
    );
    const reconcileSidebar = useAgentSidebarStore((state) => state.reconcile);
    const markSessionVisited = useAgentSidebarStore(
        (state) => state.markSessionVisited,
    );
    const completeSession = useAgentSidebarStore(
        (state) => state.completeSession,
    );
    const reopenSession = useAgentSidebarStore((state) => state.reopenSession);
    const completedShelfExpanded = useAgentSidebarStore(
        (state) => state.completedShelfExpanded,
    );
    const setCompletedShelfExpanded = useAgentSidebarStore(
        (state) => state.setCompletedShelfExpanded,
    );
    const snoozeSession = useAgentSidebarStore((state) => state.snoozeSession);
    const wakeSession = useAgentSidebarStore((state) => state.wakeSession);
    const snoozedShelfExpanded = useAgentSidebarStore(
        (state) => state.snoozedShelfExpanded,
    );
    const setSnoozedShelfExpanded = useAgentSidebarStore(
        (state) => state.setSnoozedShelfExpanded,
    );

    const focusedWorkspaceChatSessionId = useEditorStore(
        useShallow((state) => {
            const focused = selectFocusedEditorTab(state);
            return focused && isChatTab(focused) ? focused.sessionId : null;
        }),
    );

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
    const [now, setNow] = useState(() => Date.now());
    const orderedFolders = useMemo(() => {
        const unordered = Object.values(chatFolders).sort(
            (left, right) => left.createdAt - right.createdAt,
        );
        const byId = new Map(unordered.map((folder) => [folder.id, folder]));
        const ordered = folderOrder.flatMap((id) => {
            const folder = byId.get(id);
            if (!folder) return [];
            byId.delete(id);
            return [folder];
        });
        return [...ordered, ...unordered.filter((folder) => byId.has(folder.id))];
    }, [chatFolders, folderOrder]);
    const projection = useMemo(
        () =>
            buildAgentSidebarProjection({
                sessions,
                metadataBySessionId: sessionMetadata,
                folders: orderedFolders,
                pinnedOrder,
                activeOrder,
                filterText,
                focusedSessionId:
                    focusedWorkspaceChatSessionId ?? focusedTerminalAgentSessionId,
                now,
            }),
        [
            activeOrder,
            filterText,
            focusedTerminalAgentSessionId,
            focusedWorkspaceChatSessionId,
            now,
            orderedFolders,
            pinnedOrder,
            sessionMetadata,
            sessions,
        ],
    );
    const allProjectedGroups = useMemo(
        () => [
            ...projection.pinnedGroups,
            ...projection.activeFolders.flatMap((folder) => folder.groups),
            ...projection.unfiledActiveGroups,
            ...projection.snoozedGroups,
            ...projection.completedGroups,
            ...projection.searchResults,
        ],
        [projection],
    );
    const hasWorkingGroup = allProjectedGroups.some(
        (group) => group.status === "working",
    );
    useEffect(() => {
        if (!hasWorkingGroup) return;
        const delay = 1_000 - (Date.now() % 1_000) + 8;
        const timer = window.setTimeout(() => setNow(Date.now()), delay);
        return () => window.clearTimeout(timer);
    }, [hasWorkingGroup, now]);
    const nextSnoozeWake = useMemo(() => {
        const futureWakes = Object.values(sessionMetadata).flatMap((metadata) =>
            metadata.snoozedUntil !== null && metadata.snoozedUntil > now
                ? [metadata.snoozedUntil]
                : [],
        );
        return futureWakes.length > 0 ? Math.min(...futureWakes) : null;
    }, [now, sessionMetadata]);
    useEffect(() => {
        if (nextSnoozeWake === null) return;
        const timer = window.setTimeout(
            () => setNow(Date.now()),
            getSafeSnoozeDelay(Date.now(), nextSnoozeWake),
        );
        return () => window.clearTimeout(timer);
    }, [nextSnoozeWake]);
    useEffect(() => {
        const refreshClock = () => setNow(Date.now());
        const handleVisibility = () => {
            if (document.visibilityState === "visible") refreshClock();
        };
        window.addEventListener("focus", refreshClock);
        document.addEventListener("visibilitychange", handleVisibility);
        return () => {
            window.removeEventListener("focus", refreshClock);
            document.removeEventListener("visibilitychange", handleVisibility);
        };
    }, []);

    useEffect(() => {
        if (!sessionInventoryLoaded) return;
        migrateLegacyMetadata(projection.rootSessionIds);
        reconcileSidebar(projection.rootSessionIds);
    }, [
        migrateLegacyMetadata,
        projection.rootSessionIds,
        reconcileSidebar,
        sessionInventoryLoaded,
    ]);
    const pinnedGroups = projection.pinnedGroups;
    const folderGroups = useMemo(
        () =>
            new Map(
                projection.activeFolders.map(({ folder, groups }) => [
                    folder.id,
                    groups,
                ]),
            ),
        [projection.activeFolders],
    );
    const unfiledGroups = hasFilter
        ? projection.searchResults
        : projection.unfiledActiveGroups;

    const totalCount = sessions.length;
    const filteredCount = (hasFilter
        ? projection.searchResults
        : allProjectedGroups
    ).reduce(
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

            unpinChat(session.sessionId);
            await deleteSession(session.sessionId);
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
    const [folderMenu, setFolderMenu] = useState<
        ContextMenuState<ChatFolder> | null
    >(null);
    const [editingFolder, setEditingFolder] = useState<EditingFolder | null>(
        null,
    );
    const [dragPreview, setDragPreview] = useState<AgentDragPreview | null>(
        null,
    );
    const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(
        null,
    );
    const [isDraggingOverUnfiled, setIsDraggingOverUnfiled] = useState(false);
    const folderDragRef = useRef<{
        pointerId: number;
        folderId: string;
        startX: number;
        startY: number;
        active: boolean;
        folderIds: string[];
    } | null>(null);
    const folderDragCleanupRef = useRef<(() => void) | null>(null);
    const suppressFolderClickRef = useRef(false);
    const [draggedFolderId, setDraggedFolderId] = useState<string | null>(null);
    const [folderDropTarget, setFolderDropTarget] =
        useState<FolderDropTarget | null>(null);

    useEffect(
        () => () => {
            folderDragCleanupRef.current?.();
            folderDragCleanupRef.current = null;
        },
        [],
    );

    const clearFolderDrag = useCallback(() => {
        folderDragRef.current = null;
        folderDragCleanupRef.current?.();
        folderDragCleanupRef.current = null;
        setDraggedFolderId(null);
        setFolderDropTarget(null);
    }, []);

    const handleFolderPointerDown = useCallback(
        (event: ReactPointerEvent<HTMLElement>, folderId: string) => {
            if (event.button !== 0 || editingFolder?.folderId === folderId) return;

            const target = event.target;
            if (target instanceof Element && target.closest("input,button")) return;

            folderDragCleanupRef.current?.();
            const state = {
                pointerId: event.pointerId,
                folderId,
                startX: event.clientX,
                startY: event.clientY,
                active: false,
                folderIds: orderedFolders.map((folder) => folder.id),
            };
            folderDragRef.current = state;

            const updateTarget = (moveEvent: PointerEvent) => {
                const current = folderDragRef.current;
                if (!current || current.pointerId !== moveEvent.pointerId) return;
                if (!current.active) {
                    if (
                        Math.hypot(
                            moveEvent.clientX - current.startX,
                            moveEvent.clientY - current.startY,
                        ) < 5
                    ) {
                        return;
                    }
                    current.active = true;
                    setDraggedFolderId(current.folderId);
                }
                moveEvent.preventDefault();
                const element = document.elementFromPoint(
                    moveEvent.clientX,
                    moveEvent.clientY,
                );
                const header = element?.closest<HTMLElement>(
                    "[data-chat-folder-header]",
                );
                const targetFolderId = header?.dataset.chatFolderHeader;
                if (!targetFolderId || targetFolderId === current.folderId) {
                    setFolderDropTarget(null);
                    return;
                }
                const rect = header.getBoundingClientRect();
                setFolderDropTarget({
                    folderId: targetFolderId,
                    position:
                        moveEvent.clientY < rect.top + rect.height / 2
                            ? "before"
                            : "after",
                });
            };
            const finish = (upEvent: PointerEvent, cancelled = false) => {
                const current = folderDragRef.current;
                if (!current || current.pointerId !== upEvent.pointerId) return;
                // Calculate from the final pointer position instead of React
                // state, which can be stale inside this window listener.
                const element = document.elementFromPoint(
                    upEvent.clientX,
                    upEvent.clientY,
                );
                const header = element?.closest<HTMLElement>(
                    "[data-chat-folder-header]",
                );
                const targetFolderId = header?.dataset.chatFolderHeader;
                const rect = header?.getBoundingClientRect();
                const finalTarget =
                    targetFolderId && targetFolderId !== current.folderId && rect
                        ? {
                              folderId: targetFolderId,
                              position:
                                  upEvent.clientY < rect.top + rect.height / 2
                                      ? ("before" as const)
                                      : ("after" as const),
                          }
                        : null;
                const wasActive = current.active;
                clearFolderDrag();
                if (!wasActive || cancelled || !finalTarget) return;

                const remainingIds = current.folderIds.filter(
                    (id) => id !== current.folderId,
                );
                const targetIndex = remainingIds.indexOf(finalTarget.folderId);
                if (targetIndex < 0) return;
                reorderFolder(
                    current.folderId,
                    targetIndex + (finalTarget.position === "after" ? 1 : 0),
                );
                suppressFolderClickRef.current = true;
                window.requestAnimationFrame(() => {
                    suppressFolderClickRef.current = false;
                });
            };
            const onMove = (moveEvent: PointerEvent) => updateTarget(moveEvent);
            const onUp = (upEvent: PointerEvent) => finish(upEvent);
            const onCancel = (cancelEvent: PointerEvent) => finish(cancelEvent, true);
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", onUp);
            window.addEventListener("pointercancel", onCancel);
            folderDragCleanupRef.current = () => {
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", onUp);
                window.removeEventListener("pointercancel", onCancel);
            };
        },
        [clearFolderDrag, editingFolder?.folderId, orderedFolders, reorderFolder],
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

    const handleCreateFolder = useCallback(() => {
        const folderId = createFolder("New Folder");
        if (folderId) {
            setEditingFolder({
                folderId,
                name: "New Folder",
            });
        }
    }, [createFolder]);

    const commitFolderRename = useCallback(() => {
        if (!editingFolder) return;
        const name = editingFolder.name.trim();
        if (name) renameFolder(editingFolder.folderId, name);
        setEditingFolder(null);
    }, [editingFolder, renameFolder]);

    const startFolderRename = useCallback((folder: ChatFolder) => {
        setEditingFolder({
            folderId: folder.id,
            name: folder.name,
        });
    }, []);

    const handleFolderContextMenu = useCallback(
        (event: ReactMouseEvent<HTMLElement>, folder: ChatFolder) => {
            event.preventDefault();
            event.stopPropagation();
            setContextMenu(null);
            setNewChatMenu(null);
            setFolderMenu({
                x: event.clientX,
                y: event.clientY,
                payload: folder,
            });
        },
        [],
    );

    const activeSidebarId =
        focusedWorkspaceChatSessionId ??
        (focusedTerminalAgentSessionId &&
        sessionsById[focusedTerminalAgentSessionId]
            ? focusedTerminalAgentSessionId
            : null) ??
        activeSessionId;
    const visitedProjectionKeyRef = useRef<string | null>(null);
    useEffect(() => {
        if (!activeSidebarId) return;
        const visibleGroup = allProjectedGroups.find((group) =>
            group.sessionIds.includes(activeSidebarId),
        );
        if (!visibleGroup) return;
        const visitKey = `${visibleGroup.root.sessionId}:${visibleGroup.lastCompletedAt ?? 0}`;
        if (visitedProjectionKeyRef.current === visitKey) return;
        visitedProjectionKeyRef.current = visitKey;
        markSessionVisited(visibleGroup.root.sessionId, Date.now());
    }, [activeSidebarId, allProjectedGroups, markSessionVisited]);
    const metrics = useMemo(
        () => buildAgentsSidebarMetrics(agentsSidebarScale),
        [agentsSidebarScale],
    );
    const collapsedParentIds = useMemo(
        () => new Set(collapsedParentSessionIds),
        [collapsedParentSessionIds],
    );

    const renderItem = (
        session: AIChatSession,
        options?: {
            depth?: number;
            childCount?: number;
            isCollapsed?: boolean;
            canPin?: boolean;
            canRename?: boolean;
            status?: AgentSidebarStatus;
            workingStartedAt?: number | null;
            variant?: "card" | "slim";
            quickActionLabel?: string;
            onQuickAction?: () => void;
            secondaryActionLabel?: string;
            onSecondaryAction?: () => void;
            statusLabelOverride?: string;
            onToggleCollapse?: () => void;
        },
    ) => {
        const isSubagent = isSubagentSession(session);
        const canPin = options?.canPin ?? !isSubagent;
        const canRename = options?.canRename ?? !isSubagent;
        const isPinned = Boolean(pinnedEntries[session.sessionId]);
        const status =
            options?.status ??
            resolveAgentSidebarSessionStatus(
                session,
                sessionMetadata[session.sessionId],
            );
        const updatedAt = getSessionUpdatedAt(session);
        const timestampLabel = formatAgentTimestamp(updatedAt);
        const statusLabel =
            options?.statusLabelOverride ??
            formatStatusLabel(
                status,
                timestampLabel,
                options?.workingStartedAt ?? null,
                now,
            );
        const dragTitle = getSessionTitleText(session);
        const updateDragPreview = (clientX: number, clientY: number) => {
            setDragPreview({
                x: clientX,
                y: clientY,
                title: dragTitle,
                runtimeId: session.runtimeId,
            });
        };
        const updateFolderDropTarget = (clientX: number, clientY: number) => {
            const target = canPin
                ? getChatSidebarDropTargetAtPoint(clientX, clientY)
                : null;
            setDragOverFolderId(
                target?.kind === "folder" ? target.folderId : null,
            );
            setIsDraggingOverUnfiled(target?.kind === "unfiled");
        };

        return (
            <AgentsSidebarItem
                key={session.sessionId}
                session={session}
                title={getSessionTitle(session)}
                timestampLabel={timestampLabel}
                status={status}
                statusLabel={statusLabel}
                variant={options?.variant ?? "card"}
                isActive={activeSidebarId === session.sessionId}
                isPinned={canPin && isPinned}
                canPin={canPin}
                canRename={canRename}
                depth={options?.depth ?? 0}
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
                quickActionLabel={options?.quickActionLabel}
                onQuickAction={options?.onQuickAction}
                secondaryActionLabel={options?.secondaryActionLabel}
                onSecondaryAction={options?.onSecondaryAction}
                onContextMenu={(event) => handleContextMenu(event, session)}
                onDragStart={({ clientX, clientY }) => {
                    updateDragPreview(clientX, clientY);
                    updateFolderDropTarget(clientX, clientY);
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
                    updateFolderDropTarget(clientX, clientY);
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
                    const target = canPin
                        ? getChatSidebarDropTargetAtPoint(clientX, clientY)
                        : null;
                    const movedWithinSidebar = target !== null;
                    if (target?.kind === "folder") {
                        moveSessionToFolder(session.sessionId, target.folderId);
                    } else if (target?.kind === "unfiled") {
                        moveSessionToFolder(session.sessionId, null);
                    }
                    setDragOverFolderId(null);
                    setIsDraggingOverUnfiled(false);
                    emitAgentSidebarDrag({
                        // Sidebar drops belong to the sidebar; prevent the
                        // workspace pane drop handler from acting as well.
                        phase: movedWithinSidebar ? "cancel" : "end",
                        x: clientX,
                        y: clientY,
                        sessionId: session.sessionId,
                        title: dragTitle,
                    });
                }}
                onDragCancel={() => {
                    setDragPreview(null);
                    setDragOverFolderId(null);
                    setIsDraggingOverUnfiled(false);
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

    const renderGroup = (
        group: AgentSidebarGroup,
        requestedLifecycle: "active" | "snoozed" | "completed" = "active",
    ) => {
        const rootMetadata = sessionMetadata[group.root.sessionId];
        const lifecycle =
            requestedLifecycle === "active" && hasFilter && rootMetadata
                ? rootMetadata.snoozedUntil !== null &&
                  rootMetadata.snoozedUntil > now &&
                  !agentSidebarStatusNeedsAttention(group.status)
                    ? "snoozed"
                    : isEffectivelyCompleted(group, rootMetadata)
                      ? "completed"
                      : "active"
                : requestedLifecycle;
        const collapsed = collapsedParentIds.has(group.root.sessionId);
        const forceChildrenVisible =
            hasFilter ||
            group.visibleChildren.some(
                (child) =>
                    child.sessionId === activeSidebarId ||
                    resolveAgentSidebarSessionStatus(
                        child,
                        sessionMetadata[group.root.sessionId],
                    ) !== "ready",
            );
        const showChildren =
            group.visibleChildren.length > 0 &&
            (!collapsed || forceChildrenVisible);

        return (
            <div key={group.root.sessionId} className="flex flex-col">
                {renderItem(group.root, {
                    childCount: group.children.length,
                    isCollapsed: collapsed && !forceChildrenVisible,
                    status: group.status,
                    workingStartedAt: group.workingStartedAt,
                    variant: lifecycle === "active" ? "card" : "slim",
                    quickActionLabel:
                        lifecycle === "completed"
                            ? "Reopen"
                            : lifecycle === "snoozed"
                              ? "Wake now"
                            : !isClaudeTerminalAgentSession(group.root) &&
                                canCompleteAgentSidebarStatus(group.status)
                              ? "Complete"
                              : undefined,
                    onQuickAction:
                        lifecycle === "completed"
                            ? () => reopenSession(group.root.sessionId)
                            : lifecycle === "snoozed"
                              ? () => wakeSession(group.root.sessionId)
                            : !isClaudeTerminalAgentSession(group.root) &&
                                canCompleteAgentSidebarStatus(group.status)
                              ? () => completeSession(group.root.sessionId)
                              : undefined,
                    secondaryActionLabel:
                        lifecycle === "active" &&
                        !isClaudeTerminalAgentSession(group.root) &&
                        !agentSidebarStatusNeedsAttention(group.status)
                            ? "Snooze"
                            : undefined,
                    onSecondaryAction:
                        lifecycle === "active" &&
                        !isClaudeTerminalAgentSession(group.root) &&
                        !agentSidebarStatusNeedsAttention(group.status)
                            ? () =>
                                  snoozeSession(
                                      group.root.sessionId,
                                      resolveAgentSnoozeTimestamp(
                                          "one-hour",
                                          Date.now(),
                                      ),
                                  )
                            : undefined,
                    statusLabelOverride:
                        lifecycle === "snoozed" && rootMetadata?.snoozedUntil
                            ? formatSnoozeWakeLabel(
                                  rootMetadata.snoozedUntil,
                                  now,
                              )
                            : undefined,
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
                              variant: "slim",
                          }),
                      )
                    : null}
            </div>
        );
    };

    const renderFolder = (folder: ChatFolder) => {
        const groups = folderGroups.get(folder.id) ?? [];
        const collapsed = collapsedFolderIds.includes(folder.id);
        const isRenaming = editingFolder?.folderId === folder.id;
        return (
            <section
                key={folder.id}
                data-chat-folder-id={folder.id}
                className="mt-1 flex flex-col rounded"
                style={{
                    backgroundColor:
                        dragOverFolderId === folder.id
                            ? "color-mix(in srgb, var(--accent) 10%, transparent)"
                            : "transparent",
                    outline:
                        dragOverFolderId === folder.id
                            ? "1px solid color-mix(in srgb, var(--accent) 55%, transparent)"
                            : "1px solid transparent",
                    borderTop:
                        folderDropTarget?.folderId === folder.id &&
                        folderDropTarget.position === "before"
                            ? "2px solid var(--accent)"
                            : "2px solid transparent",
                    borderBottom:
                        folderDropTarget?.folderId === folder.id &&
                        folderDropTarget.position === "after"
                            ? "2px solid var(--accent)"
                            : "2px solid transparent",
                    opacity: draggedFolderId === folder.id ? 0.55 : 1,
                }}
            >
                <div
                    data-chat-folder-header={folder.id}
                    role="button"
                    tabIndex={0}
                    className="flex items-center gap-1.5 px-2 text-left text-[10px] font-semibold uppercase tracking-[0.09em]"
                    style={{
                        color: "var(--text-secondary)",
                        opacity: 0.8,
                        fontSize: metrics.header.fontSize,
                        padding: `${scaleMetric(4, agentsSidebarScale / 100, 3)}px ${metrics.header.paddingX}px ${scaleMetric(3, agentsSidebarScale / 100, 2)}px`,
                    }}
                    title={collapsed ? "Expand folder" : "Collapse folder"}
                    onClick={() => {
                        if (suppressFolderClickRef.current) return;
                        toggleFolderCollapsed(folder.id);
                    }}
                    onPointerDown={(event) =>
                        handleFolderPointerDown(event, folder.id)
                    }
                    onContextMenu={(event) =>
                        handleFolderContextMenu(event, folder)
                    }
                    onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            toggleFolderCollapsed(folder.id);
                        }
                    }}
                >
                    <svg
                        width="9"
                        height="9"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        style={{
                            transform: collapsed
                                ? "rotate(-90deg)"
                                : "rotate(0)",
                            transition: "transform 120ms ease",
                        }}
                    >
                        <path d="m4 6 4 4 4-4" />
                    </svg>
                    <svg
                        data-chat-folder-icon
                        aria-hidden="true"
                        width="12"
                        height="12"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="shrink-0"
                    >
                        <path d="M1.75 4.25a1.5 1.5 0 0 1 1.5-1.5h3l1.4 1.75h5.1a1.5 1.5 0 0 1 1.5 1.5v5.25a1.5 1.5 0 0 1-1.5 1.5h-9.5a1.5 1.5 0 0 1-1.5-1.5Z" />
                    </svg>
                    {isRenaming ? (
                        <input
                            autoFocus
                            aria-label="Folder name"
                            className="min-w-0 flex-1 rounded px-1 py-0.5 text-[10px] font-semibold normal-case tracking-normal outline-none"
                            style={{
                                color: "var(--text-primary)",
                                backgroundColor: "var(--bg-primary)",
                                border: "1px solid var(--accent)",
                            }}
                            value={editingFolder.name}
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) =>
                                setEditingFolder((current) =>
                                    current
                                        ? {
                                              ...current,
                                              name: event.target.value,
                                          }
                                        : current,
                                )
                            }
                            onBlur={commitFolderRename}
                            onKeyDown={(event) => {
                                event.stopPropagation();
                                if (event.key === "Enter") {
                                    event.preventDefault();
                                    commitFolderRename();
                                } else if (event.key === "Escape") {
                                    event.preventDefault();
                                    setEditingFolder(null);
                                }
                            }}
                        />
                    ) : (
                        <span className="truncate">{folder.name}</span>
                    )}
                    <span style={{ opacity: 0.7 }}>{groups.length}</span>
                </div>
                {!collapsed ? (
                    <div
                        data-chat-folder-contents={folder.id}
                        className="flex min-w-0 flex-col gap-0.5"
                        style={{
                            marginLeft: scaleMetric(
                                8,
                                agentsSidebarScale / 100,
                                7,
                            ),
                        }}
                    >
                        {groups.length > 0 ? (
                            groups.map((group) => renderGroup(group))
                        ) : (
                            <p
                                className="px-3 py-1 text-[10.5px]"
                                style={{ color: "var(--text-secondary)" }}
                            >
                                Drop chats here from their menu.
                            </p>
                        )}
                    </div>
                ) : null}
            </section>
        );
    };

    const contextGroup = contextMenu
        ? allProjectedGroups.find((group) =>
              group.sessionIds.includes(contextMenu.payload.sessionId),
          )
        : null;
    const contextMetadata = contextGroup
        ? sessionMetadata[contextGroup.root.sessionId]
        : null;
    const contextIsCompleted = Boolean(
        contextGroup &&
            contextMetadata &&
            isEffectivelyCompleted(contextGroup, contextMetadata),
    );
    const contextIsSnoozed = Boolean(
        contextGroup &&
            contextMetadata?.snoozedUntil &&
            contextMetadata.snoozedUntil > now &&
            !agentSidebarStatusNeedsAttention(contextGroup.status),
    );

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
                        onClick={handleCreateFolder}
                        title="New folder"
                        aria-label="New folder"
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
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <path d="M2.5 4.5h4l1.2 1.5h5.8v6.5h-11Z" />
                            <path d="M8 8v4M6 10h4" />
                        </svg>
                    </button>
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
                    hasFilter ? (
                        <AgentsSidebarSection
                            title="Results"
                            count={unfiledGroups.length}
                            headerMetrics={metrics.header}
                        >
                            {unfiledGroups.map((group) => renderGroup(group))}
                        </AgentsSidebarSection>
                    ) : (
                        <>
                            <AgentsSidebarSection
                                title="Pinned"
                                count={pinnedGroups.length}
                                headerMetrics={metrics.header}
                            >
                                {pinnedGroups.map((group) => renderGroup(group))}
                            </AgentsSidebarSection>
                            {pinnedGroups.length > 0 ? (
                                <div
                                    className="mx-2 mt-2 h-px"
                                    style={{ background: "var(--border)" }}
                                />
                            ) : null}
                            {orderedFolders.map(renderFolder)}
                            <AgentsSidebarSection
                                title="Active"
                                count={unfiledGroups.length}
                                showHeader={orderedFolders.length > 0}
                                showWhenEmpty={orderedFolders.length > 0}
                                dropTarget="all"
                                isDropTarget={isDraggingOverUnfiled}
                                headerMetrics={metrics.header}
                            >
                                {unfiledGroups.map((group) => renderGroup(group))}
                            </AgentsSidebarSection>
                            <AgentsSidebarShelf
                                title="Snoozed"
                                groups={projection.snoozedGroups}
                                expanded={snoozedShelfExpanded}
                                onExpandedChange={setSnoozedShelfExpanded}
                                focusedSessionId={activeSidebarId}
                                renderGroup={(group) =>
                                    renderGroup(group, "snoozed")
                                }
                            />
                            <AgentsSidebarShelf
                                title="Completed"
                                groups={projection.completedGroups}
                                expanded={completedShelfExpanded}
                                onExpandedChange={setCompletedShelfExpanded}
                                focusedSessionId={activeSidebarId}
                                initialLimit={5}
                                renderGroup={(group) =>
                                    renderGroup(group, "completed")
                                }
                            />
                        </>
                    )
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
                            disabled: isSubagentSession(contextMenu.payload),
                            action: () =>
                                togglePinnedChat(contextMenu.payload.sessionId),
                        },
                        ...(!contextGroup ||
                        isSubagentSession(contextMenu.payload) ||
                        isClaudeTerminalAgentSession(contextMenu.payload)
                            ? []
                            : contextIsCompleted
                              ? [
                                    {
                                        label: "Reopen",
                                        action: () =>
                                            reopenSession(
                                                contextGroup.root.sessionId,
                                            ),
                                    },
                                ]
                              : [
                                    {
                                        label: "Complete",
                                        disabled:
                                            !canCompleteAgentSidebarStatus(
                                                contextGroup.status,
                                            ),
                                        action: () =>
                                            completeSession(
                                                contextGroup.root.sessionId,
                                            ),
                                    },
                                ]),
                        ...(!contextGroup ||
                        contextIsCompleted ||
                        isSubagentSession(contextMenu.payload) ||
                        isClaudeTerminalAgentSession(contextMenu.payload)
                            ? []
                            : contextIsSnoozed
                              ? [
                                    {
                                        label: "Wake now",
                                        action: () =>
                                            wakeSession(
                                                contextGroup.root.sessionId,
                                            ),
                                    },
                                ]
                              : agentSidebarStatusNeedsAttention(
                                      contextGroup.status,
                                  )
                                ? []
                                : [
                                      {
                                          label: "Snooze",
                                          children: AGENT_SNOOZE_PRESETS.map(
                                              (preset) => ({
                                                  label: preset.label,
                                                  action: () =>
                                                      snoozeSession(
                                                          contextGroup.root
                                                              .sessionId,
                                                          resolveAgentSnoozeTimestamp(
                                                              preset.id,
                                                              Date.now(),
                                                          ),
                                                      ),
                                              }),
                                          ),
                                      },
                                  ]),
                        {
                            label: "Rename",
                            disabled: isSubagentSession(contextMenu.payload),
                            action: () =>
                                handleStartRename(contextMenu.payload),
                        },
                        {
                            label: "Move to Folder",
                            disabled: isSubagentSession(contextMenu.payload),
                            children: [
                                {
                                    label: "New Folder…",
                                    action: () => {
                                        const folderId = createFolder("New Folder");
                                        if (!folderId) return;
                                        moveSessionToFolder(
                                            contextMenu.payload.sessionId,
                                            folderId,
                                        );
                                        setEditingFolder({
                                            folderId,
                                            name: "New Folder",
                                        });
                                    },
                                },
                                { type: "separator" },
                                {
                                    label: "No Folder",
                                    disabled: !sessionFolderIds[
                                        contextMenu.payload.sessionId
                                    ],
                                    action: () =>
                                        moveSessionToFolder(
                                            contextMenu.payload.sessionId,
                                            null,
                                        ),
                                },
                                ...orderedFolders.map((folder) => ({
                                    label: folder.name,
                                    disabled:
                                        sessionFolderIds[
                                            contextMenu.payload.sessionId
                                        ] === folder.id,
                                    action: () =>
                                        moveSessionToFolder(
                                            contextMenu.payload.sessionId,
                                            folder.id,
                                        ),
                                })),
                            ],
                        },
                        ...(isClaudeTerminalAgentSession(contextMenu.payload)
                            ? []
                            : [
                                  {
                                      label: "Open in New Tab",
                                      action: () => {
                                          void openChatSessionInWorkspace(
                                              contextMenu.payload.sessionId,
                                              { forceNewTab: true },
                                          );
                                      },
                                  },
                              ]),
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
            {folderMenu && (
                <ContextMenu
                    menu={folderMenu}
                    onClose={() => setFolderMenu(null)}
                    entries={[
                        {
                            label: "Rename Folder",
                            action: () => startFolderRename(folderMenu.payload),
                        },
                        { type: "separator" },
                        {
                            label: "Delete Folder",
                            danger: true,
                            action: () =>
                                deleteFolder(folderMenu.payload.id),
                        },
                    ]}
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
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--bg-secondary)",
                color: "var(--text-primary)",
                boxShadow: "0 8px 18px rgba(0,0,0,0.18)",
                padding: "5px 8px",
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
