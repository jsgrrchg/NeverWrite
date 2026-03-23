import { useEffect, useMemo, useRef, useState } from "react";
import { useEditorStore } from "../../../app/store/editorStore";
import { useVaultStore } from "../../../app/store/vaultStore";
import { formatDiffStat } from "../diff/reviewDiff";
import { getReviewTabTitle } from "../sessionPresentation";
import { useChatStore } from "../store/chatStore";
import {
    selectHasUndoReject,
    selectVisibleTrackedFiles,
} from "../store/editedFilesBufferModel";
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
import { canOpenAiEditedFileEntry } from "../chatFileNavigation";

const COMPACT_MAX_LIST_HEIGHT = "208px";
const UNDO_ONLY_BANNER_TIMEOUT_MS = 5000;

function CollapseToggle({
    expanded,
    onToggle,
}: {
    expanded: boolean;
    onToggle: () => void;
}) {
    return (
        <button
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse edits" : "Expand edits"}
            title={expanded ? "Collapse edits" : "Expand edits"}
            onClick={onToggle}
            className="shrink-0"
            style={{
                width: 16,
                height: 16,
                border: "none",
                padding: 0,
                cursor: "pointer",
                background: "transparent",
                color: "var(--text-secondary)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 12,
                lineHeight: 1,
                transition: "transform 140ms ease, color 140ms ease",
                transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            }}
        >
            <span aria-hidden="true">&gt;</span>
        </button>
    );
}

