import { useCallback, useMemo } from "react";
import type { LanguageSupport } from "@codemirror/language";
import type { TrackedFile } from "../diff/actionLogTypes";
import type { AIFileDiff } from "../types";
import {
    computeDecisionHunks,
    computeDiffLines,
    computeVisualDiffBlocks,
    type DiffLine,
} from "../diff/reviewDiff";
import type { ReviewHunk, ReviewHunkId } from "../diff/reviewProjection";
import { HighlightedCodeText } from "../../editor/staticCodeHighlight";
import { useCodeLanguageSupport } from "../../editor/useCodeLanguageSupport";

type HunkDecision = "accepted" | "rejected";

type DiffRenderBlock =
    | { kind: "separator"; line: DiffLine; key: string }
    | { kind: "plain"; lines: DiffLine[]; key: string }
    | {
          kind: "visual";
          visualBlockIndex: number;
          lines: DiffLine[];
          key: string;
      };

type VisualDecisionSegment =
    | { kind: "plain"; lines: DiffLine[]; key: string }
    | {
          kind: "decision";
          decisionHunkIndex: number;
          lines: DiffLine[];
          key: string;
      };

interface SemanticDecisionHunk {
    index: number;
    idKey: string;
    lines: DiffLine[];
    oldStart: number;
    oldEnd: number;
    newStart: number;
    newEnd: number;
}

function buildDiffRenderBlocks(lines: DiffLine[]): DiffRenderBlock[] {
    const blocks: DiffRenderBlock[] = [];
    let pendingPlain: DiffLine[] = [];
    let pendingVisual: DiffLine[] = [];
    let pendingVisualBlockIndex: number | null = null;

    function flushPlain() {
        if (pendingPlain.length === 0) return;
        blocks.push({
            kind: "plain",
            lines: pendingPlain,
            key: `plain:${blocks.length}`,
        });
        pendingPlain = [];
    }

    function flushVisual() {
        if (pendingVisual.length === 0 || pendingVisualBlockIndex == null)
            return;
        blocks.push({
            kind: "visual",
            visualBlockIndex: pendingVisualBlockIndex,
            lines: pendingVisual,
            key: `visual:${pendingVisualBlockIndex}`,
        });
        pendingVisual = [];
        pendingVisualBlockIndex = null;
    }

    for (const line of lines) {
        if (line.type === "separator") {
            flushPlain();
            flushVisual();
            blocks.push({
                kind: "separator",
                line,
                key: `separator:${blocks.length}`,
            });
            continue;
        }

        if (typeof line.visualBlockIndex === "number") {
            flushPlain();
            if (pendingVisualBlockIndex !== line.visualBlockIndex) {
                flushVisual();
                pendingVisualBlockIndex = line.visualBlockIndex;
            }
            pendingVisual.push(line);
            continue;
        }

        flushVisual();
        pendingPlain.push(line);
    }

    flushPlain();
    flushVisual();

    return blocks;
}

function buildVisualDecisionSegments(
    lines: DiffLine[],
): VisualDecisionSegment[] {
    const segments: VisualDecisionSegment[] = [];
    let pendingPlain: DiffLine[] = [];
    let pendingDecision: DiffLine[] = [];
    let pendingDecisionIndex: number | null = null;

    function flushPlain() {
        if (pendingPlain.length === 0) return;
        segments.push({
            kind: "plain",
            lines: pendingPlain,
            key: `plain:${segments.length}`,
        });
        pendingPlain = [];
    }

    function flushDecision() {
        if (pendingDecision.length === 0 || pendingDecisionIndex == null)
            return;
        segments.push({
            kind: "decision",
            decisionHunkIndex: pendingDecisionIndex,
            lines: pendingDecision,
            key: `decision:${pendingDecisionIndex}:${segments.length}`,
        });
        pendingDecision = [];
        pendingDecisionIndex = null;
    }

    for (const line of lines) {
        if (typeof line.decisionHunkIndex === "number") {
            flushPlain();
            if (pendingDecisionIndex !== line.decisionHunkIndex) {
                flushDecision();
                pendingDecisionIndex = line.decisionHunkIndex;
            }
            pendingDecision.push(line);
            continue;
        }

        flushDecision();
        pendingPlain.push(line);
    }

    flushPlain();
    flushDecision();

    return segments;
}

