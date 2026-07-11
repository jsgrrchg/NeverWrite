import { useMemo, useState } from "react";

import {
    ContextMenu,
    type ContextMenuState,
} from "../../../components/context-menu/ContextMenu";
import {
    computeDiffLines,
    computeFileDiffStats,
    formatDiffStat,
    getFileNameFromPath,
} from "../diff/reviewDiff";
import { FileTypeIcon } from "../../../components/icons/FileTypeIcon";
import { DiffZoomControls } from "./DiffZoomControls";
import { EditedFileDiffPreview } from "./editedFilesPresentation";
import { ResizableDiffContainer } from "./ResizableDiffContainer";
import {
    canOpenAiEditedFileByAbsolutePath,
    openAiEditedFileByAbsolutePath,
} from "../chatFileNavigation";
import { useChatRowUiEntry } from "./chatRowUiPresentation";
import type { AIChatMessage, AIFileDiff } from "../types";
import { MarkdownContent } from "./MarkdownContent";
import type { ChatPillMetrics } from "./chatPillMetrics";

interface ChangeReviewToolRailProps {
    readonly diffs: readonly AIFileDiff[];
    readonly diffZoom: number;
    readonly lineWrapping: boolean;
    readonly message: AIChatMessage;
    readonly onDiffZoomChange: (zoom: number) => void;
    readonly sessionId?: string | null;
}

interface OpenFileContextMenuPayload {
    readonly target: string;
}

type MarkdownPreviewBlock = {
    content: string;
    lineNumbers: number[];
};

const DIFF_PREVIEW_PILL_METRICS: ChatPillMetrics = {
    fontSize: 12,
    lineHeight: 1.3,
    paddingX: 6,
    paddingY: 1,
    radius: 6,
    gapX: 2,
    maxWidth: 180,
    offsetY: 0,
};

function isMarkdownPath(path: string) {
    return /\.(?:md|mdx|markdown)$/i.test(path);
}

function getMarkdownPreviewBlocks(diff: AIFileDiff): MarkdownPreviewBlock[] {
    const blocks: MarkdownPreviewBlock[] = [];
    let pendingLines: ReturnType<typeof computeDiffLines> = [];

    const flushPendingLines = () => {
        if (pendingLines.length === 0) return;

        // Prefer the new side of a modified hunk. Rendering a whole Markdown
        // block lets tables, lists, and other multi-line structures retain
        // their syntax instead of treating each changed line in isolation.
        const hasAdditions = pendingLines.some((line) => line.type === "add");
        const displayLines = pendingLines.filter(
            (line) =>
                line.type === "context" ||
                line.type === (hasAdditions ? "add" : "remove"),
        );

        if (displayLines.length > 0) {
            blocks.push({
                content: displayLines.map((line) => line.text).join("\n"),
                lineNumbers: displayLines.map(
                    (line) =>
                        (hasAdditions
                            ? line.newLineNumber
                            : line.oldLineNumber) ?? 0,
                ),
            });
        }

        pendingLines = [];
    };

    for (const line of computeDiffLines(diff)) {
        if (line.type === "separator") {
            flushPendingLines();
            continue;
        }
        pendingLines.push(line);
    }

    flushPendingLines();
    return blocks;
}

