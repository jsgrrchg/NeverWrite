import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AIEditedFileBufferEntry, AIFileDiff } from "../types";
import {
    DIFF_PANEL_MAX_HEIGHT,
    computeDecisionHunks,
    computeDiffLines,
    computeMergedText,
    computeVisualDiffBlocks,
    type DiffLine,
} from "../diff/reviewDiff";

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
        top: 6,
        right: 8,
        display: "flex",
        alignItems: "center",
        gap: 4,
        zIndex: 1,
    };

    if (decision) {
        const accepted = decision === "accepted";
        const color = accepted ? "var(--diff-add)" : "var(--diff-remove)";
        return (
            <div style={barStyle}>
                <span
                    style={{
                        padding: "1px 7px",
                        borderRadius: 999,
                        fontSize: "0.72em",
                        fontWeight: 600,
                        color,
                        backgroundColor: `color-mix(in srgb, ${color} 10%, var(--bg-elevated))`,
                        border: `1px solid color-mix(in srgb, ${color} 22%, transparent)`,
                    }}
                >
                    {accepted ? "Accepted" : "Rejected"}
                </span>
                <button
                    type="button"
                    onClick={onUndo}
                    aria-label={`Undo hunk ${hunkIndex + 1}`}
                    style={{
                        padding: "1px 6px",
                        borderRadius: 6,
                        border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
                        backgroundColor:
                            "color-mix(in srgb, var(--bg-secondary) 80%, transparent)",
                        color: "var(--text-secondary)",
                        fontSize: "0.72em",
                        fontWeight: 500,
                        cursor: "pointer",
                    }}
                >
                    Undo
                </button>
            </div>
        );
    }

    return (
        <div style={barStyle}>
            <button
                type="button"
                onClick={onAccept}
                aria-label={`Accept hunk ${hunkIndex + 1}`}
                style={{
                    padding: "1px 7px",
                    borderRadius: 6,
                    border: "1px solid color-mix(in srgb, var(--diff-add) 25%, transparent)",
                    backgroundColor:
                        "color-mix(in srgb, var(--diff-add) 8%, var(--bg-elevated))",
                    color: "var(--diff-add)",
                    fontSize: "0.72em",
                    fontWeight: 600,
                    cursor: "pointer",
                }}
            >
                Accept
            </button>
            <button
                type="button"
                onClick={onReject}
                aria-label={`Reject hunk ${hunkIndex + 1}`}
                style={{
                    padding: "1px 7px",
                    borderRadius: 6,
                    border: "1px solid color-mix(in srgb, var(--diff-remove) 25%, transparent)",
                    backgroundColor:
                        "color-mix(in srgb, var(--diff-remove) 8%, var(--bg-elevated))",
                    color: "var(--diff-remove)",
                    fontSize: "0.72em",
                    fontWeight: 600,
                    cursor: "pointer",
                }}
            >
                Reject
            </button>
        </div>
    );
}

