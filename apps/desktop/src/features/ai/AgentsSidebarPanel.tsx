import {
    useCallback,
    useEffect,
    useLayoutEffect,
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
    getSessionTitleText,
    getSessionUpdatedAt,
} from "./sessionPresentation";
import {
    claudeTerminalAgentSessionId,
    closeClaudeTerminalAgentSession,
    focusClaudeTerminalAgentSession,
    isClaudeTerminalAgentSession,
} from "./claudeTerminalAgentSession";
import { useChatStore } from "./store/chatStore";
import { useAgentSidebarStore } from "./store/agentSidebarStore";
import type { AIChatSession } from "./types";
import {
    CLAUDE_TERMINAL_RUNTIME_ID,
} from "./utils/runtimeMetadata";
import { useInlineRename } from "./components/useInlineRename";
import {
    AgentsSidebarItem,
    type AgentsSidebarItemMetrics,
    type AgentSidebarTone,
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

type AgentRowDropTarget = {
    sessionId: string;
    scope: string;
    position: "before" | "after";
};

type AgentSidebarMotionDestination = "Pinned" | "Active" | "Snoozed" | "Completed";

type AgentSidebarMotion = {
    origin: DOMRect;
    destination: AgentSidebarMotionDestination;
};

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

// The card's context line pairs the runtime with "how long since this moved",
// so the label has to stay narrow enough that the runtime name keeps its room.
function formatCompactAgentTimestamp(timestamp: number): string {
    if (!timestamp) return "";
    const diffMinutes = Math.floor((Date.now() - timestamp) / 60_000);
    if (diffMinutes < 1) return "now";
    if (diffMinutes < 60) return `${diffMinutes}m`;

    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return `${diffHours}h`;

    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays}d`;

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

function isCodexSubagentSession(session: AIChatSession) {
    return isSubagentSession(session) && session.runtimeId.includes("codex");
}

function scaleMetric(base: number, scale: number, min: number) {
    return Math.max(min, Math.round(base * scale * 10) / 10);
}

function getAgentRowDropTargetAtPoint(
    clientX: number,
    clientY: number,
    sourceSessionId: string,
    sourceScope: string | undefined,
): AgentRowDropTarget | null {
    if (!sourceScope || typeof document.elementFromPoint !== "function") {
        return null;
    }
    const target = document.elementFromPoint(clientX, clientY);
    const row = target?.closest<HTMLElement>("[data-agent-reorder-scope]");
    const sessionId = row?.dataset.agentSessionId;
    const scope = row?.dataset.agentReorderScope;
    if (!row || !sessionId || !scope || scope !== sourceScope || sessionId === sourceSessionId) {
        return null;
    }
    const rect = row.getBoundingClientRect();
    return {
        sessionId,
        scope,
        position: clientY < rect.top + rect.height / 2 ? "before" : "after",
    };
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
            cardRadius: scaleMetric(7, scale, 6),
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
    const togglePinnedChat = useAgentSidebarStore((state) => state.togglePin);
    const unpinChat = useAgentSidebarStore((state) => state.unpinSession);
    const collapsedParentSessionIds = useAgentSidebarStore(
        (state) => state.collapsedParentSessionIds,
    );
    const expandedParentSessionIds = useAgentSidebarStore(
        (state) => state.expandedParentSessionIds,
    );
    const pinnedOrder = useAgentSidebarStore((state) => state.pinnedOrder);
    const toggleCollapsedParent = useAgentSidebarStore(
        (state) => state.toggleParentCollapsed,
    );
    const setParentCollapsed = useAgentSidebarStore(
        (state) => state.setParentCollapsed,
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
    const reorderPinnedSession = useAgentSidebarStore(
        (state) => state.reorderPinnedSession,
    );
    const resetPinnedOrder = useAgentSidebarStore(
        (state) => state.resetPinnedOrder,
    );
    const restorePinnedOrder = useAgentSidebarStore(
        (state) => state.restorePinnedOrder,
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
    const projection = useMemo(
        () =>
            buildAgentSidebarProjection({
                sessions,
                metadataBySessionId: sessionMetadata,
                pinnedOrder,
                filterText,
                focusedSessionId:
                    focusedWorkspaceChatSessionId ?? focusedTerminalAgentSessionId,
                now,
            }),
        [
            filterText,
            focusedTerminalAgentSessionId,
            focusedWorkspaceChatSessionId,
            now,
            pinnedOrder,
            sessionMetadata,
            sessions,
        ],
    );
    const allProjectedGroups = useMemo(
        () => [
            ...projection.pinnedGroups,
            ...projection.activeGroups,
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
    const activeGroups = hasFilter
        ? projection.searchResults
        : projection.activeGroups;

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
            const approved = await confirm(`Delete "${title}"?`, {
                title: "Delete thread?",
                kind: "warning",
            });
            if (!approved) return;

            unpinChat(session.sessionId);
            await deleteSession(session.sessionId);
        },
        [deleteSession, unpinChat],
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
    const [rowDropTarget, setRowDropTarget] =
        useState<AgentRowDropTarget | null>(null);
    const [keyboardSort, setKeyboardSort] = useState<{
        sessionId: string;
        scope: string;
        originalOrder: string[];
    } | null>(null);
    const [sortAnnouncement, setSortAnnouncement] = useState("");
    const motionOriginsRef = useRef(new Map<string, AgentSidebarMotion>());
    const motionCueTimeoutRef = useRef<number | null>(null);
    const [motionCue, setMotionCue] = useState<{
        sessionId: string;
        destination: AgentSidebarMotionDestination;
    } | null>(null);

    const beginSidebarMotion = useCallback(
        (sessionId: string, destination: AgentSidebarMotionDestination) => {
            const element = document.querySelector<HTMLElement>(
                `[data-agent-sidebar-motion-id="${sessionId}"]`,
            );
            if (element) {
                motionOriginsRef.current.set(sessionId, {
                    origin: element.getBoundingClientRect(),
                    destination,
                });
            }
            if (motionCueTimeoutRef.current !== null) {
                window.clearTimeout(motionCueTimeoutRef.current);
            }
            setMotionCue({ sessionId, destination });
            motionCueTimeoutRef.current = window.setTimeout(() => {
                setMotionCue(null);
                motionCueTimeoutRef.current = null;
            }, 700);
        },
        [],
    );

    useEffect(
        () => () => {
            if (motionCueTimeoutRef.current !== null) {
                window.clearTimeout(motionCueTimeoutRef.current);
            }
        },
        [],
    );

    // Invert the card from its old rectangle after React moves it to a new
    // section, so a metadata update reads as one continuous movement.
    useLayoutEffect(() => {
        const motions = [...motionOriginsRef.current.entries()];
        motionOriginsRef.current.clear();
        const reducedMotion = window.matchMedia?.(
            "(prefers-reduced-motion: reduce)",
        ).matches;

        for (const [sessionId, motion] of motions) {
            const element = document.querySelector<HTMLElement>(
                `[data-agent-sidebar-motion-id="${sessionId}"]`,
            );
            const section = document.querySelector<HTMLElement>(
                motion.destination === "Snoozed" || motion.destination === "Completed"
                    ? `[data-agent-shelf="${motion.destination.toLowerCase()}"]`
                    : `[data-agent-sidebar-section="${motion.destination.toLowerCase()}"]`,
            );
            section?.animate?.(
                [
                    { backgroundColor: "transparent" },
                    { backgroundColor: "color-mix(in srgb, var(--accent) 13%, transparent)" },
                    { backgroundColor: "transparent" },
                ],
                { duration: reducedMotion ? 1 : 420, easing: "ease-out" },
            );
            if (!element || reducedMotion) continue;
            const destination = element.getBoundingClientRect();
            element.animate?.(
                [
                    {
                        transform: `translate(${motion.origin.left - destination.left}px, ${motion.origin.top - destination.top}px) scale(0.98)`,
                        opacity: 0.72,
                    },
                    { transform: "translate(0, 0) scale(1)", opacity: 1 },
                ],
                { duration: 240, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
            );
        }
        if (motionCue && !reducedMotion) {
            document
                .querySelector<HTMLElement>("[data-agent-sidebar-motion-cue]")
                ?.animate?.(
                [
                    { opacity: 0, transform: "translateY(3px)" },
                    { opacity: 1, transform: "translateY(0)" },
                    { opacity: 1, transform: "translateY(0)" },
                    { opacity: 0, transform: "translateY(-2px)" },
                ],
                { duration: 700, easing: "ease-out" },
            );
        }
    }, [motionCue, projection]);

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
    const expandedParentIds = useMemo(
        () => new Set(expandedParentSessionIds),
        [expandedParentSessionIds],
    );

    const getReorderScopeIds = (scope: string) => {
        return scope === "pinned"
            ? projection.pinnedGroups.map((group) => group.root.sessionId)
            : [];
    };

    const applyScopedReorder = (
        sessionId: string,
        scope: string,
        destinationIndex: number,
    ) => {
        const scopeIds = getReorderScopeIds(scope);
        if (scope === "pinned") {
            reorderPinnedSession(sessionId, destinationIndex, scopeIds);
        }
    };

    const handleKeyboardSort = (
        sessionId: string,
        scope: string,
        action: "toggle" | "up" | "down" | "cancel",
    ) => {
        if (action === "toggle") {
            if (keyboardSort?.sessionId === sessionId) {
                setKeyboardSort(null);
                setSortAnnouncement("Agent position saved.");
            } else {
                setKeyboardSort({
                    sessionId,
                    scope,
                    originalOrder: [...pinnedOrder],
                });
                const scopeIds = getReorderScopeIds(scope);
                setSortAnnouncement(
                    `Picked up agent ${scopeIds.indexOf(sessionId) + 1} of ${scopeIds.length}.`,
                );
            }
            return;
        }
        if (keyboardSort?.sessionId !== sessionId) return;
        if (action === "cancel") {
            restorePinnedOrder(keyboardSort.originalOrder);
            setKeyboardSort(null);
            setSortAnnouncement("Agent move cancelled.");
            return;
        }
        const scopeIds = getReorderScopeIds(scope);
        const currentIndex = scopeIds.indexOf(sessionId);
        const destinationIndex = Math.max(
            0,
            Math.min(
                scopeIds.length - 1,
                currentIndex + (action === "up" ? -1 : 1),
            ),
        );
        if (currentIndex < 0 || currentIndex === destinationIndex) return;
        applyScopedReorder(sessionId, scope, destinationIndex);
        setSortAnnouncement(
            `Agent moved to position ${destinationIndex + 1} of ${scopeIds.length}.`,
        );
    };

    const renderItem = (
        session: AIChatSession,
        options?: {
            depth?: number;
            childCount?: number;
            isCollapsed?: boolean;
            canPin?: boolean;
            canRename?: boolean;
            canManage?: boolean;
            status?: AgentSidebarStatus;
            tone?: AgentSidebarTone;
            workingStartedAt?: number | null;
            variant?: "card" | "slim";
            quickActionLabel?: string;
            onQuickAction?: () => void;
            secondaryActionLabel?: string;
            onSecondaryAction?: () => void;
            statusLabelOverride?: string;
            movementLabel?: string;
            reorderScope?: string;
            onToggleCollapse?: () => void;
        },
    ) => {
        const isSubagent = isSubagentSession(session);
        const canPin = options?.canPin ?? !isSubagent;
        const canRename = options?.canRename ?? !isSubagent;
        const canManage = options?.canManage ?? !isSubagent;
        const isPinned = Boolean(pinnedEntries[session.sessionId]);
        const status =
            options?.status ??
            resolveAgentSidebarSessionStatus(
                session,
                sessionMetadata[session.sessionId],
            );
        const updatedAt = getSessionUpdatedAt(session);
        const timestampLabel = formatAgentTimestamp(updatedAt);
        const compactTimestampLabel = formatCompactAgentTimestamp(updatedAt);
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
        const updateRowDropTarget = (clientX: number, clientY: number) => {
            setRowDropTarget(
                getAgentRowDropTargetAtPoint(
                    clientX,
                    clientY,
                    session.sessionId,
                    options?.reorderScope,
                ),
            );
        };

        return (
            <AgentsSidebarItem
                key={session.sessionId}
                session={session}
                // The card has its own two-line visual limit. Passing the
                // full title preserves the available second-line capacity
                // instead of truncating it to the generic tab-title limit.
                title={getSessionTitleText(session)}
                timestampLabel={timestampLabel}
                compactTimestampLabel={compactTimestampLabel}
                status={status}
                statusLabel={statusLabel}
                movementLabel={options?.movementLabel}
                tone={options?.tone}
                variant={options?.variant ?? "card"}
                isActive={activeSidebarId === session.sessionId}
                isPinned={canPin && isPinned}
                canPin={canPin}
                canRename={canRename}
                canManage={canManage}
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
                    if (!canPin) return;
                    beginSidebarMotion(
                        session.sessionId,
                        isPinned ? "Active" : "Pinned",
                    );
                    togglePinnedChat(session.sessionId);
                }}
                onToggleCollapse={options?.onToggleCollapse}
                quickActionLabel={options?.quickActionLabel}
                onQuickAction={options?.onQuickAction}
                secondaryActionLabel={options?.secondaryActionLabel}
                onSecondaryAction={options?.onSecondaryAction}
                reorderScope={options?.reorderScope}
                dropPosition={
                    rowDropTarget?.sessionId === session.sessionId
                        ? rowDropTarget.position
                        : null
                }
                isKeyboardGrabbed={
                    keyboardSort?.sessionId === session.sessionId
                }
                onSortKeyboard={
                    options?.reorderScope
                        ? (action) =>
                              handleKeyboardSort(
                                  session.sessionId,
                                  options.reorderScope!,
                                  action,
                              )
                        : undefined
                }
                onContextMenu={(event) => handleContextMenu(event, session)}
                onDragStart={({ clientX, clientY }) => {
                    updateDragPreview(clientX, clientY);
                    updateRowDropTarget(clientX, clientY);
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
                    updateRowDropTarget(clientX, clientY);
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
                    const reorderTarget = getAgentRowDropTargetAtPoint(
                        clientX,
                        clientY,
                        session.sessionId,
                        options?.reorderScope,
                    );
                    const movedWithinSidebar = reorderTarget !== null;
                    if (reorderTarget && options?.reorderScope) {
                        const scopeIds = getReorderScopeIds(options.reorderScope);
                        const remaining = scopeIds.filter(
                            (id) => id !== session.sessionId,
                        );
                        const targetIndex = remaining.indexOf(
                            reorderTarget.sessionId,
                        );
                        if (targetIndex >= 0) {
                            applyScopedReorder(
                                session.sessionId,
                                options.reorderScope,
                                targetIndex +
                                    (reorderTarget.position === "after" ? 1 : 0),
                            );
                        }
                    }
                    setRowDropTarget(null);
                    emitAgentSidebarDrag({
                        // Sidebar drops belong to the sidebar; prevent the
                        // workspace pane drop handler from acting as well.
                        phase:
                            movedWithinSidebar || options?.reorderScope === "pinned"
                                ? "cancel"
                                : "end",
                        x: clientX,
                        y: clientY,
                        sessionId: session.sessionId,
                        title: dragTitle,
                    });
                }}
                onDragCancel={() => {
                    setDragPreview(null);
                    setRowDropTarget(null);
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
        const childrenDefaultToCollapsed = group.children.some(
            isCodexSubagentSession,
        );
        const collapsed =
            collapsedParentIds.has(group.root.sessionId) ||
            (childrenDefaultToCollapsed &&
                !expandedParentIds.has(group.root.sessionId));
        const forceChildrenVisible =
            hasFilter ||
            group.visibleChildren.some(
                (child) => child.sessionId === activeSidebarId,
            );
        const showChildren =
            group.visibleChildren.length > 0 &&
            (!collapsed || forceChildrenVisible);

        return (
            <div
                key={group.root.sessionId}
                className="flex flex-col"
                data-agent-sidebar-motion-id={group.root.sessionId}
            >
                {renderItem(group.root, {
                    childCount: group.children.length,
                    isCollapsed: collapsed && !forceChildrenVisible,
                    status: group.status,
                    // Lifecycle outranks status in the shelves: a snoozed row
                    // advertises its return ticket, a completed one its rest.
                    tone:
                        lifecycle === "snoozed"
                            ? "snoozed"
                            : lifecycle === "completed"
                              ? "done"
                              : undefined,
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
                            ? () => {
                                  beginSidebarMotion(group.root.sessionId, "Active");
                                  reopenSession(group.root.sessionId);
                              }
                            : lifecycle === "snoozed"
                              ? () => {
                                    beginSidebarMotion(group.root.sessionId, "Active");
                                    wakeSession(group.root.sessionId);
                                }
                            : !isClaudeTerminalAgentSession(group.root) &&
                                canCompleteAgentSidebarStatus(group.status)
                              ? () => {
                                    beginSidebarMotion(group.root.sessionId, "Completed");
                                    completeSession(group.root.sessionId);
                                }
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
                            ? () => {
                                  beginSidebarMotion(group.root.sessionId, "Snoozed");
                                  snoozeSession(
                                      group.root.sessionId,
                                      resolveAgentSnoozeTimestamp(
                                          "one-hour",
                                          Date.now(),
                                      ),
                                  );
                              }
                            : undefined,
                    statusLabelOverride:
                        lifecycle === "snoozed" && rootMetadata?.snoozedUntil
                            ? formatSnoozeWakeLabel(
                                  rootMetadata.snoozedUntil,
                                  now,
                              )
                            : undefined,
                    movementLabel:
                        motionCue?.sessionId === group.root.sessionId
                            ? `Moved to ${motionCue.destination}`
                            : undefined,
                    reorderScope:
                        lifecycle === "active" &&
                        rootMetadata?.pinnedAt !== null &&
                        rootMetadata?.pinnedAt !== undefined
                            ? "pinned"
                            : undefined,
                    onToggleCollapse:
                        group.children.length > 0
                            ? () => {
                                  if (childrenDefaultToCollapsed) {
                                      setParentCollapsed(
                                          group.root.sessionId,
                                          !collapsed,
                                          true,
                                      );
                                      return;
                                  }
                                  toggleCollapsedParent(group.root.sessionId);
                              }
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
                              canManage: false,
                              status: resolveAgentSidebarSessionStatus(
                                  child,
                                  rootMetadata,
                              ),
                              tone:
                                  lifecycle === "snoozed"
                                      ? "snoozed"
                                      : lifecycle === "completed"
                                        ? "done"
                                        : undefined,
                              statusLabelOverride:
                                  lifecycle === "snoozed" &&
                                  rootMetadata?.snoozedUntil
                                      ? formatSnoozeWakeLabel(
                                            rootMetadata.snoozedUntil,
                                            now,
                                        )
                                      : lifecycle === "completed"
                                        ? "Done"
                                        : undefined,
                              variant: "slim",
                          }),
                      )
                    : null}
            </div>
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
    const contextOrderKind = contextGroup
        ? contextMetadata?.pinnedAt !== null &&
          contextMetadata?.pinnedAt !== undefined
            ? "pinned"
            : "active"
        : null;

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
                            count={activeGroups.length}
                            headerMetrics={metrics.header}
                        >
                            {activeGroups.map((group) => renderGroup(group))}
                        </AgentsSidebarSection>
                    ) : (
                        <>
                            <AgentsSidebarSection
                                title="Pinned"
                                count={pinnedGroups.length}
                                showHeader={false}
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
                            <AgentsSidebarSection
                                title="Active"
                                count={activeGroups.length}
                                showHeader={false}
                                dropTarget="all"
                                headerMetrics={metrics.header}
                            >
                                {activeGroups.map((group) => renderGroup(group))}
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

            <div className="sr-only" aria-live="polite" aria-atomic="true">
                {sortAnnouncement}
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
                            action: () => {
                                beginSidebarMotion(
                                    contextMenu.payload.sessionId,
                                    pinnedEntries[contextMenu.payload.sessionId]
                                        ? "Active"
                                        : "Pinned",
                                );
                                togglePinnedChat(contextMenu.payload.sessionId);
                            },
                        },
                        ...(!contextGroup ||
                        isSubagentSession(contextMenu.payload) ||
                        isClaudeTerminalAgentSession(contextMenu.payload)
                            ? []
                            : contextIsCompleted
                              ? [
                                    {
                                        label: "Reopen",
                                        action: () => {
                                            beginSidebarMotion(contextGroup.root.sessionId, "Active");
                                            reopenSession(contextGroup.root.sessionId);
                                        },
                                    },
                                ]
                              : [
                                    {
                                        label: "Complete",
                                        disabled:
                                            !canCompleteAgentSidebarStatus(
                                                contextGroup.status,
                                            ),
                                        action: () => {
                                            beginSidebarMotion(contextGroup.root.sessionId, "Completed");
                                            completeSession(contextGroup.root.sessionId);
                                        },
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
                                        action: () => {
                                            beginSidebarMotion(contextGroup.root.sessionId, "Active");
                                            wakeSession(contextGroup.root.sessionId);
                                        },
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
                                                  action: () => {
                                                      beginSidebarMotion(contextGroup.root.sessionId, "Snoozed");
                                                      snoozeSession(
                                                          contextGroup.root
                                                              .sessionId,
                                                          resolveAgentSnoozeTimestamp(
                                                              preset.id,
                                                              Date.now(),
                                                          ),
                                                      );
                                                  },
                                              }),
                                          ),
                                      },
                                  ]),
                        ...(contextOrderKind === "pinned" && pinnedOrder.length > 0
                            ? [
                                  {
                                      label: "Reset pinned order",
                                      action: resetPinnedOrder,
                                  },
                              ]
                            : []),
                        {
                            label: "Rename",
                            disabled: isSubagentSession(contextMenu.payload),
                            action: () =>
                                handleStartRename(contextMenu.payload),
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