function MarkdownChangePreview({
    blocks,
}: {
    blocks: readonly MarkdownPreviewBlock[];
}) {
    return (
        <div
            data-testid="markdown-diff-preview"
            className="flex flex-col py-1"
            style={{
                color: "var(--text-primary)",
                fontSize: "1.06em",
                lineHeight: 1.55,
            }}
        >
            {blocks.map((block, index) => {
                return (
                    <section
                        key={`${block.lineNumbers[0] ?? "block"}:${index}`}
                        data-markdown-preview-block="true"
                        style={{
                            display: "grid",
                            gridTemplateColumns: "44px minmax(0, 1fr)",
                        }}
                    >
                        <div
                            style={{
                                padding: "0 6px 0 4px",
                                borderRight:
                                    "1px solid color-mix(in srgb, var(--border) 50%, transparent)",
                                color: "var(--text-secondary)",
                                fontSize: "0.85em",
                                opacity: 0.55,
                                textAlign: "right",
                                userSelect: "none",
                            }}
                        >
                            {block.lineNumbers.map((lineNumber, lineIndex) => (
                                <div key={`${lineNumber}:${lineIndex}`}>
                                    {lineNumber || ""}
                                </div>
                            ))}
                        </div>
                        <MarkdownContent
                            blockQuoteAppearance="plain"
                            className="min-w-0 px-2"
                            content={block.content}
                            fileReferenceAppearance="link"
                            pillMetrics={DIFF_PREVIEW_PILL_METRICS}
                        />
                    </section>
                );
            })}
        </div>
    );
}

function Chevron({ expanded }: { readonly expanded: boolean }) {
    return (
        <svg
            aria-hidden="true"
            fill="none"
            height="10"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            style={{
                transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
                transition: "transform 140ms ease",
            }}
            viewBox="0 0 24 24"
            width="10"
        >
            <polyline points="8 6 14 12 8 18" />
        </svg>
    );
}

function WarningIcon() {
    return (
        <svg
            aria-hidden="true"
            fill="none"
            height="14"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
            viewBox="0 0 24 24"
            width="14"
        >
            <path d="M12 3 2 21h20L12 3Z" />
            <path d="M12 9v4" />
            <circle cx="12" cy="17" fill="currentColor" r="0.75" />
        </svg>
    );
}

function getToolActionLabel(toolKind: string) {
    switch (toolKind.toLowerCase()) {
        case "create":
        case "write":
            return "Created";
        case "delete":
        case "remove":
            return "Deleted";
        case "move":
        case "rename":
            return "Moved";
        default:
            return "Edited";
    }
}

function getDiffBadge(diff: AIFileDiff) {
    if (diff.reversible === false) return "Partial";
    if (diff.kind === "add") return "New file";
    if (diff.kind === "delete") return "Deleted";
    if (diff.kind === "move") {
        const previous = diff.previous_path
            ? getFileNameFromPath(diff.previous_path)
            : null;
        return previous ? `Moved from ${previous}` : "Moved";
    }
    return null;
}

function getAccent(toolKind: string, status: string) {
    if (status === "failed" || status === "error") return "#f87171";
    if (toolKind === "delete" || toolKind === "remove") {
        return "var(--diff-remove)";
    }
    return "var(--accent)";
}

