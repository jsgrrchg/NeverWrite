import { useCallback, useMemo, useRef, useState } from "react";
import { useVaultStore } from "../../../app/store/vaultStore";
import { useEditorStore } from "../../../app/store/editorStore";
import { openChatSessionInWorkspace } from "../chatPaneMovement";
import { useChatStore } from "../store/chatStore";
import { exportChatSessionToVaultNote } from "../chatExport";
import { findSessionForHistorySelection } from "../sessionPresentation";
import { HistorySessionList } from "./HistorySessionList";
import { HistoryTranscriptViewer } from "./HistoryTranscriptViewer";

const MIN_LIST_WIDTH = 220;
const MAX_LIST_WIDTH = 480;
const DEFAULT_LIST_WIDTH = 300;
const RESIZER_HITBOX = 10;
const RESIZER_OVERLAP = RESIZER_HITBOX / 2;

interface ResizeSession {
    pointerId: number;
    startX: number;
    startWidth: number;
}

interface ChatHistoryViewProps {
    selectedHistorySessionId: string | null;
    onSelectHistorySessionId: (sessionId: string | null) => void;
    onRestoreHistorySession?: (historySessionId: string) => void;
    onRequestClose?: () => void;
    showBackButton?: boolean;
}

export function ChatHistoryView({
    selectedHistorySessionId,
    onSelectHistorySessionId,
    onRestoreHistorySession,
    onRequestClose,
    showBackButton = true,
}: ChatHistoryViewProps) {
    const sessionsById = useChatStore((s) => s.sessionsById);
    const sessionOrder = useChatStore((s) => s.sessionOrder);
    const runtimes = useChatStore((s) => s.runtimes);
    const deleteSession = useChatStore((s) => s.deleteSession);
    const forkSession = useChatStore((s) => s.forkSession);
    const renameSession = useChatStore((s) => s.renameSession);
    const ensureTranscriptLoaded = useChatStore(
        (s) => s.ensureSessionTranscriptLoaded,
    );
    const historyRetentionDays = useChatStore((s) => s.historyRetentionDays);
    const setHistoryRetentionDays = useChatStore(
        (s) => s.setHistoryRetentionDays,
    );

    const notes = useVaultStore((s) => s.notes);
    const createNote = useVaultStore((s) => s.createNote);
    const openNote = useEditorStore((s) => s.openNote);

    const runtimeOptions = useMemo(
        () => runtimes.map((d) => d.runtime),
        [runtimes],
    );

    // --- Delete confirmation ---
    const [deleteConfirmIds, setDeleteConfirmIds] = useState<string[]>([]);

    const sessions = useMemo(
        () =>
            sessionOrder
                .map((id) => sessionsById[id])
                .filter(Boolean) as NonNullable<
                (typeof sessionsById)[string]
            >[],
        [sessionsById, sessionOrder],
    );
    const selectedSession = useMemo(
        () =>
            findSessionForHistorySelection(
                sessionsById,
                selectedHistorySessionId,
            ),
        [selectedHistorySessionId, sessionsById],
    );

    // --- Resizer state ---
    const [listWidth, setListWidth] = useState(DEFAULT_LIST_WIDTH);
    const sessionRef = useRef<ResizeSession | null>(null);
    const frameRef = useRef<number | null>(null);
    const pendingWidthRef = useRef(DEFAULT_LIST_WIDTH);
    const listPanelRef = useRef<HTMLDivElement>(null);

    const scheduleWidth = useCallback(() => {
        if (frameRef.current != null) return;
        frameRef.current = requestAnimationFrame(() => {
            frameRef.current = null;
            const w = Math.max(
                MIN_LIST_WIDTH,
                Math.min(MAX_LIST_WIDTH, pendingWidthRef.current),
            );
            if (listPanelRef.current) {
                listPanelRef.current.style.width = `${w}px`;
            }
        });
    }, []);

    const finishResize = useCallback(() => {
        if (frameRef.current != null) {
            cancelAnimationFrame(frameRef.current);
            frameRef.current = null;
        }
        const final = Math.max(
            MIN_LIST_WIDTH,
            Math.min(MAX_LIST_WIDTH, pendingWidthRef.current),
        );
        setListWidth(final);
        sessionRef.current = null;
        document.body.classList.remove("resizing-sidebar");
    }, []);

    const onResizerDown = useCallback(
        (e: React.PointerEvent) => {
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            sessionRef.current = {
                pointerId: e.pointerId,
                startX: e.clientX,
                startWidth: listWidth,
            };
            pendingWidthRef.current = listWidth;
            document.body.classList.add("resizing-sidebar");
        },
        [listWidth],
    );

    const onResizerMove = useCallback(
        (e: React.PointerEvent) => {
            if (!sessionRef.current) return;
            const delta = e.clientX - sessionRef.current.startX;
            pendingWidthRef.current = sessionRef.current.startWidth + delta;
            scheduleWidth();
        },
        [scheduleWidth],
    );

    const onResizerUp = useCallback(
        (e: React.PointerEvent) => {
            if (!sessionRef.current) return;
            e.currentTarget.releasePointerCapture(e.pointerId);
            finishResize();
        },
        [finishResize],
    );

    const handleDeleteSession = useCallback((sessionId: string) => {
        setDeleteConfirmIds([sessionId]);
    }, []);

    const handleDeleteSessions = useCallback((sessionIds: string[]) => {
        setDeleteConfirmIds(Array.from(new Set(sessionIds)));
    }, []);

    const confirmDelete = useCallback(() => {
        if (deleteConfirmIds.length === 0) return;
        if (
            selectedSession?.sessionId &&
            deleteConfirmIds.includes(selectedSession.sessionId)
        ) {
            onSelectHistorySessionId(null);
        }
        void (async () => {
            for (const sessionId of deleteConfirmIds) {
                await deleteSession(sessionId);
            }
        })();
        setDeleteConfirmIds([]);
    }, [
        deleteConfirmIds,
        deleteSession,
        selectedSession,
        onSelectHistorySessionId,
    ]);

    const cancelDelete = useCallback(() => {
        setDeleteConfirmIds([]);
    }, []);
    const preservedSubagentCount = useMemo(() => {
        if (deleteConfirmIds.length === 0) return 0;
        const deletedSessionIds = new Set(deleteConfirmIds);
        const deletedRefs = new Set<string>();

        for (const sessionId of deleteConfirmIds) {
            const session = sessionsById[sessionId];
            for (const ref of [
                session?.sessionId,
                session?.historySessionId,
                session?.runtimeSessionId,
            ]) {
                const trimmed = ref?.trim();
                if (trimmed) {
                    deletedRefs.add(trimmed);
                }
            }
        }

        return Object.values(sessionsById).filter((session) => {
            if (!session || deletedSessionIds.has(session.sessionId)) {
                return false;
            }
            const parentRef = session.parentSessionId?.trim();
            return parentRef ? deletedRefs.has(parentRef) : false;
        }).length;
    }, [deleteConfirmIds, sessionsById]);

    const handleExportSession = useCallback(
        (sessionId: string) => {
            void (async () => {
                const transcriptLoaded = await ensureTranscriptLoaded(
                    sessionId,
                    "full",
                );
                if (!transcriptLoaded) return;

                const session = useChatStore.getState().sessionsById[sessionId];
                if (!session) return;

                await exportChatSessionToVaultNote({
                    session,
                    runtimes: runtimeOptions,
                    notes,
                    createNote,
                    openNote,
                });
            })().catch((error) => {
                console.error("Failed to export chat session:", error);
            });
        },
        [ensureTranscriptLoaded, runtimeOptions, notes, createNote, openNote],
    );

    const handleRestoreSession = useCallback(
        (historySessionId: string) => {
            if (onRestoreHistorySession) {
                onRestoreHistorySession(historySessionId);
                return;
            }

            const session = findSessionForHistorySelection(
                sessionsById,
                historySessionId,
            );
            if (!session) return;

            openChatSessionInWorkspace(session.sessionId);
            onRequestClose?.();
        },
        [onRequestClose, onRestoreHistorySession, sessionsById],
    );

    return (
        <div
            className="flex h-full min-h-0 flex-col"
            style={{ backgroundColor: "var(--bg-secondary)" }}
        >
            {/* Header */}
            <div
                className="flex shrink-0 items-center gap-2 px-3 py-1"
                style={{ borderBottom: "1px solid var(--border)" }}
            >
                {showBackButton ? (
                    <button
                        type="button"
                        onClick={() => onRequestClose?.()}
                        className="flex h-6 w-6 items-center justify-center rounded"
                        style={{
                            background: "none",
                            border: "none",
                            color: "var(--text-secondary)",
                        }}
                        title="Back to chat"
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
                        >
                            <path d="M10 3L5 8l5 5" />
                        </svg>
                    </button>
                ) : null}
                <span
                    className="flex-1 text-xs font-medium"
                    style={{ color: "var(--text-primary)" }}
                >
                    Chat History
                </span>
                <span
                    className="shrink-0 text-[10px]"
                    style={{ color: "var(--text-secondary)", opacity: 0.7 }}
                >
                    Keep:
                </span>
                <select
                    className="shrink-0 rounded px-1.5 py-0.5 text-[10px]"
                    style={{
                        background: "var(--bg-primary)",
                        color: "var(--text-primary)",
                        border: "1px solid var(--border)",
                        outline: "none",
                    }}
                    value={historyRetentionDays}
                    onChange={(e) =>
                        void setHistoryRetentionDays(Number(e.target.value))
                    }
                >
                    <option value={0}>Forever</option>
                    <option value={7}>7 days</option>
                    <option value={30}>30 days</option>
                    <option value={90}>90 days</option>
                    <option value={365}>1 year</option>
                </select>
            </div>

            {/* Master-detail body */}
            <div className="flex min-h-0 flex-1">
                {/* Session list (master) */}
                <div
                    ref={listPanelRef}
                    className="shrink-0"
                    style={{
                        width: listWidth,
                        borderRight: "1px solid var(--border)",
                    }}
                >
                    <HistorySessionList
                        sessions={sessions}
                        runtimes={runtimeOptions}
                        selectedSessionId={selectedHistorySessionId}
                        onSelectSession={onSelectHistorySessionId}
                        onRestoreSession={handleRestoreSession}
                        onDeleteSession={handleDeleteSession}
                        onDeleteSessions={handleDeleteSessions}
                        onForkSession={forkSession}
                        onExportSession={handleExportSession}
                        onRenameSession={renameSession}
                    />
                </div>

                {/* Resizer */}
                <div
                    className="relative shrink-0 cursor-col-resize touch-none"
                    style={{
                        width: RESIZER_HITBOX,
                        marginLeft: -RESIZER_OVERLAP,
                        marginRight: -RESIZER_OVERLAP,
                        zIndex: 2,
                    }}
                    onPointerDown={onResizerDown}
                    onPointerMove={onResizerMove}
                    onPointerUp={onResizerUp}
                >
                    <div
                        className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2"
                        style={{
                            backgroundColor: "var(--border)",
                            opacity: 0.5,
                        }}
                    />
                </div>

                {/* Transcript viewer (detail) */}
                <div className="min-w-0 flex-1">
                    {selectedHistorySessionId ? (
                        <HistoryTranscriptViewer
                            historySessionId={selectedHistorySessionId}
                            onRestore={() =>
                                handleRestoreSession(selectedHistorySessionId)
                            }
                            onExport={() =>
                                selectedSession
                                    ? handleExportSession(
                                          selectedSession.sessionId,
                                      )
                                    : undefined
                            }
                        />
                    ) : (
                        <div
                            className="flex h-full items-center justify-center text-xs"
                            style={{ color: "var(--text-secondary)" }}
                        >
                            Select a conversation to view
                        </div>
                    )}
                </div>
            </div>

            {/* Delete confirmation dialog */}
            {deleteConfirmIds.length > 0 && (
                <DeleteConfirmDialog
                    sessionTitles={deleteConfirmIds
                        .map((sessionId) =>
                            getDeleteSessionTitle(sessionsById[sessionId]),
                        )
                        .filter(Boolean)}
                    preservedSubagentCount={preservedSubagentCount}
                    onConfirm={confirmDelete}
                    onCancel={cancelDelete}
                />
            )}
        </div>
    );
}

