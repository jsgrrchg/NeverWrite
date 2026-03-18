import { useState } from "react";
import { openAiEditedFileByAbsolutePath } from "../chatFileNavigation";
import { EditedFileDiffPreview } from "./editedFilesPresentation";
import {
    formatDiffStat,
    getCompactPath,
    getFileNameFromPath,
} from "../diff/reviewDiff";
import type { ReviewFileItem } from "../diff/editedFilesPresentationModel";
import {
    getAccentButtonStyle,
    getDangerButtonStyle,
    getNeutralButtonStyle,
} from "./editedFilesReviewStyles";

/* ------------------------------------------------------------------ */
/*  Full variant (review tab)                                          */
/* ------------------------------------------------------------------ */

function FullRowActions({
    item,
    expanded,
    diffZoom,
    onKeep,
    onReject,
    onResolveHunks,
    onResolveHunk,
}: {
    item: ReviewFileItem;
    expanded: boolean;
    diffZoom: number;
    onKeep: () => void;
    onReject: () => void;
    onResolveHunks: (mergedText: string) => void;
    onResolveHunk?: (
        decision: "accepted" | "rejected",
        hunkNewStart: number,
        hunkNewEnd: number,
    ) => void;
}) {
    const { file, canResolveHunks, diff } = item;

    return (
        <EditedFileDiffPreview
            diff={diff}
            expanded={expanded}
            diffZoom={diffZoom}
            compactLineNumbers
            file={file}
            onKeep={onKeep}
            onReject={onReject}
            onResolveHunks={
                canResolveHunks
                    ? (_, mergedText) => onResolveHunks(mergedText)
                    : undefined
            }
            onResolveHunk={
                canResolveHunks && onResolveHunk
                    ? (_, decision, hunkNewStart, hunkNewEnd) =>
                          onResolveHunk(decision, hunkNewStart, hunkNewEnd)
                    : undefined
            }
            testId={`edited-buffer-diff:${file.identityKey}`}
        />
    );
}

function FullRow({
    item,
    expanded,
    diffZoom,
    onToggle,
    onKeep,
    onReject,
    onResolveHunks,
    onResolveHunk,
}: {
    item: ReviewFileItem;
    expanded: boolean;
    diffZoom: number;
    onToggle: () => void;
    onKeep: () => void;
    onReject: () => void;
    onResolveHunks: (mergedText: string) => void;
    onResolveHunk?: (
        decision: "accepted" | "rejected",
        hunkNewStart: number,
        hunkNewEnd: number,
    ) => void;
}) {
    const { file, tone, summary, canOpen, canReject, stats } = item;
    const compactPath = getCompactPath(file.path);

    return (
        <div
            className="overflow-hidden rounded-xl"
            style={{
                border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
                backgroundColor: "var(--bg-elevated)",
            }}
        >
            {/* Card header */}
            <div
                className="flex w-full items-center gap-3 px-4 py-2.5"
                style={{
                    borderBottom: expanded
                        ? "1px solid color-mix(in srgb, var(--border) 40%, transparent)"
                        : "none",
                }}
            >
                {/* Caret (clickable toggle) */}
                <button
                    type="button"
                    onClick={onToggle}
                    style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 20,
                        height: 20,
                        borderRadius: 5,
                        fontSize: "0.68em",
                        color: "var(--text-secondary)",
                        backgroundColor:
                            "color-mix(in srgb, var(--bg-tertiary) 70%, transparent)",
                        flexShrink: 0,
                        transition: "transform 140ms ease",
                        transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
                        border: "none",
                        cursor: "pointer",
                    }}
                >
                    ▸
                </button>

                {/* Dot */}
                <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: tone.accent }}
                />

                {/* File info (clickable toggle) */}
                <button
                    type="button"
                    onClick={onToggle}
                    className="min-w-0 flex-1 text-left"
                    style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                    }}
                >
                    <div className="flex items-center gap-2">
                        <span
                            className="truncate"
                            style={{
                                fontSize: "0.86em",
                                fontWeight: 600,
                                color: "var(--text-primary)",
                            }}
                        >
                            {getFileNameFromPath(file.path)}
                        </span>
                        {tone.badge ? (
                            <span
                                className="rounded-full px-1.5 py-px"
                                style={{
                                    fontSize: "0.64em",
                                    fontWeight: 700,
                                    textTransform: "uppercase",
                                    letterSpacing: "0.04em",
                                    color: tone.accent,
                                    backgroundColor: `color-mix(in srgb, ${tone.accent} 10%, transparent)`,
                                }}
                            >
                                {tone.badge}
                            </span>
                        ) : null}
                    </div>
                    <div
                        className="truncate"
                        style={{
                            marginTop: 1,
                            fontSize: "0.74em",
                            color: "var(--text-secondary)",
                        }}
                    >
                        {compactPath} · {summary}
                    </div>
                </button>

                {/* Diff stats */}
                <div
                    className="flex shrink-0 items-center gap-1.5"
                    style={{ fontSize: "0.76em" }}
                >
                    {stats.additions > 0 ? (
                        <span
                            style={{
                                color: "var(--diff-add)",
                                fontWeight: 600,
                            }}
                        >
                            +
                            {formatDiffStat(stats.additions, stats.approximate)}
                        </span>
                    ) : null}
                    {stats.deletions > 0 ? (
                        <span
                            style={{
                                color: "var(--diff-remove)",
                                fontWeight: 600,
                            }}
                        >
                            -
                            {formatDiffStat(stats.deletions, stats.approximate)}
                        </span>
                    ) : null}
                </div>

                {/* Inline action buttons */}
                <div className="flex shrink-0 items-center gap-1">
                    {canOpen ? (
                        <button
                            type="button"
                            title="Open File"
                            onClick={() =>
                                void openAiEditedFileByAbsolutePath(file.path)
                            }
                            className="shrink-0 rounded-md p-1"
                            style={getNeutralButtonStyle()}
                        >
                            <svg
                                width="13"
                                height="13"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                                <polyline points="15 3 21 3 21 9" />
                                <line x1="10" y1="14" x2="21" y2="3" />
                            </svg>
                        </button>
                    ) : null}
                    <button
                        type="button"
                        title="Keep"
                        onClick={onKeep}
                        className="shrink-0 rounded-md p-1"
                        style={getAccentButtonStyle()}
                    >
                        <svg
                            width="13"
                            height="13"
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
                    {canReject ? (
                        <button
                            type="button"
                            title="Reject"
                            onClick={onReject}
                            className="shrink-0 rounded-md p-1"
                            style={getDangerButtonStyle()}
                        >
                            <svg
                                width="13"
                                height="13"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <line x1="18" y1="6" x2="6" y2="18" />
                                <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                        </button>
                    ) : null}
                </div>
            </div>

            {/* Expanded content */}
            {expanded ? (
                <FullRowActions
                    item={item}
                    expanded={expanded}
                    diffZoom={diffZoom}
                    onKeep={onKeep}
                    onReject={onReject}
                    onResolveHunks={onResolveHunks}
                    onResolveHunk={onResolveHunk}
                />
            ) : null}
        </div>
    );
}

