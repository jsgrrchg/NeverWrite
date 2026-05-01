import {
    useCallback,
    useEffect,
    useMemo,
    useState,
    type MouseEvent,
} from "react";
import { aiSearchSessionContent, type SessionSearchResult } from "../api";
import {
    buildAiSessionHierarchyGroups,
    compareHierarchyGroupsByUpdatedAtDesc,
    type AiSessionHierarchyGroup,
} from "../sessionHierarchy";
import {
    DATE_GROUP_ORDER,
    findSessionForHistorySelection,
    formatSessionTime,
    getDateGroup,
    getHistorySelectionId,
    getSessionTitle,
    type DateGroup,
} from "../sessionPresentation";
import { useVaultStore } from "../../../app/store/vaultStore";
import type { AIChatSession, AIRuntimeOption } from "../types";
import { HistorySessionCard } from "./HistorySessionCard";

interface HistorySessionListProps {
    sessions: AIChatSession[];
    runtimes: AIRuntimeOption[];
    selectedSessionId: string | null;
    onSelectSession: (sessionId: string) => void;
    onRestoreSession: (sessionId: string) => void;
    onDeleteSession: (sessionId: string) => void;
    onDeleteSessions: (sessionIds: string[]) => void;
    onForkSession: (sessionId: string) => void;
    onExportSession: (sessionId: string) => void;
    onRenameSession: (sessionId: string, newTitle: string | null) => void;
}