function getDeleteSessionTitle(
    session:
        | { customTitle?: string | null; persistedTitle?: string | null }
        | undefined,
) {
    if (!session) return "this conversation";
    return (
        session.customTitle?.trim() ||
        session.persistedTitle?.trim() ||
        "this conversation"
    );
}

function DeleteConfirmDialog({
    sessionTitles,
    preservedSubagentCount,
    onConfirm,
    onCancel,
}: {
    sessionTitles: string[];
    preservedSubagentCount: number;
    onConfirm: () => void;
    onCancel: () => void;
}) {
    const isBatchDelete = sessionTitles.length > 1;

    return (
        <div
            className="absolute inset-0 z-50 flex items-center justify-center"
            style={{ backgroundColor: "rgba(0, 0, 0, 0.4)" }}
            onClick={onCancel}
        >
            <div
                className="mx-4 flex max-w-sm flex-col gap-3 rounded-lg p-4 shadow-lg"
                style={{
                    backgroundColor: "var(--bg-secondary)",
                    border: "1px solid var(--border)",
                }}
                onClick={(e) => e.stopPropagation()}
            >
                <div
                    className="text-sm font-medium"
                    style={{ color: "var(--text-primary)" }}
                >
                    {isBatchDelete
                        ? `Delete ${sessionTitles.length} conversations?`
                        : "Delete conversation?"}
                </div>
                <div
                    className="text-xs leading-relaxed"
                    style={{ color: "var(--text-secondary)" }}
                >
                    {isBatchDelete
                        ? `${sessionTitles.length} conversations will be permanently deleted. This cannot be undone.`
                        : `\u201c${sessionTitles[0]}\u201d will be permanently deleted. This cannot be undone.`}
                    {preservedSubagentCount > 0 ? (
                        <span className="mt-2 block">
                            {preservedSubagentCount}{" "}
                            {preservedSubagentCount === 1
                                ? "subagent"
                                : "subagents"}{" "}
                            will stay in history as detached agents.
                        </span>
                    ) : null}
                </div>
                <div className="flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={onCancel}
                        className="rounded px-3 py-1.5 text-xs font-medium"
                        style={{
                            background: "none",
                            border: "1px solid var(--border)",
                            color: "var(--text-primary)",
                        }}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        className="rounded px-3 py-1.5 text-xs font-medium"
                        style={{
                            backgroundColor: "#dc2626",
                            border: "1px solid #dc2626",
                            color: "#fff",
                        }}
                    >
                        Delete
                    </button>
                </div>
            </div>
        </div>
    );
}
