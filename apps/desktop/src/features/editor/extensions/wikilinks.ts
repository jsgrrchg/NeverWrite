import {
    Decoration,
    type DecorationSet,
    EditorView,
    ViewPlugin,
    type ViewUpdate,
} from "@codemirror/view";
import {
    type EditorState,
    RangeSetBuilder,
    StateEffect,
} from "@codemirror/state";
import {
    perfCount,
    perfMeasure,
    perfNow,
} from "../../../app/utils/perfInstrumentation";
import { selectionTouchesRange } from "./selectionActivity";

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;
// Characters that can affect wikilink structure: brackets, pipe, newlines.
const WIKILINK_SIGNIFICANT = /(?:[\]\n\r|]|\[)/;

const DENSE_VISIBLE_WIKILINK_THRESHOLD = 50;
const DENSE_IMMEDIATE_TARGET_LIMIT = 48;
const DENSE_DEFERRED_BATCH_LIMIT = 64;

type IdleDeadlineLike = {
    didTimeout: boolean;
    timeRemaining(): number;
};

type IdleCallbackHandle = number;

interface WikilinkMatch {
    from: number;
    to: number;
    target: string;
    /** The text between [[ and ]], cached to avoid re-slicing. */
    inner: string;
}

function getActiveWikilinkSignature(
    state: EditorState,
    links: readonly WikilinkMatch[],
) {
    if (!links.length) return "";

    const activeKeys: string[] = [];
    for (const link of links) {
        if (selectionTouchesRange(state, link.from, link.to)) {
            activeKeys.push(`${link.from}:${link.to}`);
        }
    }

    return activeKeys.join("|");
}

function findWikilinksInText(doc: string, offset = 0): WikilinkMatch[] {
    const results: WikilinkMatch[] = [];
    let match;
    WIKILINK_RE.lastIndex = 0;
    while ((match = WIKILINK_RE.exec(doc)) !== null) {
        const inner = match[1];
        const pipeIndex = inner.indexOf("|");
        const target =
            pipeIndex >= 0 ? inner.slice(0, pipeIndex).trim() : inner.trim();
        results.push({
            from: offset + match.index,
            to: offset + match.index + match[0].length,
            target,
            inner,
        });
    }
    return results;
}

function findVisibleWikilinks(view: EditorView): WikilinkMatch[] {
    const matches: WikilinkMatch[] = [];
    for (const { from, to } of view.visibleRanges) {
        const text = view.state.sliceDoc(from, to);
        matches.push(...findWikilinksInText(text, from));
    }
    return matches;
}

function findWikilinkAtPosition(
    view: EditorView,
    pos: number,
): WikilinkMatch | null {
    const line = view.state.doc.lineAt(pos);
    return (
        findWikilinksInText(line.text, line.from).find(
            (link) => pos >= link.from && pos <= link.to,
        ) ?? null
    );
}

export type WikilinkBatchResolver = (
    noteId: string | null,
    targets: readonly string[],
    onResolved?: () => void,
) => ReadonlyMap<string, "valid" | "broken" | "pending">;
export type WikilinkNavigator = (target: string) => void;
export type WikilinkNoteContext = () => string | null;

const refreshWikilinksEffect = StateEffect.define<null>();

// Cache Decoration.mark objects keyed by "target\0state" to avoid
// allocating new Decoration + attributes objects for every link on
// every rebuild. The cache is small (one entry per unique target×state)
// and grows/shrinks naturally as the viewport changes.
const wikilinkMarkCache = new Map<string, Decoration>();

function isViewDetached(view: EditorView) {
    return !view.dom.isConnected;
}

function wikilinkMark(
    target: string,
    resolution: "valid" | "broken" | "pending",
): Decoration {
    const key = `${target}\0${resolution}`;
    let mark = wikilinkMarkCache.get(key);
    if (mark) return mark;

    const className =
        resolution === "valid"
            ? "cm-wikilink cm-wikilink-valid"
            : resolution === "broken"
              ? "cm-wikilink cm-wikilink-broken"
              : "cm-wikilink cm-wikilink-pending";
    mark = Decoration.mark({
        class: className,
        attributes: {
            "data-wikilink-target": target,
            "data-wikilink-state": resolution,
        },
    });
    wikilinkMarkCache.set(key, mark);
    return mark;
}

function requestIdleWork(
    callback: (deadline: IdleDeadlineLike) => void,
): IdleCallbackHandle {
    if ("requestIdleCallback" in globalThis) {
        return globalThis.requestIdleCallback(callback, {
            timeout: 150,
        });
    }

    return window.setTimeout(() => {
        callback({
            didTimeout: false,
            timeRemaining: () => 0,
        });
    }, 16);
}

function cancelIdleWork(handle: IdleCallbackHandle | null) {
    if (handle === null) return;
    if ("cancelIdleCallback" in globalThis) {
        globalThis.cancelIdleCallback(handle);
        return;
    }
    window.clearTimeout(handle);
}

