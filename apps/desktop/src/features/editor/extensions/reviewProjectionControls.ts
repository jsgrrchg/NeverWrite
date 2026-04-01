import {
    StateEffect,
    StateField,
    RangeSetBuilder,
    type Extension,
} from "@codemirror/state";
import {
    Decoration,
    EditorView,
    ViewPlugin,
    type DecorationSet,
    WidgetType,
} from "@codemirror/view";
import { LruCache } from "../lruCache";
import type {
    ReviewChunk,
    ReviewChunkId,
    ReviewHunk,
    ReviewHunkId,
} from "../../ai/diff/reviewProjection";

export interface ReviewProjectionDecisionPayload {
    decision: "accepted" | "rejected";
    chunkId: ReviewChunkId;
    hunkIds: ReviewHunkId[];
    view: EditorView;
}

export interface CreateReviewProjectionControlsConfig {
    allowDecisionActions: boolean;
    hunks: ReviewHunk[];
    chunks: ReviewChunk[];
    onDecision: (payload: ReviewProjectionDecisionPayload) => void;
}

const DENSE_CONTROLS_LINE_GAP = 2;
const DENSE_CONTROL_OFFSET_PX = 30;
const DENSE_CONTROL_COMPACT_OFFSET_PX = 18;
const DENSE_CONTROL_COMPACT_COLUMN_PX = 96;
const MAX_DENSE_SLOT = 2;
const DENSE_COMPACT_THRESHOLD = 3;
const GROUPED_MULTI_HUNK_LINE_SPAN_THRESHOLD = 4;
const MAX_OUT_OF_RANGE_CONTROL_WARNING_KEYS = 256;
const outOfRangeControlWarningKeys = new LruCache<string, true>(
    MAX_OUT_OF_RANGE_CONTROL_WARNING_KEYS,
);

type ReviewInlinePresentationMode = "individual" | "grouped" | "panel-only";

type ReviewControlEntry =
    | {
          kind: "decision";
          presentationMode: ReviewInlinePresentationMode;
          controlId: string;
          label: string;
          chunkId: ReviewChunkId;
          hunkIds: ReviewHunkId[];
          changeCount: number;
          isOverlapping: boolean;
          startLine: number;
          endLine: number;
          layoutGroupKey: string;
          hunkId?: ReviewHunkId;
          denseSlot: number;
          denseColumn: number;
          denseCompact: boolean;
          denseGroupSize: number;
      }
    | {
          kind: "panel-only";
          presentationMode: ReviewInlinePresentationMode;
          controlId: string;
          label: string;
          chunkId: ReviewChunkId;
          hunkIds: ReviewHunkId[];
          changeCount: number;
          isOverlapping: boolean;
          startLine: number;
          endLine: number;
          layoutGroupKey: string;
          denseSlot: number;
          denseColumn: number;
          denseCompact: boolean;
          denseGroupSize: number;
      };

function assignDenseSlots(entries: ReviewControlEntry[]): ReviewControlEntry[] {
    const sortedEntries = [...entries].sort(compareControlEntries);
    const groups: ReviewControlEntry[][] = [];
    let currentGroup: ReviewControlEntry[] = [];
    let currentGroupEndLine = -1;

    for (const entry of sortedEntries) {
        const isDenseNeighbor =
            currentGroup.length > 0 &&
            entry.layoutGroupKey === currentGroup[0]?.layoutGroupKey &&
            entry.startLine <= currentGroupEndLine + DENSE_CONTROLS_LINE_GAP;

        if (!isDenseNeighbor) {
            if (currentGroup.length > 0) {
                groups.push(currentGroup);
            }
            currentGroup = [entry];
            currentGroupEndLine = entry.endLine;
            continue;
        }

        currentGroup.push(entry);
        currentGroupEndLine = Math.max(currentGroupEndLine, entry.endLine);
    }

    if (currentGroup.length > 0) {
        groups.push(currentGroup);
    }

    return groups.flatMap((group) => {
        const denseCompact = group.length > DENSE_COMPACT_THRESHOLD;
        const rowCount = MAX_DENSE_SLOT + 1;

        return group.map((entry, index) => ({
            ...entry,
            denseSlot: denseCompact
                ? index % rowCount
                : Math.min(index, MAX_DENSE_SLOT),
            denseColumn: denseCompact ? Math.floor(index / rowCount) : 0,
            denseCompact,
            denseGroupSize: group.length,
        }));
    });
}

function formatChangeCountLabel(changeCount: number): string {
    return changeCount === 1 ? "1 change" : `${changeCount} changes`;
}