/* ------------------------------------------------------------------ */
/*  Compact variant (chat sidebar panel)                               */
/* ------------------------------------------------------------------ */

function CompactRow({
    item,
    diffZoom,
    onKeep,
    onReject,
    onResolveHunks,
    onResolveHunk,
}: {
    item: ReviewFileItem;
    diffZoom: number;
    onKeep: () => void;
    onReject: () => void;
    onResolveHunks: (mergedText: string) => void;
    onResolveHunk?: (
        decision: "accepted" | "rejected",
        hunkNewStart: number,
        hunkNewEnd: number,
    ) => void;
}) {
    const [expanded, setExpanded] = useState(false);
    const { file, tone, canOpen, canReject, canResolveHunks, diff, stats } =
        item;

    return (
        <div
            className="overflow-hidden"
            style={{
                borderTop:
                    "1px solid color-mix(in srgb, var(--border) 72%, transparent)",
            }}
        >
            <div className="flex items-center gap-2.5 px-2.5 py-1.5">
                <div
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: tone.accent }}
                />
                <span
                    className="min-w-0 flex-1 truncate"
                    style={{
                        fontSize: "0.84em",
                        fontWeight: 600,
                        color: "var(--text-primary)",
                    }}
                >
                    {getFileNameFromPath(file.path)}
                    {tone.badge ? (
                        <span
                            className="ml-1.5 rounded-full px-1.5 py-0.5"
                            style={{
                                fontSize: "0.8em",
                                fontWeight: 700,
                                textTransform: "uppercase",
                                letterSpacing: "0.04em",
                                color: tone.accent,
                                backgroundColor: `color-mix(in srgb, ${tone.accent} 12%, transparent)`,
                            }}
                        >
                            {tone.badge}
                        </span>
                    ) : null}
                </span>
                <div
                    className="flex shrink-0 items-center gap-1 text-right"
                    style={{ fontSize: "0.76em" }}
                >
                    {stats.additions > 0 ? (
                        <div
                            style={{
                                color: "var(--diff-add)",
                                fontWeight: 600,
                            }}
                        >
                            +
                            {formatDiffStat(stats.additions, stats.approximate)}
                        </div>
                    ) : null}
                    {stats.deletions > 0 ? (
                        <div
                            style={{
                                color: "var(--diff-remove)",
                                fontWeight: 600,
                            }}
                        >
                            -
                            {formatDiffStat(stats.deletions, stats.approximate)}
                        </div>
                    ) : null}
                </div>
                {/* Open File — external-link icon */}
                <button
                    type="button"
                    title="Open File"
                    onClick={() => {
                        if (!canOpen) return;
                        void openAiEditedFileByAbsolutePath(file.path);
                    }}
                    disabled={!canOpen}
                    className="shrink-0 rounded-md p-1"
                    style={{
                        ...getAccentButtonStyle(
                            canOpen ? tone.accent : "var(--text-secondary)",
                        ),
                        opacity: canOpen ? 1 : 0.45,
                        cursor: canOpen ? "pointer" : "not-allowed",
                    }}
                >
                    <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                        <polyline points="15 3 21 3 21 9" />
                        <line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
                </button>
                {/* Review Diff — diff/code icon */}
                <button
                    type="button"
                    title={expanded ? "Hide Diff" : "Review Diff"}
                    onClick={() => setExpanded((value) => !value)}
                    className="shrink-0 rounded-md p-1"
                    style={getNeutralButtonStyle()}
                >
                    <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <polyline points="16 18 22 12 16 6" />
                        <polyline points="8 6 2 12 8 18" />
                    </svg>
                </button>
                {/* Keep — checkmark icon */}
                <button
                    type="button"
                    title="Keep"
                    onClick={onKeep}
                    className="shrink-0 rounded-md p-1"
                    style={getAccentButtonStyle()}
                >
                    <svg
                        width="12"
                        height="12"
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
                {/* Reject — X icon */}
                {canReject ? (
                    <button
                        type="button"
                        title="Reject"
                        onClick={onReject}
                        className="shrink-0 rounded-md p-1"
                        style={getDangerButtonStyle()}
                    >
                        <svg
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                ) : null}
            </div>
            <EditedFileDiffPreview
                diff={diff}
                expanded={expanded}
                diffZoom={diffZoom}
                file={file}
                onKeep={onKeep}
                onReject={onReject}
                onResolveHunks={
                    canResolveHunks
                        ? (_, mergedText) => onResolveHunks(mergedText)
                        : undefined
                }
                onResolveHunk={
                    canResolveHunks && onResolveHunk
                        ? (_, decision, hunkNewStart, hunkNewEnd) =>
                              onResolveHunk(decision, hunkNewStart, hunkNewEnd)
                        : undefined
                }
                testId={`edited-buffer-diff:${file.identityKey}`}
            />
        </div>
    );
}