function buildSemanticDecisionHunks(
    reviewHunks: readonly ReviewHunk[] | undefined,
    fallbackHunks: ReturnType<typeof computeDecisionHunks>,
): SemanticDecisionHunk[] {
    if (reviewHunks && reviewHunks.length > 0) {
        return reviewHunks.map((hunk, index) => ({
            index,
            idKey: hunk.id.key,
            lines: [],
            oldStart: hunk.oldStartLine,
            oldEnd: hunk.oldEndLine,
            newStart: hunk.newStartLine,
            newEnd: hunk.newEndLine,
        }));
    }

    return fallbackHunks.map((hunk) => ({
        index: hunk.index,
        idKey: `legacy:${hunk.index}`,
        lines: hunk.lines,
        oldStart: hunk.oldStart,
        oldEnd: hunk.oldEnd,
        newStart: hunk.newStart,
        newEnd: hunk.newEnd,
    }));
}

function lineIntersectsSemanticHunk(
    line: DiffLine,
    hunk: SemanticDecisionHunk,
): boolean {
    const oldLineIndex =
        typeof line.oldLineNumber === "number" ? line.oldLineNumber - 1 : null;
    const newLineIndex =
        typeof line.newLineNumber === "number" ? line.newLineNumber - 1 : null;

    const oldMatches =
        oldLineIndex != null &&
        oldLineIndex >= hunk.oldStart &&
        oldLineIndex < hunk.oldEnd;
    const newMatches =
        newLineIndex != null &&
        newLineIndex >= hunk.newStart &&
        newLineIndex < hunk.newEnd;
    const oldPointMatches =
        oldLineIndex != null &&
        hunk.oldStart === hunk.oldEnd &&
        oldLineIndex === hunk.oldStart;
    const newPointMatches =
        newLineIndex != null &&
        hunk.newStart === hunk.newEnd &&
        newLineIndex === hunk.newStart;

    return oldMatches || newMatches || oldPointMatches || newPointMatches;
}

function getSemanticHunkIndexForLine(
    line: DiffLine,
    semanticHunks: readonly SemanticDecisionHunk[],
): number | undefined {
    if (line.type === "separator") {
        return undefined;
    }

    const matchedHunk = semanticHunks.find((hunk) =>
        lineIntersectsSemanticHunk(line, hunk),
    );
    return matchedHunk?.index;
}

function buildSemanticDecisionSegments(
    lines: DiffLine[],
    semanticHunks: readonly SemanticDecisionHunk[],
): VisualDecisionSegment[] {
    const segments: VisualDecisionSegment[] = [];
    let pendingPlain: DiffLine[] = [];
    let pendingDecision: DiffLine[] = [];
    let pendingDecisionIndex: number | null = null;

    const flushPlain = () => {
        if (pendingPlain.length === 0) return;
        segments.push({
            kind: "plain",
            lines: pendingPlain,
            key: `plain:${segments.length}`,
        });
        pendingPlain = [];
    };

    const flushDecision = () => {
        if (pendingDecision.length === 0 || pendingDecisionIndex == null) {
            return;
        }
        segments.push({
            kind: "decision",
            decisionHunkIndex: pendingDecisionIndex,
            lines: pendingDecision,
            key: `decision:${pendingDecisionIndex}:${segments.length}`,
        });
        pendingDecision = [];
        pendingDecisionIndex = null;
    };

    for (const line of lines) {
        const semanticHunkIndex = getSemanticHunkIndexForLine(
            line,
            semanticHunks,
        );
        if (typeof semanticHunkIndex === "number") {
            flushPlain();
            if (pendingDecisionIndex !== semanticHunkIndex) {
                flushDecision();
                pendingDecisionIndex = semanticHunkIndex;
            }
            pendingDecision.push(line);
            continue;
        }

        flushDecision();
        pendingPlain.push(line);
    }

    flushPlain();
    flushDecision();

    return segments;
}