function createPanelOnlyEntry(
    chunk: ReviewChunk,
    changeCount: number = chunk.hunkIds.length,
): ReviewControlEntry {
    return {
        kind: "panel-only",
        presentationMode: "panel-only",
        controlId: `chunk:${chunk.id.key}`,
        label: formatChangeCountLabel(changeCount),
        chunkId: chunk.id,
        hunkIds: chunk.hunkIds,
        changeCount,
        isOverlapping: chunk.controlMode === "inline-overlap",
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        layoutGroupKey: `chunk:${chunk.id.key}`,
        denseSlot: 0,
        denseColumn: 0,
        denseCompact: false,
        denseGroupSize: 1,
    };
}

function createIndividualDecisionEntry(
    chunk: ReviewChunk,
    hunk: ReviewHunk,
): ReviewControlEntry {
    return {
        kind: "decision",
        presentationMode: "individual",
        controlId: `hunk:${hunk.id.key}`,
        label: "1 change",
        chunkId: chunk.id,
        hunkIds: [hunk.id],
        changeCount: 1,
        isOverlapping: hunk.overlapGroupSize > 1,
        startLine: Math.min(hunk.visualStartLine, hunk.visualEndLine),
        endLine: Math.max(hunk.visualStartLine, hunk.visualEndLine),
        layoutGroupKey: `chunk:${chunk.id.key}`,
        hunkId: hunk.id,
        denseSlot: 0,
        denseColumn: 0,
        denseCompact: false,
        denseGroupSize: 1,
    };
}

function createGroupedDecisionEntry(options: {
    chunk: ReviewChunk;
    controlKey: string;
    hunkIds: ReviewHunkId[];
    changeCount: number;
    startLine: number;
    endLine: number;
    isOverlapping: boolean;
    layoutGroupKey: string;
    presentationMode?: Exclude<ReviewInlinePresentationMode, "panel-only">;
}): ReviewControlEntry {
    return {
        kind: "decision",
        presentationMode: options.presentationMode ?? "grouped",
        controlId: options.controlKey,
        label: formatChangeCountLabel(options.changeCount),
        chunkId: options.chunk.id,
        hunkIds: options.hunkIds,
        changeCount: options.changeCount,
        isOverlapping: options.isOverlapping,
        startLine: options.startLine,
        endLine: options.endLine,
        layoutGroupKey: options.layoutGroupKey,
        denseSlot: 0,
        denseColumn: 0,
        denseCompact: false,
        denseGroupSize: 1,
    };
}

function getChunkHunks(
    chunk: ReviewChunk,
    hunkByIdKey: Map<string, ReviewHunk>,
): ReviewHunk[] {
    return chunk.hunkIds
        .map((hunkId) => hunkByIdKey.get(hunkId.key))
        .filter((hunk): hunk is ReviewHunk => hunk != null);
}

function getChunkVisualLineSpan(hunks: ReviewHunk[]): number {
    if (hunks.length === 0) {
        return 0;
    }

    const startLine = Math.min(...hunks.map((hunk) => hunk.visualStartLine));
    const endLine = Math.max(...hunks.map((hunk) => hunk.visualEndLine));
    return endLine - startLine + 1;
}

function deriveChunkPresentationMode(
    allowDecisionActions: boolean,
    chunk: ReviewChunk,
    chunkHunks: ReviewHunk[],
): ReviewInlinePresentationMode {
    if (
        !allowDecisionActions ||
        !chunk.canResolveInlineExactly ||
        chunk.controlMode === "panel-only"
    ) {
        return "panel-only";
    }

    if (chunk.controlMode === "inline-overlap") {
        return "grouped";
    }

    if (chunk.controlMode === "chunk") {
        return chunk.hunkIds.length > 1 ? "grouped" : "individual";
    }

    if (chunk.controlMode !== "hunk" || chunk.hunkIds.length <= 1) {
        return "individual";
    }

    return getChunkVisualLineSpan(chunkHunks) >
        GROUPED_MULTI_HUNK_LINE_SPAN_THRESHOLD
        ? "grouped"
        : "individual";
}