/* ------------------------------------------------------------------ */
/*  Public component                                                   */
/* ------------------------------------------------------------------ */

export function EditedFilesReviewList({
    items,
    variant,
    diffZoom,
    expandedKeys,
    onToggleItem,
    onKeepItem,
    onRejectItem,
    onResolveHunks,
    onResolveHunk,
}: {
    items: ReviewFileItem[];
    variant: "full" | "compact";
    diffZoom: number;
    expandedKeys?: Set<string>;
    onToggleItem?: (identityKey: string) => void;
    onKeepItem?: (identityKey: string) => void;
    onRejectItem: (identityKey: string) => void;
    onResolveHunks?: (identityKey: string, mergedText: string) => void;
    onResolveHunk?: (
        identityKey: string,
        decision: "accepted" | "rejected",
        hunkNewStart: number,
        hunkNewEnd: number,
    ) => void;
}) {
    if (variant === "compact") {
        return (
            <>
                {items.map((item) => (
                    <CompactRow
                        key={item.file.identityKey}
                        item={item}
                        diffZoom={diffZoom}
                        onKeep={() => onKeepItem?.(item.file.identityKey)}
                        onReject={() => onRejectItem(item.file.identityKey)}
                        onResolveHunks={(mergedText) =>
                            onResolveHunks?.(item.file.identityKey, mergedText)
                        }
                        onResolveHunk={
                            onResolveHunk
                                ? (decision, s, e) =>
                                      onResolveHunk(
                                          item.file.identityKey,
                                          decision,
                                          s,
                                          e,
                                      )
                                : undefined
                        }
                    />
                ))}
            </>
        );
    }

    return (
        <>
            {items.map((item) => (
                <FullRow
                    key={item.file.identityKey}
                    item={item}
                    expanded={expandedKeys?.has(item.file.identityKey) ?? false}
                    diffZoom={diffZoom}
                    onToggle={() => onToggleItem?.(item.file.identityKey)}
                    onKeep={() => onKeepItem?.(item.file.identityKey)}
                    onReject={() => onRejectItem(item.file.identityKey)}
                    onResolveHunks={(mergedText) =>
                        onResolveHunks?.(item.file.identityKey, mergedText)
                    }
                    onResolveHunk={
                        onResolveHunk
                            ? (decision, s, e) =>
                                  onResolveHunk(
                                      item.file.identityKey,
                                      decision,
                                      s,
                                      e,
                                  )
                            : undefined
                    }
                />
            ))}
        </>
    );
}
