import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    useEditorStore,
    isReviewTab,
    type ReviewTab,
} from "../../../app/store/editorStore";
import { useSettingsStore } from "../../../app/store/settingsStore";
import { useVaultStore } from "../../../app/store/vaultStore";
import { EditedFilesReviewList } from "./EditedFilesReviewList";
import {
    getAccentButtonStyle,
    getDangerButtonStyle,
    getNeutralButtonStyle,
    getStatChipStyle,
} from "./editedFilesReviewStyles";
import {
    deriveReviewItems,
    deriveReviewSummary,
} from "../diff/editedFilesPresentationModel";
import { useEditedFilesReviewExpansion } from "./useEditedFilesReviewExpansion";
import {
    DIFF_ZOOM_MAX,
    DIFF_ZOOM_MIN,
    DIFF_ZOOM_STEP,
    formatDiffStat,
    stepDiffZoom,
} from "../diff/reviewDiff";
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
        <div
            className="flex h-full flex-col items-center justify-center"
            style={{ backgroundColor: "var(--bg-primary)" }}
        >
            <div
                className="flex flex-col items-center gap-4 rounded-2xl px-10 py-12"
                style={{
                    backgroundColor: "var(--bg-secondary)",
                    border: "1px solid var(--border)",
                    boxShadow: "var(--shadow-soft)",
                    maxWidth: 380,
                }}
            >
                <div
                    className="flex items-center justify-center rounded-xl"
                    style={{
                        width: 48,
                        height: 48,
                        backgroundColor:
                            "color-mix(in srgb, var(--accent) 10%, var(--bg-tertiary))",
                    }}
                >
                    <svg
                        width="24"
                        height="24"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="var(--accent)"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <path d="M9 12l2 2 4-4" />
                        <circle cx="12" cy="12" r="10" />
                    </svg>
                </div>
                <div className="flex flex-col items-center gap-1 text-center">
                    <div
                        style={{
                            fontSize: "0.92em",
                            fontWeight: 600,
                            color: "var(--text-primary)",
                        }}
                    >
                        No pending AI edits
                    </div>
                    <div
                        style={{
                            fontSize: "0.8em",
                            color: "var(--text-secondary)",
                            lineHeight: 1.5,
                        }}
                    >
                        All changes have been resolved.
                        <br />
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
        </div>
    );
}

/* ------------------------------------------------------------------ */
/*  Stat chips row                                                     */
/* ------------------------------------------------------------------ */

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
    return (
        <div className="flex flex-wrap items-center gap-1.5">
            <span style={getStatChipStyle()}>
                {summary.fileCount} {summary.fileCount === 1 ? "file" : "files"}
            </span>
            {summary.additions > 0 && (
                <span style={getStatChipStyle("var(--diff-add)")}>
                    +{formatDiffStat(summary.additions, summary.approximate)}
                </span>
            )}
            {summary.deletions > 0 && (
                <span style={getStatChipStyle("var(--diff-remove)")}>
                    -{formatDiffStat(summary.deletions, summary.approximate)}
                </span>
            )}
            {summary.conflictCount > 0 && (
                <span style={getStatChipStyle("var(--diff-warn)")}>
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

export function AIReviewView() {
    const tab = useEditorStore((state) => {
        const current = state.tabs.find(
            (candidate) => candidate.id === state.activeTabId,
        );
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
    const canDecreaseZoom = editDiffZoom > DIFF_ZOOM_MIN;
    const canIncreaseZoom = editDiffZoom < DIFF_ZOOM_MAX;

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
                className="shrink-0 px-6 py-3"
                style={{
                    backgroundColor: "var(--bg-secondary)",
                    borderBottom:
                        "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
                }}
            >
                <div
                    className={`mx-auto w-full ${wideMode ? "" : "max-w-3xl"}`}
                >
                    <div className="flex items-center justify-between gap-4">
                        <div className="flex items-center gap-3 min-w-0">
                            <h1
                                className="text-sm font-semibold"
                                style={{ color: "var(--text-primary)" }}
                            >
                                Pending Changes
                            </h1>
                            <StatChips summary={summary} />
                        </div>

                        {/* Global actions */}
                        <div className="flex shrink-0 items-center gap-1.5">
                            <div
                                className="flex items-center rounded-md"
                                style={{
                                    border: "1px solid color-mix(in srgb, var(--border) 82%, transparent)",
                                    backgroundColor:
                                        "color-mix(in srgb, var(--bg-primary) 48%, transparent)",
                                }}
                            >
                                <button
                                    type="button"
                                    aria-label="Decrease diff zoom"
                                    title="Decrease diff zoom"
                                    disabled={!canDecreaseZoom}
                                    onClick={() =>
                                        setEditDiffZoom(
                                            stepDiffZoom(
                                                editDiffZoom,
                                                -DIFF_ZOOM_STEP,
                                            ),
                                        )
                                    }
                                    className="rounded-l-md px-2 py-1 text-xs"
                                    style={{
                                        color: canDecreaseZoom
                                            ? "var(--text-primary)"
                                            : "var(--text-secondary)",
                                        opacity: canDecreaseZoom ? 1 : 0.45,
                                        backgroundColor: "transparent",
                                        border: "none",
                                        cursor: canDecreaseZoom
                                            ? "pointer"
                                            : "not-allowed",
                                    }}
                                >
                                    -
                                </button>
                                <button
                                    type="button"
                                    aria-label="Increase diff zoom"
                                    title="Increase diff zoom"
                                    disabled={!canIncreaseZoom}
                                    onClick={() =>
                                        setEditDiffZoom(
                                            stepDiffZoom(
                                                editDiffZoom,
                                                DIFF_ZOOM_STEP,
                                            ),
                                        )
                                    }
                                    className="rounded-r-md px-2 py-1 text-xs"
                                    style={{
                                        color: canIncreaseZoom
                                            ? "var(--text-primary)"
                                            : "var(--text-secondary)",
                                        opacity: canIncreaseZoom ? 1 : 0.45,
                                        backgroundColor: "transparent",
                                        border: "none",
                                        cursor: canIncreaseZoom
                                            ? "pointer"
                                            : "not-allowed",
                                    }}
                                >
                                    +
                                </button>
                            </div>
                            {hasUndoReject && (
                                <button
                                    type="button"
                                    onClick={() =>
                                        void undoLastReject(tab.sessionId)
                                    }
                                    className="review-action-btn rounded-md px-2 py-1 text-xs"
                                    style={{
                                        fontWeight: 500,
                                        ...getNeutralButtonStyle(),
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
                                className="review-action-btn rounded-md px-2 py-1 text-xs"
                                style={{
                                    fontWeight: 500,
                                    ...getNeutralButtonStyle(),
                                }}
                            >
                                {expansion.allExpanded ? "Collapse" : "Expand"}
                            </button>
                            <button
                                type="button"
                                onClick={() => setWideMode((prev) => !prev)}
                                className="review-action-btn rounded-md px-2 py-1 text-xs"
                                style={{
                                    fontWeight: 500,
                                    ...getNeutralButtonStyle(),
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
                                className="review-action-btn rounded-md px-2 py-1 text-xs"
                                style={{
                                    fontWeight: 600,
                                    ...getDangerButtonStyle(
                                        rejectableCount === 0,
                                    ),
                                }}
                            >
                                Reject All
                            </button>
                            <button
                                type="button"
                                onClick={() =>
                                    keepAllEditedFiles(tab.sessionId)
                                }
                                className="review-action-btn rounded-md px-2.5 py-1 text-xs"
                                style={{
                                    fontWeight: 600,
                                    ...getAccentButtonStyle(),
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