function buildOverlapGroupEntries(
    chunk: ReviewChunk,
    chunkHunks: ReviewHunk[],
): ReviewControlEntry[] {
    const groups = new Map<
        string,
        {
            hunkIds: ReviewHunkId[];
            startLine: number;
            endLine: number;
            changeCount: number;
        }
    >();

    for (const hunk of chunkHunks) {
        const groupId = hunk.overlapGroupId;
        const existing = groups.get(groupId);
        const startLine = Math.min(hunk.visualStartLine, hunk.visualEndLine);
        const endLine = Math.max(hunk.visualStartLine, hunk.visualEndLine);

        if (existing) {
            existing.hunkIds.push(hunk.id);
            existing.startLine = Math.min(existing.startLine, startLine);
            existing.endLine = Math.max(existing.endLine, endLine);
            existing.changeCount += 1;
            continue;
        }

        groups.set(groupId, {
            hunkIds: [hunk.id],
            startLine,
            endLine,
            changeCount: 1,
        });
    }

    return Array.from(groups.entries()).map(([groupId, group]) =>
        createGroupedDecisionEntry({
            chunk,
            controlKey: `group:${groupId}`,
            hunkIds: group.hunkIds,
            changeCount: group.changeCount,
            startLine: group.startLine,
            endLine: group.endLine,
            isOverlapping: group.changeCount > 1,
            layoutGroupKey: `overlap:${groupId}`,
        }),
    );
}

function buildReviewControlEntries(
    allowDecisionActions: boolean,
    hunks: ReviewHunk[],
    chunks: ReviewChunk[],
): ReviewControlEntry[] {
    if (!allowDecisionActions) {
        return assignDenseSlots(
            chunks.map((chunk) => createPanelOnlyEntry(chunk)),
        );
    }

    const hunkByIdKey = new Map(hunks.map((hunk) => [hunk.id.key, hunk]));
    const entries: ReviewControlEntry[] = [];

    for (const chunk of chunks) {
        const chunkHunks = getChunkHunks(chunk, hunkByIdKey);
        const presentationMode = deriveChunkPresentationMode(
            allowDecisionActions,
            chunk,
            chunkHunks,
        );

        if (presentationMode === "panel-only") {
            entries.push(createPanelOnlyEntry(chunk));
            continue;
        }

        if (presentationMode === "individual") {
            entries.push(
                ...chunkHunks.map((hunk) =>
                    createIndividualDecisionEntry(chunk, hunk),
                ),
            );
            continue;
        }

        if (chunk.controlMode === "inline-overlap") {
            entries.push(...buildOverlapGroupEntries(chunk, chunkHunks));
            continue;
        }

        entries.push(
            createGroupedDecisionEntry({
                chunk,
                controlKey: `chunk:${chunk.id.key}`,
                hunkIds: chunk.hunkIds,
                changeCount: chunk.hunkIds.length,
                startLine: chunk.startLine,
                endLine: chunk.endLine,
                isOverlapping: false,
                layoutGroupKey: `chunk:${chunk.id.key}`,
                presentationMode,
            }),
        );
    }

    return assignDenseSlots(entries);
}

function compareControlEntries(
    left: ReviewControlEntry,
    right: ReviewControlEntry,
) {
    if (left.startLine !== right.startLine) {
        return left.startLine - right.startLine;
    }

    if (left.endLine !== right.endLine) {
        return left.endLine - right.endLine;
    }

    return left.controlId.localeCompare(right.controlId);
}

class ReviewControlWidget extends WidgetType {
    private readonly entry: ReviewControlEntry;
    private readonly onDecision: CreateReviewProjectionControlsConfig["onDecision"];
    private readonly geometryVersion: number;

    constructor(
        entry: ReviewControlEntry,
        onDecision: CreateReviewProjectionControlsConfig["onDecision"],
        geometryVersion: number,
    ) {
        super();
        this.entry = entry;
        this.onDecision = onDecision;
        this.geometryVersion = geometryVersion;
    }

    eq(other: ReviewControlWidget) {
        return (
            other.geometryVersion === this.geometryVersion &&
            other.entry.controlId === this.entry.controlId &&
            other.entry.kind === this.entry.kind &&
            other.entry.presentationMode === this.entry.presentationMode &&
            other.entry.label === this.entry.label &&
            other.entry.chunkId.key === this.entry.chunkId.key &&
            other.entry.chunkId.trackedVersion ===
                this.entry.chunkId.trackedVersion &&
            other.entry.hunkIds.length === this.entry.hunkIds.length &&
            other.entry.hunkIds.every(
                (id, index) =>
                    id.key === this.entry.hunkIds[index]?.key &&
                    id.trackedVersion ===
                        this.entry.hunkIds[index]?.trackedVersion,
            ) &&
            other.entry.denseSlot === this.entry.denseSlot &&
            other.entry.denseColumn === this.entry.denseColumn &&
            other.entry.denseCompact === this.entry.denseCompact &&
            other.entry.denseGroupSize === this.entry.denseGroupSize &&
            other.entry.changeCount === this.entry.changeCount &&
            other.entry.isOverlapping === this.entry.isOverlapping &&
            other.entry.layoutGroupKey === this.entry.layoutGroupKey
        );
    }