export function DiffLineView({ line }: { line: DiffLine }) {
    const isExact = line.exact === true;

    if (isExact) {
        if (line.type === "separator") {
            return (
                <div
                    style={{
                        display: "grid",
                        gridTemplateColumns: "56px 56px minmax(0, 1fr)",
                        padding: "2px 8px",
                        opacity: 0.5,
                        color: "var(--text-secondary)",
                    }}
                >
                    <div />
                    <div />
                    <div style={{ textAlign: "center" }}>{line.text}</div>
                </div>
            );
        }

        return (
            <div
                style={{
                    display: "grid",
                    gridTemplateColumns: "56px 56px minmax(0, 1fr)",
                    alignItems: "stretch",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-all",
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
                <div style={{ padding: "0 12px" }}>{line.text}</div>
            </div>
        );
    }

    return (
        <div
            style={{
                padding: "0 12px",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
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
                opacity: line.type === "separator" ? 0.5 : 1,
                textAlign: line.type === "separator" ? "center" : "left",
            }}
        >
            {line.prefix}
            {line.text}
        </div>
    );
}

export function EditedFileDiffPreview({
    diff,
    expanded,
    diffZoom,
    accent,
    testId,
    emptyLabel = "Path-only change",
    showWhenEmpty = true,
    entry,
    onKeep,
    onReject,
    onResolveHunks,
}: {
    diff: AIFileDiff;
    expanded: boolean;
    diffZoom: number;
    accent: string;
    testId?: string;
    emptyLabel?: string;
    showWhenEmpty?: boolean;
    entry?: AIEditedFileBufferEntry;
    onKeep?: (identityKey: string) => void | Promise<void>;
    onReject?: (identityKey: string) => void | Promise<void>;
    onResolveHunks?: (
        identityKey: string,
        mergedText: string,
    ) => void | Promise<void>;
}) {
    const [hunkDecisions, setHunkDecisions] = useState<
        Map<number, HunkDecision>
    >(new Map());
    const [panelHeight, setPanelHeight] = useState(DIFF_PANEL_MAX_HEIGHT);
    const isDraggingRef = useRef(false);
    const dragStartYRef = useRef(0);
    const dragStartHeightRef = useRef(0);
    const autoResolvedSignatureRef = useRef<string | null>(null);

    const onResizeMouseDown = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            isDraggingRef.current = true;
            dragStartYRef.current = e.clientY;
            dragStartHeightRef.current = panelHeight;

            const onMouseMove = (ev: MouseEvent) => {
                if (!isDraggingRef.current) return;
                const delta = ev.clientY - dragStartYRef.current;
                setPanelHeight(
                    Math.max(80, dragStartHeightRef.current + delta),
                );
            };
            const onMouseUp = () => {
                isDraggingRef.current = false;
                window.removeEventListener("mousemove", onMouseMove);
                window.removeEventListener("mouseup", onMouseUp);
            };
            window.addEventListener("mousemove", onMouseMove);
            window.addEventListener("mouseup", onMouseUp);
        },
        [panelHeight],
    );
    const lines = useMemo(
        () => (expanded ? computeDiffLines(diff) : []),
        [diff, expanded],
    );
    const visualBlocks = useMemo(
        () => (expanded && entry ? computeVisualDiffBlocks(diff) : []),
        [diff, entry, expanded],
    );
    const decisionHunks = useMemo(
        () => (expanded && entry ? computeDecisionHunks(diff) : []),
        [diff, entry, expanded],
    );
    const interactiveHunksEnabled =
        expanded &&
        !!entry &&
        entry.supported &&
        entry.status === "pending" &&
        entry.isText &&
        entry.baseText != null &&
        entry.appliedText != null &&
        visualBlocks.length > 0 &&
        decisionHunks.length > 0 &&
        !!onKeep &&
        !!onReject &&
        !!onResolveHunks;
    const renderBlocks = useMemo(() => buildDiffRenderBlocks(lines), [lines]);
    const visualBlockByIndex = useMemo(
        () => new Map(visualBlocks.map((block) => [block.index, block])),
        [visualBlocks],
    );

    useEffect(() => {
        setHunkDecisions(new Map());
        autoResolvedSignatureRef.current = null;
    }, [entry?.identityKey, decisionHunks.length]);

    useEffect(() => {
        if (!interactiveHunksEnabled || !entry || decisionHunks.length === 0) {
            return;
        }

        if (hunkDecisions.size !== decisionHunks.length) {
            autoResolvedSignatureRef.current = null;
            return;
        }

        const signature = JSON.stringify(
            decisionHunks.map((hunk) => [
                hunk.index,
                hunkDecisions.get(hunk.index),
            ]),
        );
        if (autoResolvedSignatureRef.current === signature) {
            return;
        }
        autoResolvedSignatureRef.current = signature;

        const identityKey = entry.identityKey;
        const decisions = decisionHunks.map((hunk) =>
            hunkDecisions.get(hunk.index),
        );

        if (decisions.every((decision) => decision === "accepted")) {
            void onKeep?.(identityKey);
            return;
        }

        if (decisions.every((decision) => decision === "rejected")) {
            void onReject?.(identityKey);
            return;
        }

        const mergedText = computeMergedText(
            entry.baseText ?? "",
            entry.appliedText ?? "",
            decisionHunks,
            hunkDecisions,
        );
        void onResolveHunks?.(identityKey, mergedText);
    }, [
        entry,
        decisionHunks,
        hunkDecisions,
        interactiveHunksEnabled,
        onKeep,
        onReject,
        onResolveHunks,
    ]);

    if (!expanded) {
        return null;
    }

    if (lines.length === 0 && !showWhenEmpty) {
        return null;
    }

    return (
        <div
            data-testid={testId}
            style={{
                borderTop: `1px solid color-mix(in srgb, var(--border) 35%, transparent)`,
            }}
        >
            <div
                style={{
                    height: panelHeight,
                    overflow: "auto",
                    fontSize: `${diffZoom}em`,
                    fontFamily: "var(--font-mono, monospace)",
                    lineHeight: 1.55,
                    backgroundColor:
                        "color-mix(in srgb, var(--bg-primary) 60%, var(--bg-elevated))",
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
                                            />
                                        ))}
                                    </div>
                                );
                            }

                            if (!interactiveHunksEnabled || !entry) {
                                return (
                                    <div key={block.key}>
                                        {block.lines.map((line, idx) => (
                                            <DiffLineView
                                                key={`${block.key}:${idx}`}
                                                line={line}
                                            />
                                        ))}
                                    </div>
                                );
                            }

                            const visualBlock = visualBlockByIndex.get(
                                block.visualBlockIndex,
                            );
                            const segments = buildVisualDecisionSegments(
                                block.lines,
                            );

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
                                    visualBlock.decisionHunkIndexes.length >
                                        1 ? (
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
                                                                    line={line}
                                                                />
                                                            ),
                                                        )}
                                                    </div>
                                                );
                                            }

                                            const decision = hunkDecisions.get(
                                                segment.decisionHunkIndex,
                                            );
                                            const wrapperStyle =
                                                decision === "accepted"
                                                    ? {
                                                          backgroundColor:
                                                              "color-mix(in srgb, var(--diff-add) 6%, transparent)",
                                                          opacity: 0.6,
                                                      }
                                                    : decision === "rejected"
                                                      ? {
                                                            backgroundColor:
                                                                "color-mix(in srgb, var(--diff-remove) 6%, transparent)",
                                                            opacity: 0.4,
                                                        }
                                                      : undefined;

                                            return (
                                                <div
                                                    key={segment.key}
                                                    style={{
                                                        position: "relative",
                                                        margin: "4px 0",
                                                        borderRadius: 6,
                                                        border: "1px solid color-mix(in srgb, var(--border) 32%, transparent)",
                                                        overflow: "hidden",
                                                        backgroundColor:
                                                            "color-mix(in srgb, var(--bg-elevated) 70%, transparent)",
                                                        ...wrapperStyle,
                                                    }}
                                                >
                                                    <HunkActionBar
                                                        hunkIndex={
                                                            segment.decisionHunkIndex
                                                        }
                                                        decision={decision}
                                                        onAccept={() =>
                                                            setHunkDecisions(
                                                                (current) => {
                                                                    const next =
                                                                        new Map(
                                                                            current,
                                                                        );
                                                                    next.set(
                                                                        segment.decisionHunkIndex,
                                                                        "accepted",
                                                                    );
                                                                    return next;
                                                                },
                                                            )
                                                        }
                                                        onReject={() =>
                                                            setHunkDecisions(
                                                                (current) => {
                                                                    const next =
                                                                        new Map(
                                                                            current,
                                                                        );
                                                                    next.set(
                                                                        segment.decisionHunkIndex,
                                                                        "rejected",
                                                                    );
                                                                    return next;
                                                                },
                                                            )
                                                        }
                                                        onUndo={() =>
                                                            setHunkDecisions(
                                                                (current) => {
                                                                    const next =
                                                                        new Map(
                                                                            current,
                                                                        );
                                                                    next.delete(
                                                                        segment.decisionHunkIndex,
                                                                    );
                                                                    return next;
                                                                },
                                                            )
                                                        }
                                                    />
                                                    <div
                                                        style={{
                                                            paddingTop: 26,
                                                            paddingRight: 4,
                                                            textDecoration:
                                                                decision ===
                                                                "rejected"
                                                                    ? "line-through"
                                                                    : "none",
                                                        }}
                                                    >
                                                        {segment.lines.map(
                                                            (line, idx) => (
                                                                <DiffLineView
                                                                    key={`${segment.key}:${idx}`}
                                                                    line={line}
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
            {/* Resize handle */}
            <div
                onMouseDown={onResizeMouseDown}
                style={{
                    height: 6,
                    cursor: "ns-resize",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor:
                        "color-mix(in srgb, var(--bg-secondary) 80%, transparent)",
                    borderTop:
                        "1px solid color-mix(in srgb, var(--border) 30%, transparent)",
                }}
            >
                <div
                    style={{
                        width: 28,
                        height: 2,
                        borderRadius: 999,
                        backgroundColor:
                            "color-mix(in srgb, var(--text-secondary) 25%, transparent)",
                    }}
                />
            </div>
        </div>
    );
}
