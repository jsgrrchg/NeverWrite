import { StateField, RangeSetBuilder, type Extension } from "@codemirror/state";
import {
    Decoration,
    EditorView,
    ViewPlugin,
    type DecorationSet,
    WidgetType,
} from "@codemirror/view";
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

type ReviewControlEntry =
    | {
          kind: "decision";
          controlId: string;
          label: string;
          chunkId: ReviewChunkId;
          hunkIds: ReviewHunkId[];
          startLine: number;
          endLine: number;
          hunkId?: ReviewHunkId;
      }
    | {
          kind: "panel-only";
          controlId: string;
          label: string;
          chunkId: ReviewChunkId;
          hunkIds: ReviewHunkId[];
          startLine: number;
          endLine: number;
      };

function buildReviewControlEntries(
    allowDecisionActions: boolean,
    hunks: ReviewHunk[],
    chunks: ReviewChunk[],
): ReviewControlEntry[] {
    if (!allowDecisionActions) {
        return chunks
            .map((chunk) => ({
                kind: "panel-only" as const,
                controlId: `chunk:${chunk.id.key}`,
                label:
                    chunk.hunkIds.length > 1
                        ? `${chunk.hunkIds.length} changes`
                        : "1 change",
                chunkId: chunk.id,
                hunkIds: chunk.hunkIds,
                startLine: chunk.startLine,
                endLine: chunk.endLine,
            }))
            .sort(compareControlEntries);
    }

    const hunkByIdKey = new Map(hunks.map((hunk) => [hunk.id.key, hunk]));
    const entries: ReviewControlEntry[] = [];

    for (const chunk of chunks) {
        if (!chunk.canResolveInlineExactly || chunk.controlMode === "panel-only") {
            entries.push({
                kind: "panel-only",
                controlId: `chunk:${chunk.id.key}`,
                label:
                    chunk.hunkIds.length > 1
                        ? `${chunk.hunkIds.length} changes`
                        : "1 change",
                chunkId: chunk.id,
                hunkIds: chunk.hunkIds,
                startLine: chunk.startLine,
                endLine: chunk.endLine,
            });
            continue;
        }

        if (chunk.controlMode === "hunk") {
            for (const hunkId of chunk.hunkIds) {
                const hunk = hunkByIdKey.get(hunkId.key);
                if (!hunk) {
                    continue;
                }
                entries.push({
                    kind: "decision",
                    controlId: `hunk:${hunk.id.key}`,
                    label: "1 change",
                    chunkId: chunk.id,
                    hunkIds: [hunk.id],
                    startLine: Math.min(hunk.visualStartLine, hunk.visualEndLine),
                    endLine: Math.max(hunk.visualStartLine, hunk.visualEndLine),
                    hunkId: hunk.id,
                });
            }
            continue;
        }

        entries.push({
            kind: "decision",
            controlId: `chunk:${chunk.id.key}`,
            label:
                chunk.hunkIds.length > 1
                    ? `${chunk.hunkIds.length} changes`
                    : "1 change",
            chunkId: chunk.id,
            hunkIds: chunk.hunkIds,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
        });
    }

    return entries.sort(compareControlEntries);
}