    toDOM(view: EditorView) {
        const anchor = document.createElement("div");
        anchor.className = "cm-review-chunk-controls-anchor";
        anchor.dataset.reviewControlId = this.entry.controlId;

        const wrap = document.createElement("div");
        wrap.className = "cm-review-chunk-controls";
        wrap.dataset.reviewControlId = this.entry.controlId;
        wrap.dataset.reviewEntryKind = this.entry.kind;
        wrap.dataset.reviewPresentationMode = this.entry.presentationMode;
        wrap.dataset.reviewChunkId = this.entry.chunkId.key;
        wrap.dataset.reviewTrackedVersion = String(
            this.entry.chunkId.trackedVersion,
        );
        wrap.dataset.reviewHunkCount = String(this.entry.hunkIds.length);
        wrap.dataset.reviewChangeCount = String(this.entry.changeCount);
        wrap.dataset.reviewDenseSlot = String(this.entry.denseSlot);
        wrap.dataset.reviewDenseColumn = String(this.entry.denseColumn);
        wrap.dataset.reviewDenseCompact = String(this.entry.denseCompact);
        wrap.dataset.reviewDenseGroupSize = String(this.entry.denseGroupSize);
        wrap.style.setProperty(
            "--review-control-dense-offset",
            `${this.entry.denseCompact ? this.entry.denseSlot * DENSE_CONTROL_COMPACT_OFFSET_PX : this.entry.denseSlot * DENSE_CONTROL_OFFSET_PX}px`,
        );
        wrap.style.setProperty(
            "--review-control-dense-inline-offset",
            `${this.entry.denseColumn * DENSE_CONTROL_COMPACT_COLUMN_PX}px`,
        );

        const badge = document.createElement("span");
        badge.className = "cm-review-chunk-badge";
        badge.textContent = this.entry.label;
        wrap.appendChild(badge);

        if (this.entry.kind === "panel-only") {
            const note = document.createElement("span");
            note.className = "cm-review-chunk-ambiguous";
            note.textContent = "Review in Changes";
            wrap.appendChild(note);
            anchor.appendChild(wrap);
            return anchor;
        }

        if (this.entry.isOverlapping) {
            wrap.dataset.reviewOverlap = "true";
            const overlapNote = document.createElement("span");
            overlapNote.className = "cm-review-chunk-overlap";
            overlapNote.textContent = "Overlapping";
            wrap.appendChild(overlapNote);
        }

        wrap.appendChild(
            createDecisionButton(
                "accept",
                () => {
                    this.onDecision({
                        decision: "accepted",
                        chunkId: this.entry.chunkId,
                        hunkIds: this.entry.hunkIds,
                        view,
                    });
                },
                {
                    scope: this.entry.hunkId ? "hunk" : "chunk",
                    hunkId: this.entry.hunkId,
                    changeCount: this.entry.changeCount,
                    isOverlapping: this.entry.isOverlapping,
                },
            ),
        );
        wrap.appendChild(
            createDecisionButton(
                "reject",
                () => {
                    this.onDecision({
                        decision: "rejected",
                        chunkId: this.entry.chunkId,
                        hunkIds: this.entry.hunkIds,
                        view,
                    });
                },
                {
                    scope: this.entry.hunkId ? "hunk" : "chunk",
                    hunkId: this.entry.hunkId,
                    changeCount: this.entry.changeCount,
                    isOverlapping: this.entry.isOverlapping,
                },
            ),
        );

        anchor.appendChild(wrap);
        return anchor;
    }

    ignoreEvent() {
        return false;
    }
}

function createDecisionButton(
    type: "accept" | "reject",
    onClick: () => void,
    options: {
        scope: "chunk" | "hunk";
        hunkId?: ReviewHunkId;
        changeCount: number;
        isOverlapping: boolean;
    },
) {
    const button = document.createElement("button");
    const defaultTitle =
        options.isOverlapping && options.changeCount > 1
            ? type === "accept"
                ? `Accept overlapping group (${options.changeCount} changes)`
                : `Reject overlapping group (${options.changeCount} changes)`
            : options.changeCount > 1
              ? type === "accept"
                ? `Accept ${options.changeCount} changes`
                : `Reject ${options.changeCount} changes`
            : type === "accept"
              ? "Accept change"
              : "Reject change";
    button.type = "button";
    button.className = `cm-review-action cm-review-action-${type}`;
    button.dataset.reviewDecision = type;
    button.dataset.reviewDecisionScope = options.scope;
    button.title = defaultTitle;
    if (options.hunkId) {
        button.dataset.reviewHunkKey = options.hunkId.key;
        button.dataset.reviewHunkTrackedVersion = String(
            options.hunkId.trackedVersion,
        );
    }
    button.textContent = type === "accept" ? "Accept" : "Reject";
    button.onmousedown = (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
    };
    return button;
}

