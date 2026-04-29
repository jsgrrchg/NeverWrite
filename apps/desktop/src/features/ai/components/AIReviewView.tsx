import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    useEditorStore,
    isReviewTab,
    selectEditorPaneActiveTab,
    type ReviewTab,
} from "../../../app/store/editorStore";
import { useSettingsStore } from "../../../app/store/settingsStore";
import { useVaultStore } from "../../../app/store/vaultStore";
import { EditedFilesReviewList } from "./EditedFilesReviewList";
import {
    getAccentButtonStyle,
    getDangerButtonStyle,
    getNeutralButtonStyle,
} from "./editedFilesReviewStyles";
import {
    deriveReviewItems,
    deriveReviewSummary,
} from "../diff/editedFilesPresentationModel";
import { useEditedFilesReviewExpansion } from "./useEditedFilesReviewExpansion";
import { formatDiffStat } from "../diff/reviewDiff";
import { DiffZoomControls } from "./DiffZoomControls";
import { getFileOperation } from "../store/actionLogModel";
import { useChatStore } from "../store/chatStore";
import {
    selectHasUndoReject,
    selectVisibleTrackedFiles,
} from "../store/editedFilesBufferModel";
import { canOpenAiEditedFileByAbsolutePath } from "../chatFileNavigation";
import {
    createPersistedReviewAnchor,
    getReviewViewStorageKey,
    persistReviewViewState,
    readPersistedReviewViewState,
    resolvePersistedReviewAnchor,
    type PersistedReviewAnchor,
} from "./reviewTabPersistence";
import { subscribeSafeStorage } from "../../../app/utils/safeStorage";

/* ------------------------------------------------------------------ */
/*  Empty state                                                        */
/* ------------------------------------------------------------------ */

function ReviewEmptyState({
    hasUndo,
    onUndo,
}: {
    hasUndo?: boolean;
    onUndo?: () => void;
}) {
    return (
        <div className="flex h-full flex-col items-center justify-center gap-3">
            <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--text-secondary)"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ opacity: 0.45 }}
            >
                <path d="M9 12l2 2 4-4" />
                <circle cx="12" cy="12" r="10" />
            </svg>
            <div className="flex flex-col items-center gap-1 text-center">
                <div
                    style={{
                        fontSize: "0.85em",
                        fontWeight: 500,
                        color: "var(--text-secondary)",
                    }}
                >
                    No pending AI edits
                </div>
                <div
                    style={{
                        fontSize: "0.75em",
                        color: "var(--text-secondary)",
                        opacity: 0.6,
                        lineHeight: 1.5,
                    }}
                >
                    New edits will appear here automatically.
                </div>
            </div>
            {hasUndo && onUndo && (
                <button
                    type="button"
                    onClick={onUndo}
                    className="review-action-btn rounded-md px-3 py-1.5 text-xs"
                    style={{
                        fontWeight: 500,
                        ...getNeutralButtonStyle(),
                    }}
                >
                    Undo Last Reject
                </button>
            )}
        </div>
    );
}

/* ------------------------------------------------------------------ */
/*  Stat chips row                                                     */
/* ------------------------------------------------------------------ */

const REVIEW_ACTION_LABEL_STYLE: React.CSSProperties = {
    fontSize: "10.5px",
    fontWeight: 600,
    lineHeight: "16px",
    letterSpacing: "0.04em",
    textTransform: "uppercase",
};

function StatChips({
    summary,
}: {
    summary: {
        fileCount: number;
        additions: number;
        deletions: number;
        approximate: boolean;
        conflictCount: number;
    };
}) {
    const statStyle: React.CSSProperties = {
        fontSize: "0.72em",
        color: "var(--text-secondary)",
        opacity: 0.78,
        whiteSpace: "nowrap",
    };
    return (
        <div className="flex flex-wrap items-baseline gap-2">
            <span style={statStyle}>
                {summary.fileCount} {summary.fileCount === 1 ? "file" : "files"}
            </span>
            {summary.additions > 0 && (
                <span style={{ ...statStyle, color: "var(--diff-add)" }}>
                    +{formatDiffStat(summary.additions, summary.approximate)}
                </span>
            )}
            {summary.deletions > 0 && (
                <span style={{ ...statStyle, color: "var(--diff-remove)" }}>
                    -{formatDiffStat(summary.deletions, summary.approximate)}
                </span>
            )}
            {summary.conflictCount > 0 && (
                <span style={{ ...statStyle, color: "var(--diff-warn)" }}>
                    {summary.conflictCount}{" "}
                    {summary.conflictCount === 1 ? "conflict" : "conflicts"}
                </span>
            )}
        </div>
    );
}

