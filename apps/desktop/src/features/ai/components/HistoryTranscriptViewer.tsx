import { useEffect, useMemo, useRef, useState } from "react";
import type { EditorFontFamily } from "../../../app/store/settingsStore";
import { useChatStore } from "../store/chatStore";
import {
    findSessionForHistorySelection,
    formatSessionTime,
    getRuntimeName,
    getSessionTitle,
} from "../sessionPresentation";
import type { AIChatSession } from "../types";
import { AIChatMessageList } from "./AIChatMessageList";

interface HistoryTranscriptViewerProps {
    historySessionId: string;
    chatFontSize?: number;
    chatFontFamily?: EditorFontFamily;
    onExport?: () => void;
}

function matchesMessageSearch(
    message: AIChatSession["messages"][number],
    query: string,
) {
    const lower = query.trim().toLowerCase();
    if (!lower) return false;
    return (
        message.content.toLowerCase().includes(lower) ||
        (message.title?.toLowerCase().includes(lower) ?? false)
    );
}

function TranscriptHeader({
    session,
    onExport,
    searchOpen,
    onToggleSearch,
}: {
    session: AIChatSession;
    onExport?: () => void;
    searchOpen: boolean;
    onToggleSearch: () => void;
}) {
    const runtimes = useChatStore((s) => s.runtimes);
    const forkSession = useChatStore((s) => s.forkSession);
    const runtimeOptions = useMemo(
        () => runtimes.map((d) => d.runtime),
        [runtimes],
    );
    const title = getSessionTitle(session);
    const runtimeLabel = getRuntimeName(session.runtimeId, runtimeOptions);
    const modelLabel = session.modelId;
    const updatedAt = session.persistedUpdatedAt ?? 0;

    return (
        <div
            className="flex shrink-0 items-center gap-2 px-3 py-2"
            style={{
                borderBottom: "1px solid var(--border)",
                color: "var(--text-primary)",
            }}
        >
            <span className="min-w-0 flex-1 truncate text-xs font-medium">
                {title}
            </span>
            {onExport && (
                <button
                    type="button"
                    onClick={onExport}
                    className="flex h-6 shrink-0 items-center gap-1 rounded px-2 text-[10px] font-medium"
                    style={{
                        background: "none",
                        border: "1px solid var(--border)",
                        color: "var(--text-secondary)",
                    }}
                    title="Export to note"
                >
                    <svg
                        width="12"
                        height="12"
                        viewBox="0 0 12 12"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <path d="M6 2v6M3.5 5.5 6 8l2.5-2.5M2.5 10h7" />
                    </svg>
                    Export
                </button>
            )}
            <button
                type="button"
                onClick={onToggleSearch}
                className="flex h-6 shrink-0 items-center gap-1 rounded px-2 text-[10px] font-medium"
                style={{
                    background: searchOpen
                        ? "color-mix(in srgb, var(--accent) 12%, transparent)"
                        : "none",
                    border: searchOpen
                        ? "1px solid color-mix(in srgb, var(--accent) 35%, var(--border))"
                        : "1px solid var(--border)",
                    color: searchOpen
                        ? "var(--text-primary)"
                        : "var(--text-secondary)",
                }}
                title="Search in this chat"
            >
                <svg
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    <circle cx="5.25" cy="5.25" r="3.25" />
                    <path d="M7.75 7.75 10 10" />
                </svg>
                Search
            </button>
            <button
                type="button"
                onClick={() => void forkSession(session.sessionId)}
                className="flex h-6 shrink-0 items-center gap-1 rounded px-2 text-[10px] font-medium"
                style={{
                    background: "none",
                    border: "1px solid var(--border)",
                    color: "var(--text-secondary)",
                }}
                title="Fork this chat"
            >
                <svg
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    <path d="M3 2v3a3 3 0 0 0 3 3h0a3 3 0 0 0 3-3V2M3 2h0M9 2h0M6 8v2" />
                </svg>
                Fork
            </button>
            <span
                className="shrink-0 text-[10px]"
                style={{ color: "var(--text-secondary)", opacity: 0.7 }}
            >
                {runtimeLabel}
                {modelLabel ? ` · ${modelLabel}` : ""}
            </span>
            {updatedAt > 0 && (
                <span
                    className="shrink-0 text-[10px]"
                    style={{ color: "var(--text-secondary)", opacity: 0.7 }}
                >
                    {formatSessionTime(updatedAt)}
                </span>
            )}
        </div>
    );
}