function HunkActionBar({
    hunkIndex,
    decision,
    onAccept,
    onReject,
    onUndo,
}: {
    hunkIndex: number;
    decision?: HunkDecision;
    onAccept: () => void;
    onReject: () => void;
    onUndo: () => void;
}) {
    const barStyle: React.CSSProperties = {
        position: "absolute",
        top: 8,
        right: 8,
        display: "flex",
        alignItems: "center",
        gap: 4,
        zIndex: 2,
        padding: 3,
        borderRadius: 8,
        border: "1px solid color-mix(in srgb, var(--border) 82%, transparent)",
        backgroundColor:
            "color-mix(in srgb, var(--bg-secondary) 84%, transparent)",
        backdropFilter: "blur(8px)",
        boxShadow: "0 6px 16px rgb(0 0 0 / 0.12)",
    };
    const baseButtonStyle: React.CSSProperties = {
        height: 24,
        padding: "0 9px",
        borderRadius: 6,
        fontSize: "0.68em",
        fontWeight: 600,
        letterSpacing: "0.01em",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
    };
    const hiddenUntilHoverClass = decision
        ? "opacity-100 translate-y-0 pointer-events-auto"
        : "pointer-events-none opacity-0 -translate-y-1 group-hover:pointer-events-auto group-hover:opacity-100 group-hover:translate-y-0 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-focus-within:translate-y-0";

    if (decision) {
        const accepted = decision === "accepted";
        const color = accepted ? "var(--diff-add)" : "var(--diff-remove)";
        return (
            <div
                className={`transition-all duration-150 ease-out ${hiddenUntilHoverClass}`}
                style={barStyle}
            >
                <span
                    style={{
                        ...baseButtonStyle,
                        padding: "0 8px",
                        fontWeight: 600,
                        color,
                        backgroundColor: `color-mix(in srgb, ${color} 10%, var(--bg-primary))`,
                        border: `1px solid color-mix(in srgb, ${color} 30%, var(--border))`,
                    }}
                >
                    {accepted ? "Accepted" : "Rejected"}
                </span>
                <button
                    type="button"
                    onClick={onUndo}
                    aria-label={`Undo hunk ${hunkIndex + 1}`}
                    className="review-action-btn"
                    style={{
                        ...baseButtonStyle,
                        border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
                        backgroundColor:
                            "color-mix(in srgb, var(--bg-primary) 72%, var(--bg-secondary))",
                        color: "var(--text-primary)",
                    }}
                >
                    Undo
                </button>
            </div>
        );
    }

    return (
        <div
            className={`transition-all duration-150 ease-out ${hiddenUntilHoverClass}`}
            style={barStyle}
        >
            <button
                type="button"
                onClick={onAccept}
                aria-label={`Accept hunk ${hunkIndex + 1}`}
                className="review-action-btn"
                style={{
                    ...baseButtonStyle,
                    border: "1px solid color-mix(in srgb, var(--diff-add) 32%, var(--border))",
                    backgroundColor:
                        "color-mix(in srgb, var(--diff-add) 10%, var(--bg-primary))",
                    color: "var(--diff-add)",
                }}
            >
                Accept
            </button>
            <button
                type="button"
                onClick={onReject}
                aria-label={`Reject hunk ${hunkIndex + 1}`}
                className="review-action-btn"
                style={{
                    ...baseButtonStyle,
                    border: "1px solid color-mix(in srgb, var(--diff-remove) 32%, var(--border))",
                    backgroundColor:
                        "color-mix(in srgb, var(--diff-remove) 10%, var(--bg-primary))",
                    color: "var(--diff-remove)",
                }}
            >
                Reject
            </button>
        </div>
    );
}

function getDisplayedLineNumber(line: DiffLine) {
    return line.oldLineNumber ?? line.newLineNumber ?? "";
}

function getDiffLineGridTemplateColumns({
    compactLineNumbers,
    exact,
    lineWrapping,
}: {
    compactLineNumbers: boolean;
    exact: boolean;
    lineWrapping: boolean;
}) {
    const contentColumn = lineWrapping ? "minmax(0, 1fr)" : "max-content";
    if (exact) {
        return compactLineNumbers
            ? `44px ${contentColumn}`
            : `56px 56px ${contentColumn}`;
    }

    return `36px ${contentColumn}`;
}

function getDiffLineTextStyles(lineWrapping: boolean) {
    return {
        whiteSpace: lineWrapping ? ("pre-wrap" as const) : ("pre" as const),
        wordBreak: lineWrapping ? ("break-all" as const) : ("normal" as const),
        overflowWrap: lineWrapping
            ? ("anywhere" as const)
            : ("normal" as const),
    };
}