function getControlWidgetPos(
    state: EditorView["state"],
    entry: ReviewControlEntry,
): number | null {
    if (state.doc.lines === 0) {
        return 0;
    }

    if (isControlEntryOutOfRange(state, entry)) {
        warnControlOutOfRange(entry, state.doc.lines);
        return null;
    }

    return state.doc.line(entry.startLine + 1).from;
}

function getControlLineNumbers(
    state: EditorView["state"],
    entry: ReviewControlEntry,
) {
    if (state.doc.lines === 0) {
        return [];
    }

    const startLineNumber = Math.min(
        state.doc.lines,
        Math.max(1, entry.startLine + 1),
    );
    const endExclusiveLineNumber = Math.min(
        state.doc.lines + 1,
        Math.max(startLineNumber + 1, entry.endLine + 1),
    );
    const lineNumbers: number[] = [];

    for (
        let lineNumber = startLineNumber;
        lineNumber < endExclusiveLineNumber;
        lineNumber += 1
    ) {
        lineNumbers.push(lineNumber);
    }

    if (lineNumbers.length === 0) {
        lineNumbers.push(startLineNumber);
    }

    return lineNumbers;
}

function buildControlsDecorations(
    state: EditorView["state"],
    allowDecisionActions: boolean,
    hunks: ReviewHunk[],
    chunks: ReviewChunk[],
    onDecision: CreateReviewProjectionControlsConfig["onDecision"],
    geometryVersion: number,
): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    const entries = buildReviewControlEntries(
        allowDecisionActions,
        hunks,
        chunks,
    );

    for (const entry of entries) {
        const pos = getControlWidgetPos(state, entry);
        if (pos == null) {
            continue;
        }
        builder.add(
            pos,
            pos,
            Decoration.widget({
                widget: new ReviewControlWidget(
                    entry,
                    onDecision,
                    geometryVersion,
                ),
                side: -1,
                block: true,
            }),
        );
    }

    return builder.finish();
}

function buildControlLineDecorations(
    state: EditorView["state"],
    allowDecisionActions: boolean,
    hunks: ReviewHunk[],
    chunks: ReviewChunk[],
): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    const entries = buildReviewControlEntries(
        allowDecisionActions,
        hunks,
        chunks,
    );

    for (const entry of entries) {
        if (isControlEntryOutOfRange(state, entry)) {
            warnControlOutOfRange(entry, state.doc.lines);
            continue;
        }
        const lineNumbers = getControlLineNumbers(state, entry);
        lineNumbers.forEach((lineNumber, index) => {
            const line = state.doc.line(lineNumber);
            builder.add(
                line.from,
                line.from,
                Decoration.line({
                    attributes: {
                        class: `cm-review-chunk-line${index === 0 ? " cm-review-chunk-line-start" : ""}${index === lineNumbers.length - 1 ? " cm-review-chunk-line-end" : ""}`,
                        "data-review-control-id": entry.controlId,
                        "data-review-entry-kind": entry.kind,
                    },
                }),
            );
        });
    }

    return builder.finish();
}

function isControlEntryOutOfRange(
    state: EditorView["state"],
    entry: ReviewControlEntry,
) {
    return (
        entry.startLine >= state.doc.lines || entry.endLine > state.doc.lines
    );
}

function warnControlOutOfRange(entry: ReviewControlEntry, docLines: number) {
    const warningKey = [
        entry.controlId,
        entry.chunkId.trackedVersion,
        entry.startLine,
        entry.endLine,
        docLines,
    ].join("|");
    if (outOfRangeControlWarningKeys.get(warningKey)) {
        return;
    }

    outOfRangeControlWarningKeys.set(warningKey, true);
    console.warn("[merge-inline] skipping out-of-range inline control", {
        controlId: entry.controlId,
        chunkId: entry.chunkId.key,
        trackedVersion: entry.chunkId.trackedVersion,
        hunkKeys: entry.hunkIds.map((id) => id.key),
        startLine: entry.startLine,
        endLine: entry.endLine,
        docLines,
    });
}