/* ------------------------------------------------------------------ */
/*  Root                                                               */
/* ------------------------------------------------------------------ */

interface AIReviewViewProps {
    paneId?: string;
}

export function AIReviewView({ paneId }: AIReviewViewProps) {
    const tab = useEditorStore((state) => {
        const current = selectEditorPaneActiveTab(state, paneId);
        return current && isReviewTab(current) ? current : null;
    });

    if (!tab) {
        return (
            <div
                className="flex h-full items-center justify-center"
                style={{ color: "var(--text-secondary)" }}
            >
                No review tab active
            </div>
        );
    }

    return <ReviewContent key={tab.id} tab={tab} />;
}

/* ------------------------------------------------------------------ */
/*  Main content                                                       */
/* ------------------------------------------------------------------ */

function ReviewContent({ tab }: { tab: ReviewTab }) {
    const vaultPath = useVaultStore((state) => state.vaultPath);
    const visibleEntries = useChatStore((state) =>
        selectVisibleTrackedFiles(state, tab.sessionId),
    );
    const rejectEditedFile = useChatStore((state) => state.rejectEditedFile);
    const keepEditedFile = useChatStore((state) => state.keepEditedFile);
    const rejectAllEditedFiles = useChatStore(
        (state) => state.rejectAllEditedFiles,
    );
    const keepAllEditedFiles = useChatStore(
        (state) => state.keepAllEditedFiles,
    );
    const resolveReviewHunks = useChatStore(
        (state) => state.resolveReviewHunks,
    );
    const hasActionLog = useChatStore((state) => {
        const session = state.sessionsById[tab.sessionId];
        return !!session?.actionLog;
    });
    const undoLastReject = useChatStore((state) => state.undoLastReject);
    const hasUndoReject = useChatStore((state) =>
        selectHasUndoReject(state, tab.sessionId),
    );
    const editDiffZoom = useChatStore((state) => state.editDiffZoom);
    const setEditDiffZoom = useChatStore((state) => state.setEditDiffZoom);
    const lineWrapping = useSettingsStore((state) => state.lineWrapping);
    const entries = useVaultStore((state) => state.entries);
    const notes = useVaultStore((state) => state.notes);
    const [persistVersion, setPersistVersion] = useState(0);
    const reviewStorageKey = useMemo(
        () => getReviewViewStorageKey(vaultPath, tab.sessionId),
        [tab.sessionId, vaultPath],
    );
    const persistedState = useMemo(
        () => readPersistedReviewViewState(vaultPath, tab.sessionId),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- persistVersion invalidates cache on storage events
        [persistVersion, tab.sessionId, vaultPath],
    );

    const openablePathSet = useMemo(
        () =>
            new Set(
                visibleEntries
                    .filter((file) => getFileOperation(file) !== "delete")
                    .filter((file) =>
                        canOpenAiEditedFileByAbsolutePath(file.path),
                    )
                    .map((file) => file.path),
            ),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- entries/notes/vaultPath invalidate canOpenAiEditedFileByAbsolutePath which reads from getState()
        [entries, notes, vaultPath, visibleEntries],
    );

    const items = useMemo(
        () => deriveReviewItems(visibleEntries, openablePathSet),
        [visibleEntries, openablePathSet],
    );
    const initialAnchor = useMemo(
        () =>
            resolvePersistedReviewAnchor(persistedState?.anchor ?? null, items),
        [items, persistedState?.anchor],
    );
    const summary = useMemo(() => deriveReviewSummary(items), [items]);
    const rejectableCount = items.filter((item) => item.canReject).length;
    const expansion = useEditedFilesReviewExpansion(items, {
        initialExpandedKeys: (() => {
            if (!persistedState?.expandedIdentityKeys) {
                return null;
            }
            const keys = new Set(persistedState.expandedIdentityKeys);
            if (initialAnchor) {
                keys.add(initialAnchor.identityKey);
            }
            return keys;
        })(),
    });
    const [wideMode, setWideMode] = useState(false);
    const scrollContainerRef = useRef<HTMLDivElement | null>(null);
    const persistedAnchorRef = useRef<PersistedReviewAnchor | null>(
        initialAnchor,
    );
    const reviewWriterIdRef = useRef(crypto.randomUUID());
    const lastSeenPersistedUpdatedAtRef = useRef<number>(0);
    const didRunPersistEffectRef = useRef(false);
    const restoreAppliedRef = useRef(false);
    const scrollPersistTimerRef = useRef<number | null>(null);
    const storageRefreshTimerRef = useRef<number | null>(null);
    const pendingScrollTopRef = useRef<number | null>(null);
    const persistViewState = useCallback(
        (nextScrollTop?: number) => {
            const persisted = persistReviewViewState(
                vaultPath,
                tab.sessionId,
                {
                    expandedIdentityKeys: expansion.expandedKeys,
                    scrollTop:
                        nextScrollTop ??
                        scrollContainerRef.current?.scrollTop ??
                        persistedState?.scrollTop ??
                        0,
                    anchor: persistedAnchorRef.current,
                },
                {
                    baseUpdatedAt: lastSeenPersistedUpdatedAtRef.current,
                    writerId: reviewWriterIdRef.current,
                },
            );
            if (persisted) {
                lastSeenPersistedUpdatedAtRef.current = persisted.updatedAt;
            }
        },
        [
            expansion.expandedKeys,
            persistedState?.scrollTop,
            tab.sessionId,
            vaultPath,
        ],
    );

    const flushScheduledScrollPersist = useCallback(() => {
        if (scrollPersistTimerRef.current != null) {
            window.clearTimeout(scrollPersistTimerRef.current);
            scrollPersistTimerRef.current = null;
        }
        pendingScrollTopRef.current = null;
    }, []);

    const schedulePersistedStateRefresh = useCallback(() => {
        if (storageRefreshTimerRef.current != null) {
            return;
        }

        storageRefreshTimerRef.current = window.setTimeout(() => {
            storageRefreshTimerRef.current = null;
            setPersistVersion((current) => current + 1);
        }, 80);
    }, []);

    const schedulePersistFromScroll = useCallback(
        (scrollTop: number) => {
            pendingScrollTopRef.current = scrollTop;
            if (scrollPersistTimerRef.current != null) {
                return;
            }
            scrollPersistTimerRef.current = window.setTimeout(() => {
                scrollPersistTimerRef.current = null;
                const nextScrollTop = pendingScrollTopRef.current;
                pendingScrollTopRef.current = null;
                persistViewState(nextScrollTop ?? scrollTop);
            }, 120);
        },
        [persistViewState],
    );

    useEffect(() => {
        if (persistedState?.updatedAt) {
            lastSeenPersistedUpdatedAtRef.current = Math.max(
                lastSeenPersistedUpdatedAtRef.current,
                persistedState.updatedAt,
            );
        }
    }, [persistedState?.updatedAt]);

    useEffect(() => {
        return subscribeSafeStorage((event) => {
            if (event.key !== reviewStorageKey || !event.newValue) {
                return;
            }
            try {
                const parsed = JSON.parse(event.newValue) as {
                    writerId?: string;
                    updatedAt?: number;
                };
                if (parsed.writerId === reviewWriterIdRef.current) {
                    return;
                }
                if (typeof parsed.updatedAt !== "number") {
                    return;
                }
                if (parsed.updatedAt <= lastSeenPersistedUpdatedAtRef.current) {
                    return;
                }
                lastSeenPersistedUpdatedAtRef.current = parsed.updatedAt;
            } catch {
                // Ignore malformed storage payloads from other windows.
                return;
            }
            schedulePersistedStateRefresh();
        });
    }, [reviewStorageKey, schedulePersistedStateRefresh]);

    useEffect(() => {
        if (!didRunPersistEffectRef.current) {
            didRunPersistEffectRef.current = true;
            return;
        }
        persistViewState();
    }, [persistViewState]);

    useEffect(() => {
        if (persistedAnchorRef.current == null && initialAnchor) {
            persistedAnchorRef.current = initialAnchor;
        }
    }, [initialAnchor]);

    useEffect(() => {
        if (restoreAppliedRef.current || items.length === 0) {
            return;
        }

        const container = scrollContainerRef.current;
        if (!container) {
            return;
        }

        restoreAppliedRef.current = true;
        if (persistedState?.scrollTop) {
            container.scrollTop = persistedState.scrollTop;
        }

        const anchor = resolvePersistedReviewAnchor(
            persistedState?.anchor ?? null,
            items,
        );
        if (!anchor) {
            return;
        }

        const hunkTarget = Array.from(
            container.querySelectorAll<HTMLElement>("[data-review-hunk-key]"),
        ).find((element) => {
            const reviewFileKey = element.dataset.reviewFileKey;
            const trackedVersion = Number(
                element.dataset.reviewTrackedVersion ?? "",
            );
            const reviewHunkKey = element.dataset.reviewHunkKey;
            return (
                reviewFileKey === anchor.identityKey &&
                trackedVersion === anchor.trackedVersion &&
                !!reviewHunkKey &&
                anchor.hunkKeys.includes(reviewHunkKey)
            );
        });
        if (hunkTarget) {
            hunkTarget.scrollIntoView({ block: "center" });
            return;
        }

        const fileTarget = Array.from(
            container.querySelectorAll<HTMLElement>("[data-review-file-key]"),
        ).find(
            (element) => element.dataset.reviewFileKey === anchor.identityKey,
        );
        fileTarget?.scrollIntoView({ block: "center" });
    }, [items, persistedState]);

    useEffect(() => {
        if (persistedState?.anchor == null || items.length === 0) {
            return;
        }

        const anchor = resolvePersistedReviewAnchor(
            persistedState.anchor,
            items,
        );
        if (anchor) {
            return;
        }

        persistedAnchorRef.current = null;
        persistViewState();
    }, [items, persistViewState, persistedState?.anchor]);

    useEffect(
        () => () => {
            flushScheduledScrollPersist();
            if (storageRefreshTimerRef.current != null) {
                window.clearTimeout(storageRefreshTimerRef.current);
                storageRefreshTimerRef.current = null;
            }
            persistViewState();
        },
        [flushScheduledScrollPersist, persistViewState],
    );

    if (items.length === 0) {
        return (
            <ReviewEmptyState
                hasUndo={hasUndoReject}
                onUndo={() => void undoLastReject(tab.sessionId)}
            />
        );
    }

    return (
        <div
            className="flex h-full flex-col overflow-hidden"
            style={{ backgroundColor: "var(--bg-primary)" }}
        >
            {/* ---- Header ---- */}
            <div
                className="shrink-0 px-6 py-1.5"
                style={{
                    backgroundColor:
                        "color-mix(in srgb, var(--bg-secondary) 60%, transparent)",
                    borderBottom:
                        "1px solid color-mix(in srgb, var(--border) 50%, transparent)",
                }}
            >
                <div
                    className={`mx-auto w-full ${wideMode ? "" : "max-w-3xl"}`}
                >
                    <div className="flex items-center justify-between gap-4">
                        <div className="flex items-center gap-3 min-w-0">
                            <h1
                                className="uppercase"
                                style={{
                                    color: "var(--text-secondary)",
                                    fontSize: "0.68em",
                                    letterSpacing: "0.12em",
                                    fontWeight: 600,
                                    margin: 0,
                                }}
                            >
                                Pending Changes
                            </h1>
                            <StatChips summary={summary} />
                        </div>

                        {/* Global actions */}
                        <div className="flex shrink-0 items-center gap-1">
                            <div className="flex items-center gap-0.5 pr-1">
                                <DiffZoomControls
                                    accent="var(--text-primary)"
                                    zoom={editDiffZoom}
                                    onZoomChange={setEditDiffZoom}
                                />
                            </div>
                            {hasUndoReject && (
                                <button
                                    type="button"
                                    onClick={() =>
                                        void undoLastReject(tab.sessionId)
                                    }
                                    className="review-action-btn rounded-sm px-2 py-0.5"
                                    style={{
                                        ...getNeutralButtonStyle(),
                                        ...REVIEW_ACTION_LABEL_STYLE,
                                    }}
                                    title="Undo last reject"
                                >
                                    Undo
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={
                                    expansion.allExpanded
                                        ? expansion.collapseAll
                                        : expansion.expandAll
                                }
                                className="review-action-btn rounded-sm px-2 py-0.5"
                                style={{
                                    ...getNeutralButtonStyle(),
                                    ...REVIEW_ACTION_LABEL_STYLE,
                                }}
                            >
                                {expansion.allExpanded ? "Collapse" : "Expand"}
                            </button>
                            <button
                                type="button"
                                onClick={() => setWideMode((prev) => !prev)}
                                className="review-action-btn rounded-sm px-2 py-0.5"
                                style={{
                                    ...getNeutralButtonStyle(),
                                    ...REVIEW_ACTION_LABEL_STYLE,
                                }}
                                title={
                                    wideMode
                                        ? "Center cards"
                                        : "Expand cards to full width"
                                }
                            >
                                {wideMode ? "Center" : "Wide"}
                            </button>
                            <button
                                type="button"
                                onClick={() =>
                                    void rejectAllEditedFiles(tab.sessionId)
                                }
                                disabled={rejectableCount === 0}
                                className="review-action-btn rounded-sm px-2 py-0.5"
                                style={{
                                    ...getDangerButtonStyle(
                                        rejectableCount === 0,
                                    ),
                                    ...REVIEW_ACTION_LABEL_STYLE,
                                }}
                            >
                                Reject All
                            </button>
                            <button
                                type="button"
                                onClick={() =>
                                    keepAllEditedFiles(tab.sessionId)
                                }
                                className="review-action-btn rounded-sm px-2 py-0.5"
                                style={{
                                    ...getAccentButtonStyle(),
                                    ...REVIEW_ACTION_LABEL_STYLE,
                                }}
                            >
                                Keep All
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {/* ---- Scrollable file list ---- */}
            <div
                ref={scrollContainerRef}
                data-testid="ai-review-scroll-container"
                className="flex-1 overflow-auto px-6 py-4"
                onScroll={(event) =>
                    schedulePersistFromScroll(event.currentTarget.scrollTop)
                }
            >
                <div
                    className={`mx-auto flex w-full flex-col gap-2.5 ${wideMode ? "" : "max-w-3xl"}`}
                >
                    <EditedFilesReviewList
                        items={items}
                        variant="full"
                        diffZoom={editDiffZoom}
                        lineWrapping={lineWrapping}
                        expandedKeys={expansion.expandedKeys}
                        onToggleItem={expansion.toggleFile}
                        onKeepItem={(identityKey) =>
                            keepEditedFile(tab.sessionId, identityKey)
                        }
                        onRejectItem={(identityKey) =>
                            void rejectEditedFile(tab.sessionId, identityKey)
                        }
                        onResolveReviewHunks={
                            hasActionLog
                                ? (
                                      identityKey,
                                      decision,
                                      trackedVersion,
                                      hunkIds,
                                  ) => {
                                      const trackedFile = items.find(
                                          (item) =>
                                              item.file.identityKey ===
                                              identityKey,
                                      )?.file;
                                      persistedAnchorRef.current = trackedFile
                                          ? createPersistedReviewAnchor(
                                                trackedFile,
                                                trackedVersion,
                                                hunkIds,
                                            )
                                          : {
                                                identityKey,
                                                trackedVersion,
                                                hunkKeys: hunkIds.map(
                                                    (hunkId) => hunkId.key,
                                                ),
                                            };
                                      persistViewState();
                                      void resolveReviewHunks(
                                          tab.sessionId,
                                          identityKey,
                                          decision,
                                          trackedVersion,
                                          hunkIds,
                                      );
                                  }
                                : undefined
                        }
                    />
                </div>
            </div>
        </div>
    );
}