export function DiffLineView({
    line,
    compactLineNumbers = false,
    lineWrapping = true,
    language = null,
}: {
    line: DiffLine;
    compactLineNumbers?: boolean;
    lineWrapping?: boolean;
    language?: LanguageSupport | null;
}) {
    const isExact = line.exact === true;
    const textStyles = getDiffLineTextStyles(lineWrapping);
    const lineText = useMemo(
        () => (
            <HighlightedCodeText
                text={line.text}
                language={language}
                segmentKeyPrefix={`diff-line:${line.oldLineNumber ?? "n"}:${line.newLineNumber ?? "n"}:${line.text.length}`}
            />
        ),
        [language, line.newLineNumber, line.oldLineNumber, line.text],
    );

    if (isExact) {
        if (line.type === "separator") {
            return (
                <div
                    data-diff-line="true"
                    data-line-wrapping={String(lineWrapping)}
                    style={{
                        display: "grid",
                        gridTemplateColumns: getDiffLineGridTemplateColumns({
                            compactLineNumbers,
                            exact: true,
                            lineWrapping,
                        }),
                        padding: "2px 8px",
                        opacity: 0.5,
                        color: "var(--text-secondary)",
                    }}
                >
                    <div />
                    {!compactLineNumbers ? <div /> : null}
                    <div style={{ textAlign: "center" }}>{line.text}</div>
                </div>
            );
        }

        if (compactLineNumbers) {
            return (
                <div
                    style={{
                        display: "grid",
                        gridTemplateColumns: getDiffLineGridTemplateColumns({
                            compactLineNumbers,
                            exact: true,
                            lineWrapping,
                        }),
                        alignItems: "stretch",
                        ...textStyles,
                        backgroundColor:
                            line.type === "add"
                                ? "color-mix(in srgb, var(--diff-add) 5%, transparent)"
                                : line.type === "remove"
                                  ? "color-mix(in srgb, var(--diff-remove) 5%, transparent)"
                                  : "transparent",
                        color:
                            line.type === "add"
                                ? "var(--diff-add)"
                                : line.type === "remove"
                                  ? "var(--diff-remove)"
                                  : "var(--text-secondary)",
                        borderLeft:
                            line.type === "add"
                                ? "2px solid color-mix(in srgb, var(--diff-add) 45%, transparent)"
                                : line.type === "remove"
                                  ? "2px solid color-mix(in srgb, var(--diff-remove) 45%, transparent)"
                                  : "2px solid transparent",
                    }}
                >
                    <div
                        style={{
                            padding: "0 6px 0 4px",
                            textAlign: "right",
                            color: "var(--text-secondary)",
                            opacity: 0.55,
                            borderRight:
                                "1px solid color-mix(in srgb, var(--border) 50%, transparent)",
                            userSelect: "none",
                            fontSize: "0.85em",
                        }}
                    >
                        {getDisplayedLineNumber(line)}
                    </div>
                    <div style={{ padding: "0 10px" }}>{lineText}</div>
                </div>
            );
        }

        return (
            <div
                data-diff-line="true"
                data-line-wrapping={String(lineWrapping)}
                style={{
                    display: "grid",
                    gridTemplateColumns: getDiffLineGridTemplateColumns({
                        compactLineNumbers,
                        exact: true,
                        lineWrapping,
                    }),
                    alignItems: "stretch",
                    ...textStyles,
                    backgroundColor:
                        line.type === "add"
                            ? "color-mix(in srgb, var(--diff-add) 5%, transparent)"
                            : line.type === "remove"
                              ? "color-mix(in srgb, var(--diff-remove) 5%, transparent)"
                              : "transparent",
                    color:
                        line.type === "add"
                            ? "var(--diff-add)"
                            : line.type === "remove"
                              ? "var(--diff-remove)"
                              : "var(--text-secondary)",
                    borderLeft:
                        line.type === "add"
                            ? "2px solid color-mix(in srgb, var(--diff-add) 45%, transparent)"
                            : line.type === "remove"
                              ? "2px solid color-mix(in srgb, var(--diff-remove) 45%, transparent)"
                              : "2px solid transparent",
                }}
            >
                <div
                    style={{
                        padding: "0 8px 0 6px",
                        textAlign: "right",
                        color: "var(--text-secondary)",
                        opacity: 0.55,
                        borderRight:
                            "1px solid color-mix(in srgb, var(--border) 50%, transparent)",
                        userSelect: "none",
                    }}
                >
                    {line.oldLineNumber ?? ""}
                </div>
                <div
                    style={{
                        padding: "0 8px",
                        textAlign: "right",
                        color: "var(--text-secondary)",
                        opacity: 0.55,
                        borderRight:
                            "1px solid color-mix(in srgb, var(--border) 50%, transparent)",
                        userSelect: "none",
                    }}
                >
                    {line.newLineNumber ?? ""}
                </div>
                <div style={{ padding: "0 12px" }}>{lineText}</div>
            </div>
        );
    }

    if (line.type === "separator") {
        return (
            <div
                style={{
                    display: "grid",
                    gridTemplateColumns: getDiffLineGridTemplateColumns({
                        compactLineNumbers,
                        exact: false,
                        lineWrapping,
                    }),
                    padding: "2px 8px",
                    opacity: 0.5,
                    color: "var(--text-secondary)",
                }}
            >
                <div />
                <div style={{ textAlign: "center" }}>{line.text}</div>
            </div>
        );
    }

    const lineNumber = getDisplayedLineNumber(line);

    return (
        <div
            data-diff-line="true"
            data-line-wrapping={String(lineWrapping)}
            style={{
                display: "grid",
                gridTemplateColumns: getDiffLineGridTemplateColumns({
                    compactLineNumbers,
                    exact: false,
                    lineWrapping,
                }),
                alignItems: "stretch",
                ...textStyles,
                backgroundColor:
                    line.type === "add"
                        ? "color-mix(in srgb, var(--diff-add) 5%, transparent)"
                        : line.type === "remove"
                          ? "color-mix(in srgb, var(--diff-remove) 5%, transparent)"
                          : "transparent",
                color:
                    line.type === "add"
                        ? "var(--diff-add)"
                        : line.type === "remove"
                          ? "var(--diff-remove)"
                          : "var(--text-secondary)",
                borderLeft:
                    line.type === "add"
                        ? "2px solid color-mix(in srgb, var(--diff-add) 45%, transparent)"
                        : line.type === "remove"
                          ? "2px solid color-mix(in srgb, var(--diff-remove) 45%, transparent)"
                          : "2px solid transparent",
            }}
        >
            <div
                style={{
                    padding: "0 4px 0 6px",
                    textAlign: "right",
                    color: "var(--text-secondary)",
                    opacity: 0.55,
                    borderRight:
                        "1px solid color-mix(in srgb, var(--border) 50%, transparent)",
                    userSelect: "none",
                    fontSize: "0.85em",
                }}
            >
                {lineNumber}
            </div>
            <div style={{ padding: "0 8px" }}>{lineText}</div>
        </div>
    );
}