const reviewProjectionControlsTheme = EditorView.baseTheme({
    /* ── Control widget anchor ─────────────────────────────── */
    ".cm-review-chunk-controls-anchor": {
        position: "relative",
        display: "block",
        width: "100%",
        height: "0",
        overflow: "visible",
        zIndex: "3",
    },

    /* ── Floating controls bar (code-lens style) ───────────── */
    ".cm-review-chunk-controls": {
        position: "absolute",
        top: "calc(4px + var(--review-control-dense-offset, 0px))",
        right: "calc(12px + var(--review-control-dense-inline-offset, 0px))",
        display: "inline-flex",
        alignItems: "center",
        gap: "2px",
        padding: "2px 3px",
        borderRadius: "6px",
        border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
        background: "color-mix(in srgb, var(--bg-secondary) 92%, transparent)",
        backdropFilter: "blur(12px)",
        boxShadow: "0 1px 3px rgb(0 0 0 / 0.08), 0 4px 12px rgb(0 0 0 / 0.06)",
        opacity: "0",
        pointerEvents: "none",
        transform: "translateY(-2px)",
        transition: "opacity 120ms ease, transform 120ms ease",
        zIndex: "3",
    },
    ".cm-review-chunk-controls.is-hovered, .cm-review-chunk-controls:focus-within":
        {
            opacity: "1",
            pointerEvents: "auto",
            transform: "translateY(0)",
        },
    '.cm-review-chunk-controls[data-review-dense-compact="true"]': {
        gap: "1px",
        padding: "1px 2px",
        borderRadius: "5px",
    },

    /* ── Chunk line decorations (gutter + background) ──────── */
    ".cm-review-chunk-line": {
        position: "relative",
        backgroundColor: "color-mix(in srgb, var(--diff-add) 6%, transparent)",
        boxShadow: "inset 3px 0 0 0 var(--diff-add)",
    },
    ".cm-review-chunk-line-start": {
        borderTop:
            "1px solid color-mix(in srgb, var(--diff-add) 18%, transparent)",
    },
    ".cm-review-chunk-line-end": {
        borderBottom:
            "1px solid color-mix(in srgb, var(--diff-add) 18%, transparent)",
    },

    /* ── Badge ─────────────────────────────────────────────── */
    ".cm-review-chunk-badge": {
        fontSize: "10px",
        lineHeight: "1",
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        fontWeight: "600",
        color: "var(--text-secondary)",
        padding: "0 6px 0 4px",
        opacity: "0.8",
    },
    '.cm-review-chunk-controls[data-review-dense-compact="true"] .cm-review-chunk-badge':
        {
            fontSize: "9px",
            padding: "0 4px 0 3px",
        },

    /* ── Action buttons (compact, editor-native feel) ──────── */
    ".cm-review-action": {
        appearance: "none",
        border: "1px solid transparent",
        background: "transparent",
        color: "var(--text-secondary)",
        borderRadius: "4px",
        fontSize: "11px",
        lineHeight: "1",
        padding: "4px 8px",
        cursor: "pointer",
        fontWeight: "600",
        fontFamily: "inherit",
        pointerEvents: "auto",
        transition:
            "background-color 100ms ease, color 100ms ease, border-color 100ms ease",
    },
    '.cm-review-chunk-controls[data-review-dense-compact="true"] .cm-review-action':
        {
            fontSize: "10px",
            padding: "3px 6px",
        },
    ".cm-review-action:hover": {
        background: "color-mix(in srgb, var(--bg-tertiary) 80%, transparent)",
        color: "var(--text-primary)",
    },
    ".cm-review-action-accept": {
        color: "var(--diff-add)",
    },
    ".cm-review-action-accept:hover": {
        background:
            "color-mix(in srgb, var(--diff-add) 14%, var(--bg-primary))",
        borderColor: "color-mix(in srgb, var(--diff-add) 24%, transparent)",
    },
    ".cm-review-action-reject": {
        color: "var(--diff-remove)",
    },
    ".cm-review-action-reject:hover": {
        background:
            "color-mix(in srgb, var(--diff-remove) 14%, var(--bg-primary))",
        borderColor: "color-mix(in srgb, var(--diff-remove) 24%, transparent)",
    },
    '.cm-review-chunk-controls[data-review-overlap="true"]': {
        borderColor: "color-mix(in srgb, var(--warning) 40%, var(--border))",
    },

    /* ── Ambiguous / panel-only note ───────────────────────── */
    ".cm-review-chunk-ambiguous": {
        fontSize: "10px",
        fontWeight: "500",
        color: "var(--text-secondary)",
        padding: "4px 8px",
        borderRadius: "4px",
        background: "transparent",
        border: "none",
        opacity: "0.7",
        fontStyle: "italic",
    },
    ".cm-review-chunk-overlap": {
        fontSize: "10px",
        fontWeight: "600",
        color: "var(--warning)",
        padding: "2px 6px",
        borderRadius: "4px",
        background:
            "color-mix(in srgb, var(--warning) 14%, var(--bg-secondary))",
        border: "1px solid color-mix(in srgb, var(--warning) 30%, transparent)",
    },
});