function compareControlEntries(left: ReviewControlEntry, right: ReviewControlEntry) {
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

    constructor(
        entry: ReviewControlEntry,
        onDecision: CreateReviewProjectionControlsConfig["onDecision"],
    ) {
        super();
        this.entry = entry;
        this.onDecision = onDecision;
    }

    eq(other: ReviewControlWidget) {
        return (
            other.entry.controlId === this.entry.controlId &&
            other.entry.kind === this.entry.kind &&
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
            )
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
        wrap.dataset.reviewChunkId = this.entry.chunkId.key;
        wrap.dataset.reviewTrackedVersion = String(
            this.entry.chunkId.trackedVersion,
        );
        wrap.dataset.reviewHunkCount = String(this.entry.hunkIds.length);

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
                { scope: this.entry.hunkId ? "hunk" : "chunk", hunkId: this.entry.hunkId },
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
                { scope: this.entry.hunkId ? "hunk" : "chunk", hunkId: this.entry.hunkId },
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
    },
) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `cm-review-action cm-review-action-${type}`;
    button.dataset.reviewDecision = type;
    button.dataset.reviewDecisionScope = options.scope;
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
) {
    if (state.doc.lines === 0) {
        return 0;
    }

    if (entry.startLine >= state.doc.lines) {
        return state.doc.length;
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
): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    const entries = buildReviewControlEntries(
        allowDecisionActions,
        hunks,
        chunks,
    );

    for (const entry of entries) {
        const pos = getControlWidgetPos(state, entry);
        builder.add(
            pos,
            pos,
            Decoration.widget({
                widget: new ReviewControlWidget(entry, onDecision),
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

const reviewProjectionControlsTheme = EditorView.baseTheme({
    ".cm-review-chunk-controls-anchor": {
        position: "relative",
        display: "block",
        width: "100%",
        height: "0",
        overflow: "visible",
        zIndex: "3",
    },
    ".cm-review-chunk-controls": {
        position: "absolute",
        top: "6px",
        right: "10px",
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        padding: "3px",
        borderRadius: "8px",
        border: "1px solid color-mix(in srgb, var(--border) 82%, transparent)",
        background: "color-mix(in srgb, var(--bg-secondary) 86%, transparent)",
        backdropFilter: "blur(8px)",
        boxShadow: "0 6px 16px rgb(0 0 0 / 0.12)",
        opacity: "0",
        pointerEvents: "none",
        transform: "translateY(-4px)",
        transition: "opacity 140ms ease, transform 140ms ease",
        zIndex: "3",
    },
    ".cm-review-chunk-controls.is-hovered, .cm-review-chunk-controls:focus-within":
        {
            opacity: "1",
            pointerEvents: "auto",
            transform: "translateY(0)",
        },
    ".cm-review-chunk-line": {
        position: "relative",
    },
    ".cm-review-chunk-badge": {
        fontSize: "11px",
        lineHeight: "1",
        letterSpacing: "0.02em",
        textTransform: "uppercase",
        color: "var(--text-secondary)",
        padding: "0 4px 0 2px",
    },
    ".cm-review-action": {
        appearance: "none",
        border: "1px solid color-mix(in srgb, var(--accent) 18%, var(--border))",
        background:
            "color-mix(in srgb, var(--bg-primary) 78%, var(--bg-secondary))",
        color: "var(--text-primary)",
        borderRadius: "6px",
        fontSize: "11px",
        lineHeight: "1",
        padding: "6px 10px",
        cursor: "pointer",
        fontWeight: "600",
        pointerEvents: "auto",
    },
    ".cm-review-action:hover": {
        background: "color-mix(in srgb, var(--bg-tertiary) 88%, transparent)",
    },
    ".cm-review-action-reject": {
        color: "var(--diff-remove)",
        borderColor:
            "color-mix(in srgb, var(--diff-remove) 30%, var(--border))",
        background:
            "color-mix(in srgb, var(--diff-remove) 10%, var(--bg-primary))",
    },
    ".cm-review-action-accept": {
        color: "var(--diff-add)",
        borderColor: "color-mix(in srgb, var(--diff-add) 30%, var(--border))",
        background:
            "color-mix(in srgb, var(--diff-add) 10%, var(--bg-primary))",
    },
    ".cm-review-action-reject:hover": {
        background:
            "color-mix(in srgb, var(--diff-remove) 16%, var(--bg-primary))",
    },
    ".cm-review-action-accept:hover": {
        background:
            "color-mix(in srgb, var(--diff-add) 16%, var(--bg-primary))",
    },
    ".cm-review-chunk-ambiguous": {
        fontSize: "11px",
        color: "var(--text-secondary)",
        padding: "6px 8px",
        borderRadius: "6px",
        background:
            "color-mix(in srgb, var(--bg-primary) 78%, var(--bg-secondary))",
        border: "1px solid color-mix(in srgb, var(--border) 74%, transparent)",
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

export function createReviewProjectionControlsExtension(
    config: CreateReviewProjectionControlsConfig,
): Extension[] {
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
            );
        },
        update(_decorations, transaction) {
            return buildControlsDecorations(
                transaction.state,
                config.allowDecisionActions,
                config.hunks,
                config.chunks,
                config.onDecision,
            );
        },
        provide: (field) => EditorView.decorations.from(field),
    });

    return [
        lineField,
        controlsField,
        reviewProjectionControlsTheme,
        reviewProjectionControlsHoverPlugin,
    ];
}