export function EditedFileDiffPreview({
    diff,
    expanded,
    diffZoom,
    lineWrapping = true,
    testId,
    emptyLabel = "Path-only change",
    showWhenEmpty = true,
    compactLineNumbers = false,
    file,
    reviewHunks,
    onKeep,
    onReject,
    onResolveReviewHunks,
}: {
    diff: AIFileDiff;
    expanded: boolean;
    diffZoom: number;
    lineWrapping?: boolean;
    testId?: string;
    emptyLabel?: string;
    showWhenEmpty?: boolean;
    compactLineNumbers?: boolean;
    file?: TrackedFile;
    reviewHunks?: ReviewHunk[];
    onKeep?: (identityKey: string) => void | Promise<void>;
    onReject?: (identityKey: string) => void | Promise<void>;
    onResolveReviewHunks?: (
        identityKey: string,
        decision: "accepted" | "rejected",
        trackedVersion: number,
        hunkIds: ReviewHunkId[],
    ) => void | Promise<void>;
}) {
    const lines = useMemo(
        () => (expanded ? computeDiffLines(diff) : []),
        [diff, expanded],
    );
    const languageSupport = useCodeLanguageSupport(
        file?.path ?? diff.path,
        null,
    );
    const visualBlocks = useMemo(
        () => (expanded && file ? computeVisualDiffBlocks(diff) : []),
        [diff, file, expanded],
    );
    const fallbackDecisionHunks = useMemo(
        () => (expanded ? computeDecisionHunks(diff) : []),
        [diff, expanded],
    );
    const semanticHunks = useMemo(
        () => buildSemanticDecisionHunks(reviewHunks, fallbackDecisionHunks),
        [fallbackDecisionHunks, reviewHunks],
    );
    const semanticHunkByIndex = useMemo(
        () => new Map(semanticHunks.map((hunk) => [hunk.index, hunk])),
        [semanticHunks],
    );
    const reviewHunkByIndex = useMemo(
        () =>
            new Map(
                (reviewHunks ?? []).map(
                    (hunk, index) => [index, hunk] as const,
                ),
            ),
        [reviewHunks],
    );
    const interactiveHunksEnabled =
        expanded &&
        !!file &&
        file.isText &&
        file.conflictHash == null &&
        visualBlocks.length > 0 &&
        semanticHunks.length > 0 &&
        !!onResolveReviewHunks;
    const renderBlocks = useMemo(() => buildDiffRenderBlocks(lines), [lines]);
    const visualBlockByIndex = useMemo(
        () => new Map(visualBlocks.map((block) => [block.index, block])),
        [visualBlocks],
    );

    const handleHunkDecision = useCallback(
        (hunkIndex: number, decision: HunkDecision) => {
            if (!file) {
                return;
            }

            const reviewHunk = reviewHunkByIndex.get(hunkIndex);
            if (reviewHunk) {
                void onResolveReviewHunks?.(
                    file.identityKey,
                    decision,
                    reviewHunk.trackedVersion,
                    [reviewHunk.id],
                );
            }
        },
        [file, onResolveReviewHunks, reviewHunkByIndex],
    );

    if (!expanded) {
        return null;
    }

    if (lines.length === 0 && !showWhenEmpty) {
        return null;
    }

    return (
        <div
            style={{
                borderTop: `1px solid color-mix(in srgb, var(--border) 35%, transparent)`,
            }}
        >
            <div
                data-testid={testId}
                data-line-wrapping={String(lineWrapping)}
                style={{
                    fontSize: `${diffZoom}em`,
                    fontFamily: "var(--font-mono, monospace)",
                    lineHeight: 1.55,
                    backgroundColor:
                        "color-mix(in srgb, var(--bg-primary) 60%, var(--bg-elevated))",
                    overflowX: lineWrapping ? "hidden" : "auto",
                    overflowY: "hidden",
                }}
            >
                <div
                    style={{
                        width: lineWrapping ? "100%" : "max-content",
                        minWidth: "100%",
                    }}
                >
                    {lines.length > 0 ? (
                        <div style={{ padding: "4px 0" }}>
                            {renderBlocks.map((block) => {
                                if (block.kind === "separator") {
                                    return (
                                        <DiffLineView
                                            key={block.key}
                                            line={block.line}
                                            compactLineNumbers={
                                                compactLineNumbers
                                            }
                                            lineWrapping={lineWrapping}
                                            language={languageSupport}
                                        />
                                    );
                                }

                                if (block.kind !== "visual") {
                                    return (
                                        <div key={block.key}>
                                            {block.lines.map((line, idx) => (
                                                <DiffLineView
                                                    key={`${block.key}:${idx}`}
                                                    line={line}
                                                    compactLineNumbers={
                                                        compactLineNumbers
                                                    }
                                                    lineWrapping={lineWrapping}
                                                    language={languageSupport}
                                                />
                                            ))}
                                        </div>
                                    );
                                }

                                if (!interactiveHunksEnabled || !file) {
                                    return (
                                        <div key={block.key}>
                                            {block.lines.map((line, idx) => (
                                                <DiffLineView
                                                    key={`${block.key}:${idx}`}
                                                    line={line}
                                                    compactLineNumbers={
                                                        compactLineNumbers
                                                    }
                                                    lineWrapping={lineWrapping}
                                                    language={languageSupport}
                                                />
                                            ))}
                                        </div>
                                    );
                                }

                                const visualBlock = visualBlockByIndex.get(
                                    block.visualBlockIndex,
                                );
                                const segments =
                                    reviewHunks && reviewHunks.length > 0
                                        ? buildSemanticDecisionSegments(
                                              block.lines,
                                              semanticHunks,
                                          )
                                        : buildVisualDecisionSegments(
                                              block.lines,
                                          );
                                const matchedSemanticHunkIndexes = [
                                    ...new Set(
                                        segments
                                            .filter(
                                                (
                                                    segment,
                                                ): segment is Extract<
                                                    VisualDecisionSegment,
                                                    { kind: "decision" }
                                                > =>
                                                    segment.kind === "decision",
                                            )
                                            .map(
                                                (segment) =>
                                                    segment.decisionHunkIndex,
                                            ),
                                    ),
                                ];

                                return (
                                    <div
                                        key={block.key}
                                        style={{
                                            margin: "4px 6px",
                                            borderRadius: 8,
                                            border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)",
                                            overflow: "hidden",
                                            backgroundColor:
                                                "color-mix(in srgb, var(--bg-primary) 40%, var(--bg-elevated))",
                                        }}
                                    >
                                        {visualBlock &&
                                        (reviewHunks && reviewHunks.length > 0
                                            ? matchedSemanticHunkIndexes.length >
                                              1
                                            : visualBlock.decisionHunkIndexes
                                                  .length > 1) ? (
                                            <div
                                                style={{
                                                    padding: "5px 10px 0",
                                                    fontSize: "0.68em",
                                                    fontWeight: 500,
                                                    letterSpacing: "0.02em",
                                                    color: "var(--text-secondary)",
                                                    opacity: 0.55,
                                                }}
                                            >
                                                Linked changes
                                            </div>
                                        ) : null}
                                        <div style={{ padding: 4 }}>
                                            {segments.map((segment) => {
                                                if (segment.kind === "plain") {
                                                    return (
                                                        <div key={segment.key}>
                                                            {segment.lines.map(
                                                                (line, idx) => (
                                                                    <DiffLineView
                                                                        key={`${segment.key}:${idx}`}
                                                                        line={
                                                                            line
                                                                        }
                                                                        compactLineNumbers={
                                                                            compactLineNumbers
                                                                        }
                                                                        lineWrapping={
                                                                            lineWrapping
                                                                        }
                                                                        language={
                                                                            languageSupport
                                                                        }
                                                                    />
                                                                ),
                                                            )}
                                                        </div>
                                                    );
                                                }

                                                const semanticHunk =
                                                    semanticHunkByIndex.get(
                                                        segment.decisionHunkIndex,
                                                    );
                                                const reviewHunk =
                                                    reviewHunkByIndex.get(
                                                        segment.decisionHunkIndex,
                                                    );
                                                const reviewTrackedVersion =
                                                    reviewHunk?.trackedVersion ??
                                                    file.version;
                                                const reviewHunkKey =
                                                    reviewHunk?.id.key ??
                                                    semanticHunk?.idKey;

                                                return (
                                                    <div
                                                        key={segment.key}
                                                        data-review-file-key={
                                                            file.identityKey
                                                        }
                                                        data-review-hunk-key={
                                                            reviewHunkKey
                                                        }
                                                        data-review-tracked-version={
                                                            reviewTrackedVersion
                                                        }
                                                        className="group"
                                                        style={{
                                                            position:
                                                                "relative",
                                                            margin: "4px 0",
                                                            borderRadius: 4,
                                                            border: "1px solid color-mix(in srgb, var(--border) 32%, transparent)",
                                                            overflow: "hidden",
                                                            backgroundColor:
                                                                "color-mix(in srgb, var(--bg-elevated) 70%, transparent)",
                                                        }}
                                                    >
                                                        <HunkActionBar
                                                            hunkIndex={
                                                                segment.decisionHunkIndex
                                                            }
                                                            onAccept={() =>
                                                                handleHunkDecision(
                                                                    segment.decisionHunkIndex,
                                                                    "accepted",
                                                                )
                                                            }
                                                            onReject={() =>
                                                                handleHunkDecision(
                                                                    segment.decisionHunkIndex,
                                                                    "rejected",
                                                                )
                                                            }
                                                            onUndo={() => {}}
                                                        />
                                                        <div
                                                            style={{
                                                                paddingTop: 4,
                                                                paddingRight: 4,
                                                            }}
                                                        >
                                                            {segment.lines.map(
                                                                (line, idx) => (
                                                                    <DiffLineView
                                                                        key={`${segment.key}:${idx}`}
                                                                        line={
                                                                            line
                                                                        }
                                                                        compactLineNumbers={
                                                                            compactLineNumbers
                                                                        }
                                                                        lineWrapping={
                                                                            lineWrapping
                                                                        }
                                                                        language={
                                                                            languageSupport
                                                                        }
                                                                    />
                                                                ),
                                                            )}
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <div
                            style={{
                                padding: "12px 16px",
                                color: "var(--text-secondary)",
                                opacity: 0.7,
                                textAlign: "center",
                            }}
                        >
                            {emptyLabel}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