function ChangeReviewToolRailRow({
    diff,
    diffZoom,
    expanded,
    lineWrapping,
    message,
    onDiffZoomChange,
    onToggle,
}: {
    readonly diff: AIFileDiff;
    readonly diffZoom: number;
    readonly expanded: boolean;
    readonly lineWrapping: boolean;
    readonly message: AIChatMessage;
    readonly onDiffZoomChange: (zoom: number) => void;
    readonly onToggle: () => void;
}) {
    const [contextMenu, setContextMenu] =
        useState<ContextMenuState<OpenFileContextMenuPayload> | null>(null);
    const markdownPreviewBlocks = useMemo(
        () => (isMarkdownPath(diff.path) ? getMarkdownPreviewBlocks(diff) : []),
        [diff],
    );
    const [showMarkdownPreview, setShowMarkdownPreview] = useState(
        () => markdownPreviewBlocks.length > 0,
    );
    const toolKind = String(message.meta?.tool ?? "").toLowerCase();
    const status = String(message.meta?.status ?? "").toLowerCase();
    const fileName = getFileNameFromPath(diff.path);
    const actionLabel = getToolActionLabel(toolKind);
    const accent = getAccent(toolKind, status);
    const stats = computeFileDiffStats(diff);
    const badge = getDiffBadge(diff);
    const openPath =
        diff.kind === "delete"
            ? null
            : (message.meta?.target ? String(message.meta.target) : diff.path);
    const canOpen = openPath
        ? canOpenAiEditedFileByAbsolutePath(openPath)
        : false;
    const isFailed = status === "failed" || status === "error";
    const isInProgress = status === "in_progress" || status === "pending";

    return (
        <div
            className="min-w-0 max-w-full select-none"
            data-change-review-path={diff.path}
            data-change-review-surface="rail-row"
            style={{
                color: "var(--text-secondary)",
                fontFamily: "var(--font-mono), ui-monospace, monospace",
                fontSize: "0.82em",
            }}
        >
            <div className="flex min-h-7 w-full min-w-0 items-center gap-1 px-2">
                <span className="flex shrink-0 items-center gap-1">
                    <span
                        aria-hidden="true"
                        className="flex w-3.5 shrink-0 items-center justify-center"
                        data-change-review-operation-icon="true"
                        style={{
                            color: isFailed ? accent : "var(--text-secondary)",
                        }}
                    >
                        {isFailed ? (
                            <WarningIcon />
                        ) : (
                            <FileTypeIcon
                                fileName={fileName}
                                size={13}
                                opacity={0.86}
                            />
                        )}
                    </span>
                    <span
                        aria-hidden="true"
                        className="flex w-3.5 shrink-0 items-center justify-center"
                    />
                </span>
                <span className="shrink-0 opacity-70">{actionLabel}</span>
                {canOpen && openPath ? (
                    <button
                        aria-label={`Open ${openPath}`}
                        className="min-w-0 truncate text-left text-text-primary underline decoration-text-secondary/40 underline-offset-2 hover:decoration-current focus-visible:rounded-sm focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--accent)]"
                        onClick={() => void openAiEditedFileByAbsolutePath(openPath)}
                        onContextMenu={(event) => {
                            event.preventDefault();
                            setContextMenu({
                                x: event.clientX,
                                y: event.clientY,
                                payload: { target: openPath },
                            });
                        }}
                        title={openPath}
                        type="button"
                    >
                        {fileName}
                    </button>
                ) : (
                    <span
                        className="min-w-0 truncate text-text-primary"
                        title={diff.path}
                    >
                        {fileName}
                    </span>
                )}
                <span className="min-w-0 flex-1" />
                {badge ? (
                    <span
                        className="shrink-0 text-[10px] font-medium"
                        style={{
                            color:
                                diff.reversible === false
                                    ? "#b45309"
                                    : diff.kind === "delete"
                                      ? "var(--diff-remove)"
                                      : diff.kind === "add"
                                        ? "var(--diff-add)"
                                        : "var(--text-secondary)",
                        }}
                    >
                        {badge}
                    </span>
                ) : null}
                {stats.additions > 0 ? (
                    <span
                        className="shrink-0 font-bold"
                        style={{ color: "var(--diff-add)", fontSize: "0.9em" }}
                    >
                        +{formatDiffStat(stats.additions, stats.approximate)}
                    </span>
                ) : null}
                {stats.deletions > 0 ? (
                    <span
                        className="shrink-0 font-bold"
                        style={{ color: "var(--diff-remove)", fontSize: "0.9em" }}
                    >
                        -{formatDiffStat(stats.deletions, stats.approximate)}
                    </span>
                ) : null}
                <DiffZoomControls
                    accent={accent}
                    onZoomChange={onDiffZoomChange}
                    zoom={diffZoom}
                />
                {markdownPreviewBlocks.length > 0 ? (
                    <button
                        type="button"
                        aria-label={
                            showMarkdownPreview
                                ? "Show source diff"
                                : "Show markdown preview"
                        }
                        title={
                            showMarkdownPreview
                                ? "Show source diff"
                                : "Show markdown preview"
                        }
                        onClick={() =>
                            setShowMarkdownPreview((current) => !current)
                        }
                        className="p-0 text-[10px] font-medium hover:text-text-primary focus-visible:outline-none focus-visible:underline"
                        style={{
                            border: "none",
                            color: "var(--text-secondary)",
                            backgroundColor: "transparent",
                            cursor: "pointer",
                        }}
                    >
                        {showMarkdownPreview ? "View" : "Preview"}
                    </button>
                ) : null}
                {isInProgress ? (
                    <span
                        aria-label="Running"
                        className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full"
                        style={{ backgroundColor: "var(--accent)" }}
                    />
                ) : null}
                {isFailed ? (
                    <span
                        className="shrink-0 text-[10px] font-semibold uppercase"
                        style={{ color: "#f87171" }}
                    >
                        Failed
                    </span>
                ) : null}
                <button
                    aria-label={`${expanded ? "Collapse" : "Expand"} inline diff review`}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-secondary hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--accent)]"
                    onClick={onToggle}
                    type="button"
                >
                    <Chevron expanded={expanded} />
                </button>
            </div>

            {expanded ? (
                <div className="ml-5 mt-1 overflow-hidden pl-2">
                    <ResizableDiffContainer accent={accent}>
                        {showMarkdownPreview && markdownPreviewBlocks.length > 0 ? (
                            <MarkdownChangePreview blocks={markdownPreviewBlocks} />
                        ) : (
                            <EditedFileDiffPreview
                                compactContextLines={0}
                                compactLineNumbers
                                diff={diff}
                                diffZoom={diffZoom}
                                expanded={expanded}
                                lineWrapping={lineWrapping}
                                showWhenEmpty={false}
                                testId={`diff-content:${diff.path}`}
                            />
                        )}
                    </ResizableDiffContainer>
                </div>
            ) : null}
            {contextMenu ? (
                <ContextMenu
                    entries={[
                        {
                            label: "Open",
                            action: () => {
                                void openAiEditedFileByAbsolutePath(
                                    contextMenu.payload.target,
                                );
                            },
                        },
                        {
                            label: "Open in New Tab",
                            action: () => {
                                void openAiEditedFileByAbsolutePath(
                                    contextMenu.payload.target,
                                    { newTab: true },
                                );
                            },
                        },
                    ]}
                    menu={contextMenu}
                    onClose={() => setContextMenu(null)}
                />
            ) : null}
        </div>
    );
}