export function EditedFilesBufferPanel({
    sessionId: sessionIdProp,
}: {
    sessionId?: string | null;
}) {
    const [collapsed, setCollapsed] = useState(false);
    const activeSessionId = useChatStore(
        (state) => sessionIdProp ?? state.activeSessionId,
    );
    const activeSession = useChatStore((state) =>
        activeSessionId ? (state.sessionsById[activeSessionId] ?? null) : null,
    );
    const runtimes = useChatStore((state) => state.runtimes);
    const openReview = useEditorStore((state) => state.openReview);
    const visibleEntries = useChatStore((state) =>
        selectVisibleTrackedFiles(state, activeSessionId),
    );
    const keepEditedFile = useChatStore((state) => state.keepEditedFile);
    const rejectEditedFile = useChatStore((state) => state.rejectEditedFile);
    const resolveEditedFileWithMergedText = useChatStore(
        (state) => state.resolveEditedFileWithMergedText,
    );
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
        if (!activeSessionId) return false;
        const session = state.sessionsById[activeSessionId];
        return !!session?.actionLog;
    });
    const undoLastReject = useChatStore((state) => state.undoLastReject);
    const hasUndoReject = useChatStore((state) =>
        selectHasUndoReject(state, activeSessionId),
    );
    const undoRejectTimestamp = useChatStore((state) =>
        activeSessionId
            ? (state.sessionsById[activeSessionId]?.actionLog?.lastRejectUndo
                  ?.timestamp ?? null)
            : null,
    );
    const editDiffZoom = useChatStore((state) => state.editDiffZoom);
    const entries = useVaultStore((state) => state.entries);
    const [autoDismissedBannerKey, setAutoDismissedBannerKey] = useState<
        string | null
    >(null);
    const dismissedUndoBannerKeysRef = useRef<Set<string>>(new Set());

    const openablePathSet = useMemo(
        () =>
            new Set(
                entries
                    .filter((entry) => canOpenAiEditedFileEntry(entry))
                    .map((entry) => entry.path),
            ),
        [entries],
    );
    const items = useMemo(
        () => deriveReviewItems(visibleEntries, openablePathSet),
        [visibleEntries, openablePathSet],
    );
    const summary = useMemo(() => deriveReviewSummary(items), [items]);
    const rejectableCount = items.filter((item) => item.canReject).length;
    const isUndoOnly = items.length === 0 && hasUndoReject;
    const undoOnlyBannerKey =
        activeSessionId && undoRejectTimestamp
            ? `${activeSessionId}:${undoRejectTimestamp}`
            : null;

    const showUndoOnlyBanner =
        isUndoOnly &&
        !!undoOnlyBannerKey &&
        autoDismissedBannerKey !== undoOnlyBannerKey;

    useEffect(() => {
        if (!isUndoOnly || !undoOnlyBannerKey) return;
        if (dismissedUndoBannerKeysRef.current.has(undoOnlyBannerKey)) return;

        const timeoutId = window.setTimeout(() => {
            dismissedUndoBannerKeysRef.current.add(undoOnlyBannerKey);
            setAutoDismissedBannerKey(undoOnlyBannerKey);
        }, UNDO_ONLY_BANNER_TIMEOUT_MS);

        return () => {
            window.clearTimeout(timeoutId);
        };
    }, [isUndoOnly, undoOnlyBannerKey]);

    if (!activeSessionId || (items.length === 0 && !hasUndoReject)) {
        return null;
    }

    // Only undo available, no pending items — minimal undo-only strip
    if (isUndoOnly) {
        if (!showUndoOnlyBanner) {
            return null;
        }

        return (
            <section
                className="mx-3 mb-2 overflow-hidden rounded-xl"
                style={{
                    border: "1px solid color-mix(in srgb, var(--border) 88%, transparent)",
                    backgroundColor:
                        "color-mix(in srgb, var(--bg-tertiary) 84%, transparent)",
                }}
            >
                <div className="flex items-center gap-1.5 px-2 py-1.5">
                    <button
                        type="button"
                        title="Undo last reject"
                        onClick={() => void undoLastReject(activeSessionId)}
                        className="review-action-btn rounded-md p-1"
                        style={getNeutralButtonStyle()}
                    >
                        <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <polyline points="1 4 1 10 7 10" />
                            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                        </svg>
                    </button>
                    <span
                        className="text-xs"
                        style={{ color: "var(--text-secondary)" }}
                    >
                        Undo last reject
                    </span>
                </div>
            </section>
        );
    }

    return (
        <section
            className="mx-3 mb-2 overflow-hidden rounded-xl"
            style={{
                border: "1px solid color-mix(in srgb, var(--border) 88%, transparent)",
                backgroundColor:
                    "color-mix(in srgb, var(--bg-tertiary) 84%, transparent)",
            }}
        >
            <div
                className="flex items-center gap-1.5 px-2 py-1.5"
                style={{
                    borderBottom: !collapsed
                        ? "1px solid color-mix(in srgb, var(--border) 80%, transparent)"
                        : "none",
                }}
            >
                <CollapseToggle
                    expanded={!collapsed}
                    onToggle={() => setCollapsed((value) => !value)}
                />
                <span
                    className="text-xs font-medium"
                    style={{ color: "var(--text-secondary)" }}
                >
                    Edits
                </span>
                <span
                    style={{
                        fontSize: "0.72em",
                        color: "var(--text-secondary)",
                    }}
                >
                    ({summary.fileCount})
                </span>
                {(summary.additions > 0 || summary.deletions > 0) && (
                    <span
                        style={{
                            fontSize: "0.72em",
                            color: "var(--text-secondary)",
                        }}
                    >
                        ·
                        {summary.additions > 0 ? (
                            <span
                                style={{
                                    color: "var(--diff-add)",
                                    marginLeft: 3,
                                }}
                            >
                                +
                                {formatDiffStat(
                                    summary.additions,
                                    summary.approximate,
                                )}
                            </span>
                        ) : null}
                        {summary.deletions > 0 ? (
                            <span
                                style={{
                                    color: "var(--diff-remove)",
                                    marginLeft: 3,
                                }}
                            >
                                -
                                {formatDiffStat(
                                    summary.deletions,
                                    summary.approximate,
                                )}
                            </span>
                        ) : null}
                    </span>
                )}

                <div className="ml-auto flex items-center gap-1">
                    {/* Undo last reject — undo icon */}
                    {hasUndoReject && (
                        <button
                            type="button"
                            title="Undo last reject"
                            onClick={() => void undoLastReject(activeSessionId)}
                            className="rounded-md p-1"
                            style={getNeutralButtonStyle()}
                        >
                            <svg
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <polyline points="1 4 1 10 7 10" />
                                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                            </svg>
                        </button>
                    )}
                    {/* Review All — text button */}
                    <button
                        type="button"
                        title="Review All"
                        onClick={() =>
                            openReview(activeSessionId, {
                                title: getReviewTabTitle(
                                    activeSession,
                                    runtimes,
                                ),
                            })
                        }
                        className="review-action-btn rounded-md px-2 py-0.5"
                        style={{
                            ...getNeutralButtonStyle(),
                            fontSize: "11px",
                            fontWeight: 500,
                            lineHeight: "16px",
                        }}
                    >
                        Review
                    </button>
                    {/* Reject All — X icon */}
                    <button
                        type="button"
                        title="Reject All"
                        onClick={() =>
                            void rejectAllEditedFiles(activeSessionId)
                        }
                        disabled={rejectableCount === 0}
                        className="review-action-btn rounded-md p-1"
                        style={getDangerButtonStyle(rejectableCount === 0)}
                    >
                        <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                    {/* Keep All — checkmark icon */}
                    <button
                        type="button"
                        title="Keep All"
                        onClick={() => keepAllEditedFiles(activeSessionId)}
                        className="review-action-btn rounded-md p-1"
                        style={getAccentButtonStyle()}
                    >
                        <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <polyline points="20 6 9 17 4 12" />
                        </svg>
                    </button>
                </div>
            </div>

            {!collapsed ? (
                <div
                    data-testid="edited-files-buffer-list"
                    data-scrollbar-active="true"
                    className="flex flex-col"
                    style={{
                        maxHeight: COMPACT_MAX_LIST_HEIGHT,
                        overflowY: "auto",
                    }}
                >
                    <EditedFilesReviewList
                        items={items}
                        variant="compact"
                        diffZoom={editDiffZoom}
                        onKeepItem={(identityKey) =>
                            keepEditedFile(activeSessionId, identityKey)
                        }
                        onRejectItem={(identityKey) =>
                            void rejectEditedFile(activeSessionId, identityKey)
                        }
                        onResolveHunks={(identityKey, mergedText) =>
                            void resolveEditedFileWithMergedText(
                                activeSessionId,
                                identityKey,
                                mergedText,
                            )
                        }
                        onResolveReviewHunks={
                            hasActionLog
                                ? (
                                      identityKey,
                                      decision,
                                      trackedVersion,
                                      hunkIds,
                                  ) =>
                                      void resolveReviewHunks(
                                          activeSessionId,
                                          identityKey,
                                          decision,
                                          trackedVersion,
                                          hunkIds,
                                      )
                                : undefined
                        }
                    />
                </div>
            ) : null}
        </section>
    );
}