function getHoverTargetElement(target: EventTarget | null): HTMLElement | null {
    if (target instanceof HTMLElement) {
        return target;
    }

    if (target instanceof Node) {
        return target.parentElement;
    }

    return null;
}

function getHoveredControlId(target: EventTarget | null): string | null {
    const element = getHoverTargetElement(target);
    if (!element) {
        return null;
    }

    const controls = element.closest<HTMLElement>(
        ".cm-review-chunk-controls[data-review-control-id]",
    );
    if (controls?.dataset.reviewControlId) {
        return controls.dataset.reviewControlId;
    }

    const controlLine = element.closest<HTMLElement>(
        ".cm-review-chunk-line[data-review-control-id]",
    );
    return controlLine?.dataset.reviewControlId ?? null;
}

const reviewProjectionControlsHoverPlugin = ViewPlugin.fromClass(
    class {
        view: EditorView;
        private hoveredControlId: string | null = null;

        constructor(view: EditorView) {
            this.view = view;
        }

        setHoveredControl(controlId: string | null) {
            if (this.hoveredControlId === controlId) {
                return;
            }

            if (this.hoveredControlId) {
                this.view.dom
                    .querySelectorAll<HTMLElement>(
                        `.cm-review-chunk-controls[data-review-control-id="${this.hoveredControlId}"]`,
                    )
                    .forEach((element) => {
                        element.classList.remove("is-hovered");
                    });
            }

            this.hoveredControlId = controlId;

            if (controlId) {
                this.view.dom
                    .querySelectorAll<HTMLElement>(
                        `.cm-review-chunk-controls[data-review-control-id="${controlId}"]`,
                    )
                    .forEach((element) => {
                        element.classList.add("is-hovered");
                    });
            }
        }
    },
    {
        eventHandlers: {
            mousemove(event, view) {
                const plugin = view.plugin(reviewProjectionControlsHoverPlugin);
                if (!plugin) return;
                plugin.setHoveredControl(getHoveredControlId(event.target));
            },
            mouseleave(_event, view) {
                view.plugin(
                    reviewProjectionControlsHoverPlugin,
                )?.setHoveredControl(null);
            },
        },
    },
);

const refreshReviewControlsGeometryEffect = StateEffect.define<null>();

function readReviewControlsGeometryKey(view: EditorView) {
    return JSON.stringify([
        view.scrollDOM.clientWidth,
        view.contentDOM.clientWidth,
        Math.round(view.defaultLineHeight * 100) / 100,
        Math.round(view.defaultCharacterWidth * 100) / 100,
        window.devicePixelRatio || 1,
    ]);
}