export function ChangeReviewToolRail({
    diffs,
    diffZoom,
    lineWrapping,
    message,
    onDiffZoomChange,
    sessionId,
}: ChangeReviewToolRailProps) {
    const { rowState, updateRow } = useChatRowUiEntry(sessionId, message.id);
    const isSingleFile = diffs.length === 1;

    return (
        <div className="space-y-1" data-change-review-tool-rail="true">
            {diffs.map((diff) => {
                const expanded = isSingleFile
                    ? (rowState?.singleDiffExpanded ?? false)
                    : (rowState?.diffExpandedByPath?.[diff.path] ?? false);

                return (
                    <ChangeReviewToolRailRow
                        diff={diff}
                        diffZoom={diffZoom}
                        expanded={expanded}
                        key={diff.path}
                        lineWrapping={lineWrapping}
                        message={message}
                        onDiffZoomChange={onDiffZoomChange}
                        onToggle={() =>
                            updateRow((current) =>
                                isSingleFile
                                    ? {
                                          singleDiffExpanded: !(
                                              current.singleDiffExpanded ?? false
                                          ),
                                      }
                                    : {
                                          diffExpandedByPath: {
                                              ...(current.diffExpandedByPath ?? {}),
                                              [diff.path]: !current
                                                  .diffExpandedByPath?.[
                                                  diff.path
                                              ],
                                          },
                                      },
                            )
                        }
                    />
                );
            })}
        </div>
    );
}
