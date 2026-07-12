import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
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
    isChatTab,
    isTerminalTab,
    selectEditorWorkspaceTabs,
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
    createNewChatInWorkspace,
    openChatHistoryInWorkspace,
    openChatSessionInWorkspace,
} from "./chatPaneMovement";
import { openClaudeCodeTerminalWithContext } from "../terminal/claudeCodeTerminal";
import { emitAgentSidebarDrag } from "./agentSidebarDragEvents";
import {
    getSessionTitle,
    getSessionTitleText,
    getSessionUpdatedAt,
} from "./sessionPresentation";
import {
    buildAiSessionHierarchyGroups,
    compareHierarchyGroupsByUpdatedAtDesc,
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
import { usePinnedChatsStore } from "./store/pinnedChatsStore";
import {
    useChatFoldersStore,
    type ChatFolder,
} from "./store/chatFoldersStore";
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

// Comando-style Agents panel living inside the left sidebar. Replaces the
// previous right-panel AIChatPanel for the session list (the actual
// conversations still open as center editor tabs). Groups sessions into
// Pinned / Open / All, supports inline rename, pin toggle and a right-click
// context menu for rename/pin/delete.

const AGENTS_SIDEBAR_COLLAPSED_PARENTS_KEY =
    "neverwrite.ai.agentsSidebar.collapsedParents";

type ActivitySession = Pick<AIChatSession, "status">;

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

type ChatSidebarDropTarget =
    | { kind: "folder"; folderId: string }
    | { kind: "unfiled" }
    | null;

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

function getRuntimeMenuLabel(name: string) {
    return name.trim().replace(/ ACP$/, "");
}

function isSessionWorking(session: AIChatSession) {
    return deriveActivityIndicator(session)?.tone === "working";
}

function compareOpenHierarchyGroups(
    a: AiSessionHierarchyGroup,
    b: AiSessionHierarchyGroup,
    workingOrder: ReadonlyMap<string, number>,
) {
    const aOrder = getGroupWorkingOrder(a, workingOrder);
    const bOrder = getGroupWorkingOrder(b, workingOrder);
    const aWorking = aOrder !== undefined;
    const bWorking = bOrder !== undefined;

    if (aWorking && bWorking) {
        return aOrder - bOrder;
    }
    if (aWorking !== bWorking) {
        return aWorking ? -1 : 1;
    }
    return compareHierarchyGroupsByUpdatedAtDesc(a, b);
}

function compareSidebarHierarchySiblings(
    left: AIChatSession,
    right: AIChatSession,
    workingOrder: ReadonlyMap<string, number>,
) {
    const leftOrder = workingOrder.get(left.sessionId);
    const rightOrder = workingOrder.get(right.sessionId);
    const leftWorking = leftOrder !== undefined;
    const rightWorking = rightOrder !== undefined;

    if (leftWorking && rightWorking) {
        return leftOrder - rightOrder;
    }
    if (leftWorking !== rightWorking) {
        return leftWorking ? -1 : 1;
    }

    return 0;
}

function getGroupWorkingOrder(
    group: AiSessionHierarchyGroup,
    workingOrder: ReadonlyMap<string, number>,
) {
    let earliest: number | undefined;
    for (const sessionId of group.sessionIds) {
        const order = workingOrder.get(sessionId);
        if (order === undefined) continue;
        earliest = earliest === undefined ? order : Math.min(earliest, order);
    }
    return earliest;
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
    const chatFolders = useChatFoldersStore((state) => state.folders);
    const sessionFolderIds = useChatFoldersStore(
        (state) => state.sessionFolderIds,
    );
    const collapsedFolderIds = useChatFoldersStore(
        (state) => state.collapsedFolderIds,
    );
    const createFolder = useChatFoldersStore((state) => state.createFolder);
    const renameFolder = useChatFoldersStore((state) => state.renameFolder);
    const deleteFolder = useChatFoldersStore((state) => state.deleteFolder);
    const moveSessionToFolder = useChatFoldersStore(
        (state) => state.moveSession,
    );
    const toggleFolderCollapsed = useChatFoldersStore(
        (state) => state.toggleFolderCollapsed,
    );
    const reconcileFolders = useChatFoldersStore((state) => state.reconcile);

    // Sessions currently open as editor tabs across any pane. Drives the
    // "Open" section — mirrors Comando's behaviour of bubbling live tabs to
    // the top of the list.
    const openSessionIds = useEditorStore(
        useShallow((state) => {
            const ids = new Set<string>();
            for (const tab of selectEditorWorkspaceTabs(state)) {
                if (isChatTab(tab)) {
                    ids.add(tab.sessionId);
                } else if (isTerminalTab(tab)) {
                    // A Claude Code terminal tab being open means its agent
                    // entry belongs in the "Open" section.
                    ids.add(claudeTerminalAgentSessionId(tab.terminalId));
                }
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

    // Raw chronological list (persisted order already reflects updatedAt).
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

    const pinnedRootIds = useMemo(
        () => new Set(Object.keys(pinnedEntries)),
        [pinnedEntries],
    );
    const hierarchy = useMemo(
        () =>
            buildAiSessionHierarchyGroups({
                sessions,
                normalizedFilter,
                openSessionIds,
                pinnedSessionIds: pinnedRootIds,
                compareSiblings: (left, right) =>
                    compareSidebarHierarchySiblings(
                        left,
                        right,
                        workingOrderRef.current,
                    ),
            }),
        // workingOrderRevision keeps this memo in sync with the ref-backed map.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [
            normalizedFilter,
            openSessionIds,
            pinnedRootIds,
            sessions,
            workingOrderRevision,
        ],
    );

    // Pins are root-owned: legacy child pins are pruned so subagents stay under
    // their parent instead of jumping into a separate Pinned bucket.
    useEffect(() => {
        reconcilePinned(hierarchy.rootSessionIds);
    }, [hierarchy.rootSessionIds, reconcilePinned]);
    useEffect(() => {
        reconcileFolders(hierarchy.rootSessionIds);
    }, [hierarchy.rootSessionIds, reconcileFolders]);

    // Shortcut sections are mutually exclusive with each other. They are not
    // a partition of folder navigation: a foldered chat may intentionally
    // also appear in Pinned or Open for quick access.
    const { pinnedGroups, openGroups, otherGroups } = useMemo(() => {
        const pinned: AiSessionHierarchyGroup[] = [];
        const open: AiSessionHierarchyGroup[] = [];
        const other: AiSessionHierarchyGroup[] = [];
        for (const group of hierarchy.groups) {
            if (group.isPinnedRoot) {
                pinned.push(group);
            } else if (group.hasOpenSession) {
                open.push(group);
            } else {
                other.push(group);
            }
        }
        pinned.sort((a, b) => {
            const aPinned = pinnedEntries[a.root.sessionId]?.pinnedAt ?? 0;
            const bPinned = pinnedEntries[b.root.sessionId]?.pinnedAt ?? 0;
            if (bPinned !== aPinned) return bPinned - aPinned;
            return compareHierarchyGroupsByUpdatedAtDesc(a, b);
        });
        open.sort((a, b) =>
            compareOpenHierarchyGroups(a, b, workingOrderRef.current),
        );
        other.sort(compareHierarchyGroupsByUpdatedAtDesc);
        return {
            pinnedGroups: pinned,
            openGroups: open,
            otherGroups: other,
        };
        // workingOrderRevision keeps this memo in sync with the ref-backed map.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [hierarchy.groups, pinnedEntries, workingOrderRevision]);
    const orderedFolders = useMemo(
        () =>
            Object.values(chatFolders).sort(
                (left, right) => left.createdAt - right.createdAt,
            ),
        [chatFolders],
    );
    // Folders are the chat's organizational home. Keep every group eligible
    // here (including pinned/open groups) so the folder projection remains
    // visible alongside those status-based shortcuts. All is the only section
    // limited to unfiled groups, avoiding a redundant third copy.
    const folderGroups = useMemo(() => {
        const groups = new Map<string, AiSessionHierarchyGroup[]>();
        for (const folder of orderedFolders) groups.set(folder.id, []);
        for (const group of hierarchy.groups) {
            const folderId = sessionFolderIds[group.root.sessionId];
            if (folderId && groups.has(folderId)) {
                groups.get(folderId)?.push(group);
            }
        }
        return groups;
    }, [hierarchy.groups, orderedFolders, sessionFolderIds]);
    const unfiledGroups = useMemo(
        () =>
            otherGroups.filter(
                (group) => !sessionFolderIds[group.root.sessionId],
            ),
        [otherGroups, sessionFolderIds],
    );

    const totalCount = sessions.length;
    const filteredCount = hierarchy.groups.reduce(
        (count, group) => count + 1 + group.visibleChildren.length,
        0,
    );
    // Only decorate Open/All headers when there is more than one non-pinned
    // section or when Pinned is already showing — otherwise a single "Open"
    // header above a lonely list reads as noise.
    const showOpenAllHeaders =
        pinnedGroups.length > 0 ||
        (openGroups.length > 0 && otherGroups.length > 0);

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
                useChatStore.getState().setSelectedRuntime(runtime.runtime.id);
                if (runtime.runtime.id === CLAUDE_TERMINAL_RUNTIME_ID) {
                    void openClaudeCodeTerminalWithContext();
                    return;
                }
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
        const timestampLabel = formatAgentTimestamp(updatedAt);
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
                isActive={activeSidebarId === session.sessionId}
                isPinned={canPin && isPinned}
                canPin={canPin}
                canRename={canRename}
                depth={options?.depth ?? 0}
                indicator={indicator}
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

    const renderFolder = (folder: ChatFolder) => {
        const groups = folderGroups.get(folder.id) ?? [];
        const collapsed = collapsedFolderIds.includes(folder.id);
        const isRenaming = editingFolder?.folderId === folder.id;
        return (
            <section
                key={folder.id}
                data-chat-folder-id={folder.id}
                className="mt-3 flex flex-col rounded"
                style={{
                    backgroundColor:
                        dragOverFolderId === folder.id
                            ? "color-mix(in srgb, var(--accent) 10%, transparent)"
                            : "transparent",
                    outline:
                        dragOverFolderId === folder.id
                            ? "1px solid color-mix(in srgb, var(--accent) 55%, transparent)"
                            : "1px solid transparent",
                }}
            >
                <div
                    role="button"
                    tabIndex={0}
                    className="flex items-center gap-1.5 px-2 text-left text-[10px] font-semibold uppercase tracking-[0.09em]"
                    style={{
                        color: "var(--text-secondary)",
                        opacity: 0.8,
                        fontSize: metrics.header.fontSize,
                        padding: `${metrics.header.paddingTop}px ${metrics.header.paddingX}px ${metrics.header.paddingBottom}px`,
                    }}
                    title={collapsed ? "Expand folder" : "Collapse folder"}
                    onClick={() => toggleFolderCollapsed(folder.id)}
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
                        width="11"
                        height="11"
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
                    <div className="flex flex-col gap-0.5">
                        {groups.length > 0 ? (
                            groups.map(renderGroup)
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

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div
                className="shrink-0 px-2 pt-2 pb-2"
                style={{ borderBottom: "1px solid var(--border)" }}
            >
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
                            title="Open"
                            count={openGroups.length}
                            showHeader={showOpenAllHeaders}
                            headerMetrics={metrics.header}
                        >
                            {openGroups.map(renderGroup)}
                        </AgentsSidebarSection>
                        {orderedFolders.map(renderFolder)}
                        <AgentsSidebarSection
                            title="All"
                            count={unfiledGroups.length}
                            showHeader={showOpenAllHeaders || orderedFolders.length > 0}
                            showWhenEmpty={orderedFolders.length > 0}
                            dropTarget="all"
                            isDropTarget={isDraggingOverUnfiled}
                            headerMetrics={metrics.header}
                        >
                            {unfiledGroups.map(renderGroup)}
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
                            disabled: isSubagentSession(contextMenu.payload),
                            action: () =>
                                togglePinnedChat(contextMenu.payload.sessionId),
                        },
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
            {newChatMenu && (
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