const reviewProjectionControlsGeometryPlugin = ViewPlugin.fromClass(
    class {
        private readonly view: EditorView;
        private resizeObserver: ResizeObserver | null = null;
        private mutationObserver: MutationObserver | null = null;
        private readonly fontSet: FontFaceSet | null =
            typeof document !== "undefined" && "fonts" in document
                ? (document.fonts as FontFaceSet)
                : null;
        private destroyed = false;
        private refreshFrame: number | null = null;
        private refreshScheduled = false;
        private lastGeometryKey: string;
        private readonly handleWindowResize = () => {
            this.scheduleRefresh();
        };
        private readonly handleWindowFocus = () => {
            this.scheduleRefresh();
        };
        private readonly handleVisibilityChange = () => {
            if (document.visibilityState === "visible") {
                this.scheduleRefresh();
            }
        };
        private readonly handleViewportResize = () => {
            this.scheduleRefresh();
        };
        private readonly handleFontEvent = () => {
            this.scheduleRefresh();
        };

        constructor(view: EditorView) {
            this.view = view;
            this.lastGeometryKey = readReviewControlsGeometryKey(view);

            if (typeof ResizeObserver !== "undefined") {
                this.resizeObserver = new ResizeObserver(() => {
                    this.scheduleRefresh();
                });
                this.resizeObserver.observe(view.dom);
                this.resizeObserver.observe(view.scrollDOM);
                this.resizeObserver.observe(view.contentDOM);
            }

            if (typeof MutationObserver !== "undefined") {
                this.mutationObserver = new MutationObserver(() => {
                    this.scheduleRefresh();
                });
                this.mutationObserver.observe(view.dom, {
                    attributes: true,
                    attributeFilter: ["class", "style"],
                });
                this.mutationObserver.observe(view.scrollDOM, {
                    attributes: true,
                    attributeFilter: ["class", "style"],
                });
                this.mutationObserver.observe(view.contentDOM, {
                    attributes: true,
                    attributeFilter: ["class", "style"],
                });
                this.mutationObserver.observe(document.documentElement, {
                    attributes: true,
                    attributeFilter: ["class", "style"],
                });
                if (document.body) {
                    this.mutationObserver.observe(document.body, {
                        attributes: true,
                        attributeFilter: ["class", "style"],
                    });
                }
            }

            if (this.fontSet) {
                this.fontSet.addEventListener(
                    "loadingdone",
                    this.handleFontEvent as EventListener,
                );
                this.fontSet.ready
                    .then(() => {
                        if (!this.destroyed && this.view.dom.isConnected) {
                            this.scheduleRefresh();
                        }
                    })
                    .catch(() => {
                        // Ignore font API readiness errors and keep fallback
                        // listeners (resize/viewport/focus) active.
                    });
            }

            window.addEventListener("resize", this.handleWindowResize);
            window.addEventListener("focus", this.handleWindowFocus);
            document.addEventListener(
                "visibilitychange",
                this.handleVisibilityChange,
            );
            window.visualViewport?.addEventListener(
                "resize",
                this.handleViewportResize,
            );
        }

        update(update: {
            geometryChanged: boolean;
            heightChanged: boolean;
            viewportChanged: boolean;
        }) {
            if (
                update.geometryChanged ||
                update.heightChanged ||
                update.viewportChanged
            ) {
                this.scheduleRefresh();
            }
        }

        private scheduleRefresh() {
            if (this.destroyed || this.refreshScheduled) {
                return;
            }

            this.refreshScheduled = true;
            this.refreshFrame = requestAnimationFrame(() => {
                this.refreshFrame = null;
                this.refreshScheduled = false;

                if (this.destroyed || !this.view.dom.isConnected) {
                    return;
                }

                const nextGeometryKey = readReviewControlsGeometryKey(
                    this.view,
                );
                if (nextGeometryKey === this.lastGeometryKey) {
                    return;
                }

                this.lastGeometryKey = nextGeometryKey;
                this.view.dispatch({
                    effects: [refreshReviewControlsGeometryEffect.of(null)],
                });
            });
        }

        destroy() {
            this.destroyed = true;
            if (this.refreshFrame !== null) {
                cancelAnimationFrame(this.refreshFrame);
                this.refreshFrame = null;
            }
            this.refreshScheduled = false;
            this.resizeObserver?.disconnect();
            this.mutationObserver?.disconnect();
            if (this.fontSet) {
                this.fontSet.removeEventListener(
                    "loadingdone",
                    this.handleFontEvent as EventListener,
                );
            }
            window.removeEventListener("resize", this.handleWindowResize);
            window.removeEventListener("focus", this.handleWindowFocus);
            document.removeEventListener(
                "visibilitychange",
                this.handleVisibilityChange,
            );
            window.visualViewport?.removeEventListener(
                "resize",
                this.handleViewportResize,
            );
        }
    },
);

export function refreshReviewProjectionControlsGeometry(view: EditorView) {
    view.dispatch({
        effects: [refreshReviewControlsGeometryEffect.of(null)],
    });
}

export function createReviewProjectionControlsExtension(
    config: CreateReviewProjectionControlsConfig,
): Extension[] {
    const geometryField = StateField.define<number>({
        create() {
            return 0;
        },
        update(geometryVersion, transaction) {
            return transaction.effects.some((effect) =>
                effect.is(refreshReviewControlsGeometryEffect),
            )
                ? geometryVersion + 1
                : geometryVersion;
        },
    });

    const lineField = StateField.define<DecorationSet>({
        create(state) {
            return buildControlLineDecorations(
                state,
                config.allowDecisionActions,
                config.hunks,
                config.chunks,
            );
        },
        update(_decorations, transaction) {
            return buildControlLineDecorations(
                transaction.state,
                config.allowDecisionActions,
                config.hunks,
                config.chunks,
            );
        },
        provide: (field) => EditorView.decorations.from(field),
    });

    const controlsField = StateField.define<DecorationSet>({
        create(state) {
            return buildControlsDecorations(
                state,
                config.allowDecisionActions,
                config.hunks,
                config.chunks,
                config.onDecision,
                state.field(geometryField),
            );
        },
        update(_decorations, transaction) {
            return buildControlsDecorations(
                transaction.state,
                config.allowDecisionActions,
                config.hunks,
                config.chunks,
                config.onDecision,
                transaction.state.field(geometryField),
            );
        },
        provide: (field) => EditorView.decorations.from(field),
    });

    return [
        geometryField,
        lineField,
        controlsField,
        reviewProjectionControlsTheme,
        reviewProjectionControlsHoverPlugin,
        reviewProjectionControlsGeometryPlugin,
    ];
}