function rankVisibleTargetsByCaretDistance(
    visibleLinks: readonly WikilinkMatch[],
    caretPos: number,
) {
    const distances = new Map<string, number>();

    for (const link of visibleLinks) {
        const midpoint = link.from + (link.to - link.from) / 2;
        const distance = Math.abs(midpoint - caretPos);
        const previous = distances.get(link.target);
        if (previous === undefined || distance < previous) {
            distances.set(link.target, distance);
        }
    }

    return [...distances.entries()]
        .sort(
            (left, right) =>
                left[1] - right[1] || left[0].localeCompare(right[0]),
        )
        .map(([target]) => target);
}

function isWikilinkSafeEdit(update: ViewUpdate): boolean {
    let safe = true;
    update.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
        if (!safe) return;
        if (toA > fromA) {
            if (
                WIKILINK_SIGNIFICANT.test(
                    update.startState.doc.sliceString(fromA, toA),
                )
            ) {
                safe = false;
                return;
            }
        }
        if (toB > fromB) {
            if (
                WIKILINK_SIGNIFICANT.test(
                    update.state.doc.sliceString(fromB, toB),
                )
            ) {
                safe = false;
            }
        }
    });
    return safe;
}

export function wikilinkExtension(
    resolveLinkBatch: WikilinkBatchResolver,
    getNoteId: WikilinkNoteContext,
    navigateToLink: WikilinkNavigator,
) {
    const plugin = ViewPlugin.fromClass(
        class {
            decorations: DecorationSet;
            deferredDenseResolutionHandle: IdleCallbackHandle | null = null;
            deferredDenseResolutionVersion = 0;
            visibleLinks: WikilinkMatch[] = [];
            activeWikilinkSignature = "";
            denseMode = false;

            constructor(view: EditorView) {
                this.decorations = this.build(view, "initial");
            }

            destroy() {
                this.cancelDeferredDenseResolution();
            }

            update(update: ViewUpdate) {
                if (update.docChanged) {
                    // Fast path: edits without bracket/pipe/newline chars
                    // can't create or destroy wikilinks — just remap positions.
                    if (isWikilinkSafeEdit(update)) {
                        this.decorations = this.decorations.map(update.changes);
                        return;
                    }
                    this.decorations = this.build(update.view, "docChanged");
                    return;
                }

                // Check for refresh effects (async resolution callbacks)
                if (
                    update.transactions.some((transaction) =>
                        transaction.effects.some((effect) =>
                            effect.is(refreshWikilinksEffect),
                        ),
                    )
                ) {
                    this.decorations = this.build(
                        update.view,
                        "viewportChanged",
                    );
                    return;
                }

                if (update.viewportChanged) {
                    this.decorations = this.build(
                        update.view,
                        "viewportChanged",
                    );
                    return;
                }

                if (!update.selectionSet) return;
                if (!this.denseMode) {
                    const nextActiveSignature = getActiveWikilinkSignature(
                        update.state,
                        this.visibleLinks,
                    );
                    if (nextActiveSignature === this.activeWikilinkSignature) {
                        perfCount("editor.wikilinks.selectionSet.skipped", {
                            visibleLinks: this.visibleLinks.length,
                        });
                        return;
                    }
                }
                this.decorations = this.build(update.view, "selectionSet");
            }

            cancelDeferredDenseResolution() {
                this.deferredDenseResolutionVersion += 1;
                cancelIdleWork(this.deferredDenseResolutionHandle);
                this.deferredDenseResolutionHandle = null;
            }

            scheduleDeferredDenseResolution(
                view: EditorView,
                noteId: string | null,
                targets: readonly string[],
            ) {
                this.cancelDeferredDenseResolution();
                if (!noteId || targets.length === 0) {
                    return;
                }

                const version = this.deferredDenseResolutionVersion;
                let index = 0;

                const scheduleNext = () => {
                    this.deferredDenseResolutionHandle = requestIdleWork(
                        (deadline) => {
                            if (
                                isViewDetached(view) ||
                                version !== this.deferredDenseResolutionVersion
                            ) {
                                return;
                            }

                            const batch: string[] = [];
                            while (
                                index < targets.length &&
                                batch.length < DENSE_DEFERRED_BATCH_LIMIT &&
                                (batch.length === 0 ||
                                    deadline.didTimeout ||
                                    deadline.timeRemaining() > 3)
                            ) {
                                batch.push(targets[index]);
                                index += 1;
                            }

                            if (batch.length > 0) {
                                perfCount(
                                    "editor.wikilinks.dense.deferred.batch",
                                );
                                resolveLinkBatch(noteId, batch, () => {
                                    if (
                                        isViewDetached(view) ||
                                        version !==
                                            this.deferredDenseResolutionVersion
                                    ) {
                                        return;
                                    }
                                    view.dispatch({
                                        effects:
                                            refreshWikilinksEffect.of(null),
                                    });
                                });
                            }

                            if (index < targets.length) {
                                scheduleNext();
                                return;
                            }

                            this.deferredDenseResolutionHandle = null;
                        },
                    );
                };

                scheduleNext();
            }

            build(
                view: EditorView,
                reason:
                    | "initial"
                    | "docChanged"
                    | "viewportChanged"
                    | "selectionSet",
            ): DecorationSet {
                const startMs = perfNow();
                const builder = new RangeSetBuilder<Decoration>();
                const visibleLinks = findVisibleWikilinks(view);
                const rankedTargets = rankVisibleTargetsByCaretDistance(
                    visibleLinks,
                    view.state.selection.main.head,
                );
                const denseMode =
                    visibleLinks.length > DENSE_VISIBLE_WIKILINK_THRESHOLD;
                this.visibleLinks = visibleLinks;
                this.activeWikilinkSignature = getActiveWikilinkSignature(
                    view.state,
                    visibleLinks,
                );
                this.denseMode = denseMode;
                const immediateTargets = denseMode
                    ? rankedTargets.slice(0, DENSE_IMMEDIATE_TARGET_LIMIT)
                    : rankedTargets;
                const deferredTargets = denseMode
                    ? rankedTargets.slice(DENSE_IMMEDIATE_TARGET_LIMIT)
                    : [];
                const noteId = getNoteId();
                const onResolved = () => {
                    if (isViewDetached(view)) return;
                    view.dispatch({
                        effects: refreshWikilinksEffect.of(null),
                    });
                };
                const resolvedImmediate = resolveLinkBatch(
                    noteId,
                    immediateTargets,
                    onResolved,
                );

                if (denseMode) {
                    perfCount("editor.wikilinks.dense.mode");
                    this.scheduleDeferredDenseResolution(
                        view,
                        noteId,
                        deferredTargets,
                    );
                } else {
                    this.cancelDeferredDenseResolution();
                }

                let decoratedLinks = 0;
                let pendingLinks = 0;

                for (const link of visibleLinks) {
                    if (selectionTouchesRange(view.state, link.from, link.to)) {
                        continue;
                    }

                    // Only decorate the visible text (exclude [[ ]] markers).
                    // Use cached inner text to avoid per-link sliceDoc calls.
                    const pipeIdx = link.inner.indexOf("|");
                    const visibleFrom =
                        pipeIdx >= 0
                            ? link.from + 2 + pipeIdx + 1
                            : link.from + 2;
                    const visibleTo = link.to - 2;
                    if (visibleFrom >= visibleTo) continue;

                    const resolution =
                        resolvedImmediate.get(link.target) ?? "pending";
                    builder.add(
                        visibleFrom,
                        visibleTo,
                        wikilinkMark(link.target, resolution),
                    );
                    decoratedLinks += 1;
                    if (resolution === "pending") {
                        pendingLinks += 1;
                    }
                }
                perfMeasure(`editor.wikilinks.build.${reason}`, startMs, {
                    visibleLinks: visibleLinks.length,
                    decoratedLinks,
                    pendingLinks,
                    denseMode,
                    uniqueTargets: rankedTargets.length,
                    batchTargetCount: immediateTargets.length,
                    deferredTargetCount: deferredTargets.length,
                    visibleRanges: view.visibleRanges.length,
                    viewportChars: view.visibleRanges.reduce(
                        (total, range) => total + (range.to - range.from),
                        0,
                    ),
                    activeVisibleLinks: this.activeWikilinkSignature
                        ? this.activeWikilinkSignature.split("|").length
                        : 0,
                });
                if (reason === "docChanged") {
                    perfCount("editor.wikilinks.docChanged");
                }
                return builder.finish();
            }
        },
        {
            decorations: (v) => v.decorations,
        },
    );

    const clickHandler = EditorView.domEventHandlers({
        click(event: MouseEvent, view: EditorView) {
            const target = event.target as HTMLElement;
            if (!target.closest(".cm-wikilink")) return false;

            const pos = view.posAtCoords({
                x: event.clientX,
                y: event.clientY,
            });
            if (pos === null) return false;

            const clicked = findWikilinkAtPosition(view, pos);
            if (clicked) {
                event.preventDefault();
                navigateToLink(clicked.target);
                return true;
            }
            return false;
        },
    });

    const theme = EditorView.baseTheme({
        ".cm-wikilink": {
            cursor: "pointer",
            textDecoration: "underline",
            textDecorationStyle: "dotted",
            textUnderlineOffset: "3px",
        },
        ".cm-wikilink-valid": {
            color: "var(--accent)",
        },
        ".cm-wikilink-broken": {
            color: "#ef4444",
            textDecorationColor: "#ef4444",
        },
        ".cm-wikilink-pending": {
            color: "var(--text-secondary)",
            textDecorationColor:
                "color-mix(in srgb, var(--text-secondary) 60%, transparent)",
        },
    });

    return [plugin, clickHandler, theme];
}