export function HistoryTranscriptViewer({
    historySessionId,
    chatFontSize,
    chatFontFamily,
    onExport,
}: HistoryTranscriptViewerProps) {
    const sessionsById = useChatStore((s) => s.sessionsById);
    const ensureTranscriptLoaded = useChatStore(
        (s) => s.ensureSessionTranscriptLoaded,
    );
    const session = useMemo(
        () => findSessionForHistorySelection(sessionsById, historySessionId),
        [historySessionId, sessionsById],
    );

    const storeFontSize = useChatStore((s) => s.chatFontSize);
    const storeFontFamily = useChatStore((s) => s.chatFontFamily);
    const effectiveFontSize = chatFontSize ?? storeFontSize;
    const effectiveFontFamily = chatFontFamily ?? storeFontFamily;
    const [searchOpen, setSearchOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [activeMatchIndex, setActiveMatchIndex] = useState(0);
    const searchInputRef = useRef<HTMLInputElement>(null);

    const matchedMessages = useMemo(() => {
        const query = searchQuery.trim();
        if (!query) return [];
        return (
            session?.messages.filter((message) =>
                matchesMessageSearch(message, query),
            ) ?? []
        );
    }, [searchQuery, session]);
    const activeMatch =
        matchedMessages.length > 0
            ? matchedMessages[
                  Math.min(activeMatchIndex, matchedMessages.length - 1)
              ]
            : null;
    const highlightedMessageIds = useMemo(
        () => matchedMessages.map((message) => message.id),
        [matchedMessages],
    );

    useEffect(() => {
        if (!session) return;
        void ensureTranscriptLoaded(session.sessionId, "full");
    }, [ensureTranscriptLoaded, session]);

    useEffect(() => {
        if (!searchOpen) return;
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
    }, [searchOpen]);

    useEffect(() => {
        setActiveMatchIndex(0);
    }, [searchQuery, historySessionId]);

    if (!session) {
        return (
            <div
                className="flex h-full items-center justify-center text-xs"
                style={{ color: "var(--text-secondary)" }}
            >
                Session not found.
            </div>
        );
    }

    const hasOlderMessages = (session.loadedPersistedMessageStart ?? 0) > 0;

    return (
        <div className="flex h-full min-h-0 flex-col">
            <TranscriptHeader
                session={session}
                onExport={onExport}
                searchOpen={searchOpen}
                onToggleSearch={() => {
                    setSearchOpen((open) => !open);
                    if (searchOpen) {
                        setSearchQuery("");
                    }
                }}
            />
            {searchOpen && (
                <div
                    className="flex shrink-0 items-center gap-2 px-3 py-1.5"
                    style={{
                        borderBottom: "1px solid var(--border)",
                        background:
                            "color-mix(in srgb, var(--bg-tertiary) 35%, transparent)",
                    }}
                >
                    <div
                        className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2"
                        style={{
                            background: "var(--bg-primary)",
                            border: "1px solid var(--border)",
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
                            style={{
                                color: "var(--text-secondary)",
                                opacity: 0.6,
                                flexShrink: 0,
                            }}
                        >
                            <circle cx="7" cy="7" r="5" />
                            <path d="M11 11l3.5 3.5" />
                        </svg>
                        <input
                            ref={searchInputRef}
                            type="text"
                            placeholder="Find in this chat…"
                            value={searchQuery}
                            onChange={(event) =>
                                setSearchQuery(event.target.value)
                            }
                            onKeyDown={(event) => {
                                if (event.key === "Escape") {
                                    setSearchQuery("");
                                    setSearchOpen(false);
                                } else if (
                                    event.key === "Enter" &&
                                    matchedMessages.length > 0
                                ) {
                                    event.preventDefault();
                                    setActiveMatchIndex((index) =>
                                        event.shiftKey
                                            ? (index -
                                                  1 +
                                                  matchedMessages.length) %
                                              matchedMessages.length
                                            : (index + 1) %
                                              matchedMessages.length,
                                    );
                                }
                            }}
                            className="min-w-0 flex-1 text-[11px] leading-none outline-none"
                            style={{
                                background: "transparent",
                                color: "var(--text-primary)",
                                border: "none",
                            }}
                        />
                    </div>
                    <span
                        className="shrink-0 text-[10px]"
                        style={{
                            color: "var(--text-secondary)",
                            opacity: 0.75,
                        }}
                    >
                        {searchQuery.trim()
                            ? matchedMessages.length > 0
                                ? `${activeMatchIndex + 1} of ${matchedMessages.length}`
                                : "0 results"
                            : "Type to search"}
                    </span>
                    <button
                        type="button"
                        onClick={() =>
                            setActiveMatchIndex((index) =>
                                matchedMessages.length > 0
                                    ? (index - 1 + matchedMessages.length) %
                                      matchedMessages.length
                                    : 0,
                            )
                        }
                        disabled={matchedMessages.length === 0}
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded"
                        style={{
                            background: "none",
                            border: "1px solid var(--border)",
                            color: "var(--text-secondary)",
                            opacity: matchedMessages.length > 0 ? 1 : 0.4,
                        }}
                        title="Previous result"
                    >
                        <svg
                            width="10"
                            height="10"
                            viewBox="0 0 10 10"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <path d="M6.5 2 3.5 5l3 3" />
                        </svg>
                    </button>
                    <button
                        type="button"
                        onClick={() =>
                            setActiveMatchIndex((index) =>
                                matchedMessages.length > 0
                                    ? (index + 1) % matchedMessages.length
                                    : 0,
                            )
                        }
                        disabled={matchedMessages.length === 0}
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded"
                        style={{
                            background: "none",
                            border: "1px solid var(--border)",
                            color: "var(--text-secondary)",
                            opacity: matchedMessages.length > 0 ? 1 : 0.4,
                        }}
                        title="Next result"
                    >
                        <svg
                            width="10"
                            height="10"
                            viewBox="0 0 10 10"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <path d="m3.5 2 3 3-3 3" />
                        </svg>
                    </button>
                </div>
            )}
            <AIChatMessageList
                sessionId={session.sessionId}
                messages={session.messages}
                status="idle"
                readOnly
                highlightedMessageIds={highlightedMessageIds}
                activeHighlightedMessageId={activeMatch?.id ?? null}
                hasOlderMessages={hasOlderMessages}
                isLoadingOlderMessages={
                    session.isLoadingPersistedMessages ?? false
                }
                chatFontSize={effectiveFontSize}
                chatFontFamily={effectiveFontFamily}
                onLoadOlderMessages={() => {
                    void ensureTranscriptLoaded(session.sessionId, "full");
                }}
            />
        </div>
    );
}
