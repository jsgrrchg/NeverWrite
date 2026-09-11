import { isSessionArchived, useArchivedChatsStore } from "../store/archivedChatsStore";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { EditorFontFamily } from "../../../app/store/settingsStore";
import { useChatStore } from "../store/chatStore";
import {
    findSessionForHistorySelection,
    formatSessionTime,
    getSessionRuntimeName,
    getSessionTitle,
} from "../sessionPresentation";
import type { AIChatSession } from "../types";
import { AIChatMessageList } from "./AIChatMessageList";
import { useChatFindShortcut } from "./find/useChatFindShortcut";

interface HistoryTranscriptViewerProps {
    historySessionId: string;
    chatFontSize?: number;
    chatFontFamily?: EditorFontFamily;
    onExport?: () => void;
    onRestore?: () => void;
    headerActions?: ReactNode;
    compactHeader?: boolean;
}

function TranscriptHeader({
    session,
    onExport,
    onRestore,
    headerActions,
    compactHeader = false,
}: {
    session: AIChatSession;
    onExport?: () => void;
    onRestore?: () => void;
    headerActions?: ReactNode;
    compactHeader?: boolean;
}) {
    const runtimes = useChatStore((s) => s.runtimes);
    const forkSession = useChatStore((s) => s.forkSession);
    const sessionsById = useChatStore((s) => s.sessionsById);
    const archiveEntries = useArchivedChatsStore(state => state.entries);
    const openLabel = isSessionArchived(session, sessionsById, archiveEntries)
        ? "Open archived chat" : "Continue chat";
    const runtimeOptions = useMemo(
        () => runtimes.map((d) => d.runtime),
        [runtimes],
    );
    const title = getSessionTitle(session);
    const runtimeLabel = getSessionRuntimeName(session, runtimeOptions);
    const modelLabel = session.modelId;
    const updatedAt = session.persistedUpdatedAt ?? 0;
    const parentSession = useMemo(
        () =>
            findSessionForHistorySelection(
                sessionsById,
                session.parentSessionId,
            ),
        [session.parentSessionId, sessionsById],
    );
    const parentTitle = parentSession ? getSessionTitle(parentSession) : null;

    return (
        <div
            className="flex h-[31px] shrink-0 items-center gap-2 px-3 py-1 text-xs"
            style={{
                borderBottom: "1px solid var(--border)",
                color: "var(--text-primary)",
            }}
        >
            <span className="min-w-0 flex-1 truncate text-xs font-medium">
                {title}
            </span>
            {session.parentSessionId ? (
                <span
                    className="shrink-0 rounded-full px-2 py-1 text-[10px] font-medium"
                    style={{
                        background:
                            "color-mix(in srgb, var(--accent) 10%, transparent)",
                        border:
                            "1px solid color-mix(in srgb, var(--accent) 24%, transparent)",
                        color: "var(--text-secondary)",
                    }}
                    title={
                        parentTitle
                            ? `Subagent of ${parentTitle}`
                            : "Subagent"
                    }
                >
                    {parentTitle ? `Subagent of ${parentTitle}` : "Subagent"}
                </span>
            ) : null}
            {onRestore && (
                <button
                    type="button"
                    onClick={onRestore}
                    className="flex h-6 shrink-0 items-center gap-1 rounded px-2 text-[10px] font-medium"
                    style={{
                        background:
                            "color-mix(in srgb, var(--accent) 12%, transparent)",
                        border: "1px solid var(--accent)",
                        color: "var(--text-primary)",
                    }}
                    title={openLabel}
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
                        <path d="M2.5 6h7" />
                        <path d="M6 2.5 9.5 6 6 9.5" />
                    </svg>
                    {openLabel}
                </button>
            )}
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
            {!compactHeader && (
                <>
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
                </>
            )}
            {headerActions}
        </div>
    );
}

export function HistoryTranscriptViewer({
    historySessionId,
    chatFontSize,
    chatFontFamily,
    onExport,
    onRestore,
    headerActions,
    compactHeader,
}: HistoryTranscriptViewerProps) {
    const sessionsById = useChatStore((s) => s.sessionsById);
    const ensureTranscriptLoaded = useChatStore(
        (s) => s.ensureSessionTranscriptLoaded,
    );
    const session = useMemo(
        () => findSessionForHistorySelection(sessionsById, historySessionId),
        [historySessionId, sessionsById],
    );
    const sessionId = session?.sessionId ?? null;

    const storeFontSize = useChatStore((s) => s.chatFontSize);
    const storeFontFamily = useChatStore((s) => s.chatFontFamily);
    const effectiveFontSize = chatFontSize ?? storeFontSize;
    const effectiveFontFamily = chatFontFamily ?? storeFontFamily;
    const [findOpen, setFindOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!sessionId) return;
        void ensureTranscriptLoaded(sessionId, "full");
    }, [ensureTranscriptLoaded, sessionId]);

    // Close the finder when switching to another transcript.
    useEffect(() => {
        setFindOpen(false);
    }, [historySessionId]);

    const openFind = useCallback(() => {
        setFindOpen(true);
    }, []);
    useChatFindShortcut({ rootRef, onOpen: openFind });

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
        <div
            ref={rootRef}
            tabIndex={-1}
            className="flex h-full min-h-0 flex-col outline-none"
        >
            <TranscriptHeader
                session={session}
                headerActions={headerActions}
                compactHeader={compactHeader}
                onExport={onExport}
                onRestore={onRestore}
            />
            <AIChatMessageList
                sessionId={session.sessionId}
                messages={session.messages}
                status="idle"
                readOnly
                findOpen={findOpen}
                onCloseFind={() => {
                    setFindOpen(false);
                    rootRef.current?.focus();
                }}
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