function groupByDate(
    hierarchyGroups: AiSessionHierarchyGroup[],
): [DateGroup, AiSessionHierarchyGroup[]][] {
    const groups = new Map<DateGroup, AiSessionHierarchyGroup[]>();
    for (const hierarchyGroup of hierarchyGroups) {
        const group = getDateGroup(hierarchyGroup.latestUpdatedAt);
        const list = groups.get(group);
        if (list) {
            list.push(hierarchyGroup);
        } else {
            groups.set(group, [hierarchyGroup]);
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
    onRestoreSession,
    onDeleteSession,
    onDeleteSessions,
    onForkSession,
    onExportSession,
    onRenameSession,
}: HistorySessionListProps) {
    const [search, setSearch] = useState("");
    const [isSearchingContent, setIsSearchingContent] = useState(false);
    const [contentResults, setContentResults] = useState<
        SessionSearchResult[] | null
    >(null);
    const [selectedHistoryIds, setSelectedHistoryIds] = useState<string[]>([]);
    const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(
        null,
    );
    const vaultPath = useVaultStore((s) => s.vaultPath);

    const hierarchy = useMemo(() => {
        const normalizedFilter = search.trim().toLowerCase();
        const result = buildAiSessionHierarchyGroups({
            sessions,
            normalizedFilter,
        });
        return {
            ...result,
            groups: [...result.groups].sort(compareHierarchyGroupsByUpdatedAtDesc),
        };
    }, [sessions, search]);
    const visibleHistoryIds = useMemo(
        () =>
            hierarchy.groups.flatMap((group) => [
                getHistorySelectionId(group.root),
                ...group.visibleChildren.map((session) =>
                    getHistorySelectionId(session),
                ),
            ]),
        [hierarchy.groups],
    );
    const visibleHistoryIdSet = useMemo(
        () => new Set(visibleHistoryIds),
        [visibleHistoryIds],
    );

    const groups = useMemo(() => groupByDate(hierarchy.groups), [hierarchy]);
    const selectedHistoryId =
        findSessionForHistorySelection(sessions, selectedSessionId)
            ?.historySessionId ??
        (selectedSessionId?.startsWith("persisted:")
            ? selectedSessionId.slice("persisted:".length)
            : selectedSessionId);

    const runContentSearch = useCallback(
        async (query: string) => {
            if (!vaultPath || !query.trim()) return;
            setIsSearchingContent(true);
            try {
                const results = await aiSearchSessionContent(
                    vaultPath,
                    query.trim(),
                );
                setContentResults(results);
            } catch (err) {
                console.error("Content search failed:", err);
                setContentResults([]);
            } finally {
                setIsSearchingContent(false);
            }
        },
        [vaultPath],
    );

    const clearSearch = useCallback(() => {
        setSearch("");
        setContentResults(null);
    }, []);

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            if (e.key === "Enter" && search.trim()) {
                e.preventDefault();
                void runContentSearch(search);
            }
            if (e.key === "Escape") {
                clearSearch();
            }
        },
        [search, runContentSearch, clearSearch],
    );

    const showContentResults = contentResults !== null;
    const batchSelectedHistoryIdSet = useMemo(
        () => new Set(selectedHistoryIds),
        [selectedHistoryIds],
    );
    const batchSelectedSessionIds = useMemo(
        () =>
            selectedHistoryIds
                .map(
                    (historyId) =>
                        sessions.find(
                            (session) =>
                                getHistorySelectionId(session) === historyId,
                        )?.sessionId ?? null,
                )
                .filter((sessionId): sessionId is string => !!sessionId),
        [selectedHistoryIds, sessions],
    );

    useEffect(() => {
        setSelectedHistoryIds((current) =>
            current.filter((historyId) => visibleHistoryIdSet.has(historyId)),
        );
        setSelectionAnchorId((current) =>
            current && visibleHistoryIdSet.has(current) ? current : null,
        );
    }, [visibleHistoryIdSet]);

    useEffect(() => {
        if (!showContentResults) return;
        setSelectedHistoryIds([]);
        setSelectionAnchorId(null);
    }, [showContentResults]);

    const handleSessionSelect = useCallback(
        (session: AIChatSession, event: MouseEvent<HTMLDivElement>) => {
            const historyId = getHistorySelectionId(session);
            const isContextMenu = event.type === "contextmenu";
            const isToggleSelection = event.metaKey || event.ctrlKey;
            const anchorId = selectionAnchorId ?? selectedHistoryId;

            if (event.shiftKey && anchorId) {
                const anchorIndex = visibleHistoryIds.indexOf(anchorId);
                const targetIndex = visibleHistoryIds.indexOf(historyId);
                if (anchorIndex !== -1 && targetIndex !== -1) {
                    const [start, end] =
                        anchorIndex < targetIndex
                            ? [anchorIndex, targetIndex]
                            : [targetIndex, anchorIndex];
                    setSelectedHistoryIds(
                        visibleHistoryIds.slice(start, end + 1),
                    );
                    onSelectSession(historyId);
                    return;
                }
            }

            if (isToggleSelection) {
                const next = new Set(
                    selectedHistoryIds.length > 0
                        ? selectedHistoryIds
                        : selectedHistoryId
                          ? [selectedHistoryId]
                          : [],
                );
                if (next.has(historyId)) {
                    next.delete(historyId);
                } else {
                    next.add(historyId);
                }
                setSelectedHistoryIds(
                    visibleHistoryIds.filter((id) => next.has(id)),
                );
                setSelectionAnchorId(historyId);
                onSelectSession(historyId);
                return;
            }

            if (isContextMenu && batchSelectedHistoryIdSet.has(historyId)) {
                onSelectSession(historyId);
                return;
            }

            setSelectedHistoryIds([]);
            setSelectionAnchorId(historyId);
            onSelectSession(historyId);
        },
        [
            batchSelectedHistoryIdSet,
            onSelectSession,
            selectedHistoryId,
            selectedHistoryIds,
            selectionAnchorId,
            visibleHistoryIds,
        ],
    );

    const clearBatchSelection = useCallback(() => {
        setSelectedHistoryIds([]);
        setSelectionAnchorId(selectedHistoryId);
    }, [selectedHistoryId]);
    const handleSessionOpen = useCallback(
        (session: AIChatSession) => {
            setSelectedHistoryIds([]);
            setSelectionAnchorId(getHistorySelectionId(session));
            onRestoreSession(getHistorySelectionId(session));
        },
        [onRestoreSession],
    );

    return (
        <div className="flex h-full min-h-0 flex-col">
            {/* Search bar */}
            <div
                className="shrink-0 px-3 py-1"
                style={{ borderBottom: "1px solid var(--border)" }}
            >
                <div
                    className="flex h-6 items-center gap-2 rounded-md px-2"
                    style={{
                        background: "var(--bg-primary)",
                        border: showContentResults
                            ? "1px solid var(--accent)"
                            : "1px solid var(--border)",
                    }}
                >
                    <svg
                        width="12"
                        height="12"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        style={{
                            color: showContentResults
                                ? "var(--accent)"
                                : "var(--text-secondary)",
                            opacity: showContentResults ? 1 : 0.5,
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
                        onChange={(e) => {
                            setSearch(e.target.value);
                            if (!e.target.value.trim()) {
                                setContentResults(null);
                            }
                        }}
                        onKeyDown={handleKeyDown}
                        className="min-w-0 flex-1 text-[9px] leading-none outline-none"
                        style={{
                            background: "transparent",
                            color: "var(--text-primary)",
                            border: "none",
                            fontSize: 11,
                        }}
                    />
                    {search && (
                        <button
                            type="button"
                            onClick={clearSearch}
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

            {batchSelectedSessionIds.length > 1 && (
                <div
                    className="flex shrink-0 items-center gap-2 px-3 py-1.5"
                    style={{
                        borderBottom: "1px solid var(--border)",
                        background:
                            "color-mix(in srgb, var(--accent) 7%, var(--bg-secondary))",
                    }}
                >
                    <span
                        className="min-w-0 flex-1 text-[10px] font-medium"
                        style={{ color: "var(--text-primary)" }}
                    >
                        {batchSelectedSessionIds.length} chats selected
                    </span>
                    <button
                        type="button"
                        onClick={() =>
                            onDeleteSessions(batchSelectedSessionIds)
                        }
                        className="rounded px-2 py-1 text-[10px] font-medium"
                        style={{
                            backgroundColor: "#dc2626",
                            border: "1px solid #dc2626",
                            color: "#fff",
                        }}
                    >
                        Delete selected
                    </button>
                    <button
                        type="button"
                        onClick={clearBatchSelection}
                        className="rounded px-2 py-1 text-[10px] font-medium"
                        style={{
                            background: "none",
                            border: "1px solid var(--border)",
                            color: "var(--text-primary)",
                        }}
                    >
                        Clear
                    </button>
                </div>
            )}

            {/* Session list / Search results */}
            <div
                className="min-h-0 flex-1 overflow-y-auto p-1"
                data-scrollbar-active="true"
            >
                {isSearchingContent && (
                    <div
                        className="px-3 py-8 text-center text-xs"
                        style={{ color: "var(--text-secondary)" }}
                    >
                        Searching…
                    </div>
                )}

                {!isSearchingContent && showContentResults && (
                    <ContentSearchResults
                        results={contentResults}
                        selectedHistoryId={selectedHistoryId}
                        onSelectSession={onSelectSession}
                    />
                )}

                {!isSearchingContent && !showContentResults && (
                    <>
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
                                    {groupSessions.flatMap(
                                        (hierarchyGroup) => {
                                            const parentTitle =
                                                getSessionTitle(
                                                    hierarchyGroup.root,
                                                );
                                            const rows = [
                                                {
                                                    session:
                                                        hierarchyGroup.root,
                                                    depth: 0,
                                                    badgeLabel:
                                                        hierarchyGroup.isDetachedAgent
                                                            ? "Agent"
                                                            : undefined,
                                                    canRename:
                                                        !hierarchyGroup.isDetachedAgent,
                                                    childCount:
                                                        hierarchyGroup.children
                                                            .length,
                                                    parentTitle: null,
                                                },
                                                ...hierarchyGroup.visibleChildren.map(
                                                    (session) => ({
                                                        session,
                                                        depth: 1,
                                                        badgeLabel: "Agent",
                                                        canRename: false,
                                                        childCount: 0,
                                                        parentTitle,
                                                    }),
                                                ),
                                            ];

                                            return rows.map(
                                                ({
                                                    session,
                                                    depth,
                                                    badgeLabel,
                                                    canRename,
                                                    childCount,
                                                    parentTitle,
                                                }) => {
                                                    const historyId =
                                                        getHistorySelectionId(
                                                            session,
                                                        );
                                                    const hasBatchSelection =
                                                        batchSelectedHistoryIdSet.size >
                                                        0;
                                                    return (
                                                        <HistorySessionCard
                                                            key={
                                                                session.sessionId
                                                            }
                                                            session={session}
                                                            runtimes={runtimes}
                                                            isSelected={
                                                                hasBatchSelection
                                                                    ? batchSelectedHistoryIdSet.has(
                                                                          historyId,
                                                                      )
                                                                    : historyId ===
                                                                      selectedHistoryId
                                                            }
                                                            isActive={
                                                                historyId ===
                                                                selectedHistoryId
                                                            }
                                                            badgeLabel={
                                                                badgeLabel
                                                            }
                                                            canRename={
                                                                canRename
                                                            }
                                                            childCount={
                                                                childCount
                                                            }
                                                            depth={depth}
                                                            parentTitle={
                                                                parentTitle
                                                            }
                                                            onOpen={() =>
                                                                handleSessionOpen(
                                                                    session,
                                                                )
                                                            }
                                                            onSelect={(
                                                                event,
                                                            ) =>
                                                                handleSessionSelect(
                                                                    session,
                                                                    event,
                                                                )
                                                            }
                                                            onDelete={() =>
                                                                onDeleteSession(
                                                                    session.sessionId,
                                                                )
                                                            }
                                                            onFork={() =>
                                                                onForkSession(
                                                                    session.sessionId,
                                                                )
                                                            }
                                                            onExport={() =>
                                                                onExportSession(
                                                                    session.sessionId,
                                                                )
                                                            }
                                                            onRename={(
                                                                newTitle,
                                                            ) =>
                                                                onRenameSession(
                                                                    session.sessionId,
                                                                    newTitle,
                                                                )
                                                            }
                                                        />
                                                    );
                                                },
                                            );
                                        },
                                    )}
                                </div>
                            </div>
                        ))}
                    </>
                )}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Content search results
// ---------------------------------------------------------------------------

function ContentSearchResults({
    results,
    selectedHistoryId,
    onSelectSession,
}: {
    results: SessionSearchResult[];
    selectedHistoryId: string | null | undefined;
    onSelectSession: (sessionId: string) => void;
}) {
    if (results.length === 0) {
        return (
            <div
                className="px-3 py-8 text-center text-xs"
                style={{ color: "var(--text-secondary)" }}
            >
                No results found in message content.
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-0.5">
            <div
                className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider"
                style={{
                    color: "var(--text-secondary)",
                    opacity: 0.6,
                }}
            >
                {results.length} {results.length === 1 ? "session" : "sessions"}{" "}
                found
            </div>
            {results.map((result) => (
                <SearchResultCard
                    key={result.session_id}
                    result={result}
                    isSelected={selectedHistoryId === result.session_id}
                    onSelect={() => onSelectSession(result.session_id)}
                />
            ))}
        </div>
    );
}

function SearchResultCard({
    result,
    isSelected,
    onSelect,
}: {
    result: SessionSearchResult;
    isSelected: boolean;
    onSelect: () => void;
}) {
    const [hovered, setHovered] = useState(false);
    const title =
        result.custom_title?.trim() || result.title?.trim() || "New chat";

    return (
        <div
            className="rounded-md px-3 py-2"
            style={{
                backgroundColor: isSelected
                    ? "var(--bg-tertiary)"
                    : hovered
                      ? "color-mix(in srgb, var(--bg-tertiary) 50%, transparent)"
                      : "transparent",
                border: isSelected
                    ? "1px solid var(--accent)"
                    : "1px solid transparent",
                cursor: "pointer",
                transition:
                    "background-color 80ms ease, border-color 80ms ease",
            }}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onClick={onSelect}
        >
            {/* Title + time */}
            <div className="flex items-center gap-1">
                <span
                    className="min-w-0 flex-1 truncate text-xs font-medium"
                    style={{ color: "var(--text-primary)" }}
                >
                    {title}
                </span>
                {result.updated_at > 0 && (
                    <span
                        className="shrink-0 text-[10px]"
                        style={{
                            color: "var(--text-secondary)",
                            opacity: 0.6,
                        }}
                    >
                        {formatSessionTime(result.updated_at)}
                    </span>
                )}
            </div>

            {/* Matched snippets */}
            <div className="mt-1 flex flex-col gap-0.5">
                {result.matched_messages.map((msg) => (
                    <div
                        key={msg.message_id}
                        className="flex gap-1.5 text-[11px] leading-snug"
                    >
                        <span
                            className="mt-px shrink-0 rounded px-1 text-[9px] font-medium uppercase"
                            style={{
                                color: "var(--text-secondary)",
                                background:
                                    "color-mix(in srgb, var(--text-secondary) 12%, transparent)",
                            }}
                        >
                            {msg.role === "user" ? "you" : "ai"}
                        </span>
                        <span
                            className="min-w-0 flex-1"
                            style={{
                                color: "var(--text-secondary)",
                                opacity: 0.8,
                                display: "-webkit-box",
                                WebkitLineClamp: 2,
                                WebkitBoxOrient: "vertical",
                                overflow: "hidden",
                            }}
                        >
                            {msg.content_snippet}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}
