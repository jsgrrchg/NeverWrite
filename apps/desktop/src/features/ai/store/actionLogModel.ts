/**
 * ActionLog model — Pure functions for patch-based change tracking.
 *
 * Follows the same pattern as editedFilesBufferModel.ts: no store imports,
 * all functions are pure and testable in isolation.
 */

import {
    TRACKED_FILE_CANONICAL_FIELDS,
    TRACKED_FILE_DERIVED_FIELDS,
} from "../diff/actionLogTypes";
import type {
    ActionLogState,
    AgentTextSpan,
    HunkWordDiffs,
    LineEdit,
    LinePatch,
    PerFileUndo,
    ReviewState,
    TextEdit,
    TextRangePatch,
    TrackedFile,
    TrackedFileCanonicalField,
    TrackedFileDerivedField,
    TrackedFileDomainInvariantId,
    TrackedFileStatus,
} from "../diff/actionLogTypes";
import type { AIFileDiff, AIFileDiffHunk, AIFileDiffHunkLine } from "../types";
import {
    resolveReviewIndexHunksToExactSpans,
    type ReviewHunkMemberSpan,
} from "../diff/reviewProjectionIndex";
import { buildLineStartOffsets, lineIndexToOffset } from "../diff/lineMap";
import {
    applyNonConflictingEditsRust,
    applyRejectUndoRust,
    buildPatchFromTextsRust,
    buildTextRangePatchFromTextsRust,
    computeWordDiffsForHunkRust,
    deriveLinePatchFromTextRangesRust,
    keepExactSpansRust,
    mapAgentSpanThroughTextEditsRust,
    mapTextPositionThroughEditsRust,
    partitionSpansByOverlapRust,
    rebuildDiffBaseFromPendingSpansRust,
    rejectAllEditsRust,
    rejectExactSpansRust,
    syncDerivedLinePatchRust,
} from "./actionLogRustEngine";
import { pathsMatchVaultScoped } from "../../../app/utils/vaultPaths";
import { logWarn } from "../../../app/utils/runtimeLog";

// ---------------------------------------------------------------------------
// Patch primitives
// ---------------------------------------------------------------------------

export function emptyPatch(): LinePatch {
    return { edits: [] };
}

export function emptyTextRangePatch(): TextRangePatch {
    return { spans: [] };
}

export function patchIsEmpty(patch: LinePatch): boolean {
    return patch.edits.length === 0;
}

/** Check whether `line` falls inside any edit's *new* range. */
export function patchContainsLine(patch: LinePatch, line: number): boolean {
    return patch.edits.some(
        (edit) => line >= edit.newStart && line < edit.newEnd,
    );
}

/** Do [aStart, aEnd) and [bStart, bEnd) overlap? */
export function rangesOverlap(
    aStart: number,
    aEnd: number,
    bStart: number,
    bEnd: number,
): boolean {
    // Two empty (point) ranges at the same position overlap — needed for
    // pure deletions where newStart === newEnd.
    if (aStart === aEnd && bStart === bEnd) return aStart === bStart;
    return aStart < bEnd && bStart < aEnd;
}

/**
 * Shift all edits whose newStart >= `afterLine` by `delta` lines.
 * Returns a new array (does not mutate).
 */
export function shiftEditsAfter(
    edits: LineEdit[],
    afterLine: number,
    delta: number,
): LineEdit[] {
    return edits.map((edit) => {
        if (edit.newStart >= afterLine) {
            return {
                ...edit,
                newStart: edit.newStart + delta,
                newEnd: edit.newEnd + delta,
            };
        }
        return edit;
    });
}

const syncedTrackedFileCache = new WeakMap<TrackedFile, TrackedFile>();
const syncedTrackedFilesCache = new WeakMap<
    Record<string, TrackedFile>,
    Record<string, TrackedFile>
>();
const normalizedActionLogStorageCache = new WeakMap<
    ActionLogState,
    {
        trackedFilesByIdentityKey: Record<string, TrackedFile>;
        trackedFileIdsByWorkCycleId: Record<string, string[]>;
        trackedFilesByWorkCycleId: Record<string, Record<string, TrackedFile>>;
    }
>();

const TRACKED_FILE_DOMAIN_INVARIANTS: readonly TrackedFileDomainInvariantId[] =
    [
        "empty_diff_has_no_pending_ranges",
        "empty_diff_has_no_pending_line_patch",
        "pending_ranges_cover_visible_diff",
        "pending_ranges_rebuild_diff_base",
        "line_patch_matches_ranges",
        "diff_base_hash_matches_content",
    ];

export interface TrackedFileDomainContract {
    canonicalFields: readonly TrackedFileCanonicalField[];
    derivedFields: readonly TrackedFileDerivedField[];
    invariants: readonly TrackedFileDomainInvariantId[];
}

export interface TrackedFileDomainViolation {
    id: TrackedFileDomainInvariantId;
    message: string;
}

const TRACKED_FILE_DOMAIN_CONTRACT: TrackedFileDomainContract = {
    canonicalFields: TRACKED_FILE_CANONICAL_FIELDS,
    derivedFields: TRACKED_FILE_DERIVED_FIELDS,
    invariants: TRACKED_FILE_DOMAIN_INVARIANTS,
};

export function getTrackedFileDomainContract(): TrackedFileDomainContract {
    return TRACKED_FILE_DOMAIN_CONTRACT;
}

function spansEqual(a: AgentTextSpan[], b: AgentTextSpan[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((span, index) => {
        const other = b[index];
        return (
            span.baseFrom === other.baseFrom &&
            span.baseTo === other.baseTo &&
            span.currentFrom === other.currentFrom &&
            span.currentTo === other.currentTo
        );
    });
}

function spanEquals(left: AgentTextSpan, right: AgentTextSpan): boolean {
    return (
        left.baseFrom === right.baseFrom &&
        left.baseTo === right.baseTo &&
        left.currentFrom === right.currentFrom &&
        left.currentTo === right.currentTo
    );
}

function dedupeSpans(spans: AgentTextSpan[]): AgentTextSpan[] {
    const next: AgentTextSpan[] = [];
    for (const span of spans) {
        if (next.some((candidate) => spanEquals(candidate, span))) {
            continue;
        }
        next.push(span);
    }
    return next;
}

function linePatchesEqual(a: LinePatch, b: LinePatch): boolean {
    if (a.edits.length !== b.edits.length) return false;
    return a.edits.every((edit, index) => {
        const other = b.edits[index];
        return (
            edit.oldStart === other.oldStart &&
            edit.oldEnd === other.oldEnd &&
            edit.newStart === other.newStart &&
            edit.newEnd === other.newEnd
        );
    });
}

function uniqueTrackedFileIds(
    ids: string[],
    files: Record<string, TrackedFile>,
): string[] {
    const seen = new Set<string>();
    const next: string[] = [];

    for (const id of ids) {
        if (!(id in files) || seen.has(id)) {
            continue;
        }
        seen.add(id);
        next.push(id);
    }

    return next;
}

function getLegacyTrackedFilesByWorkCycleId(
    state: ActionLogState,
): Record<string, Record<string, TrackedFile>> {
    return state.trackedFilesByWorkCycleId ?? {};
}

function buildTrackedFilesByWorkCycleId(
    trackedFilesByIdentityKey: Record<string, TrackedFile>,
    trackedFileIdsByWorkCycleId: Record<string, string[]>,
): Record<string, Record<string, TrackedFile>> {
    const trackedFilesByWorkCycleId: Record<
        string,
        Record<string, TrackedFile>
    > = {};

    for (const [workCycleId, ids] of Object.entries(
        trackedFileIdsByWorkCycleId,
    )) {
        const uniqueIds = uniqueTrackedFileIds(ids, trackedFilesByIdentityKey);
        if (uniqueIds.length === 0) {
            continue;
        }

        const trackedFiles: Record<string, TrackedFile> = {};
        for (const identityKey of uniqueIds) {
            trackedFiles[identityKey] = trackedFilesByIdentityKey[identityKey]!;
        }
        trackedFilesByWorkCycleId[workCycleId] = trackedFiles;
    }

    return trackedFilesByWorkCycleId;
}

function normalizeActionLogStorage(state: ActionLogState): {
    trackedFilesByIdentityKey: Record<string, TrackedFile>;
    trackedFileIdsByWorkCycleId: Record<string, string[]>;
    trackedFilesByWorkCycleId: Record<string, Record<string, TrackedFile>>;
} {
    const cached = normalizedActionLogStorageCache.get(state);
    if (cached) {
        return cached;
    }

    const trackedFilesByIdentityKey = state.trackedFilesByIdentityKey
        ? syncTrackedFiles(state.trackedFilesByIdentityKey)
        : {};
    const trackedFileIdsByWorkCycleId: Record<string, string[]> = {};

    for (const [workCycleId, ids] of Object.entries(
        state.trackedFileIdsByWorkCycleId ?? {},
    )) {
        trackedFileIdsByWorkCycleId[workCycleId] = [...ids];
    }

    for (const [workCycleId, legacyFiles] of Object.entries(
        getLegacyTrackedFilesByWorkCycleId(state),
    )) {
        const syncedLegacyFiles = syncTrackedFiles(legacyFiles);
        const cycleIds = trackedFileIdsByWorkCycleId[workCycleId] ?? [];

        for (const [identityKey, file] of Object.entries(syncedLegacyFiles)) {
            const current = trackedFilesByIdentityKey[identityKey];
            if (!current || shouldPreferTrackedFile(file, current)) {
                trackedFilesByIdentityKey[identityKey] = file;
            }
            cycleIds.push(identityKey);
        }

        trackedFileIdsByWorkCycleId[workCycleId] = cycleIds;
    }

    for (const [workCycleId, ids] of Object.entries(
        trackedFileIdsByWorkCycleId,
    )) {
        const uniqueIds = uniqueTrackedFileIds(ids, trackedFilesByIdentityKey);
        if (uniqueIds.length === 0) {
            delete trackedFileIdsByWorkCycleId[workCycleId];
            continue;
        }
        trackedFileIdsByWorkCycleId[workCycleId] = uniqueIds;
    }

    const result = {
        trackedFilesByIdentityKey,
        trackedFileIdsByWorkCycleId,
        trackedFilesByWorkCycleId: buildTrackedFilesByWorkCycleId(
            trackedFilesByIdentityKey,
            trackedFileIdsByWorkCycleId,
        ),
    };

    normalizedActionLogStorageCache.set(state, result);
    return result;
}

function getTrackedFileCanonicalRanges(file: TrackedFile): TextRangePatch {
    return (
        file.unreviewedRanges ??
        (file.diffBase === file.currentText
            ? emptyTextRangePatch()
            : buildTextRangePatchFromTexts(file.diffBase, file.currentText))
    );
}

function getTrackedFileVisiblePatch(file: TrackedFile): LinePatch {
    if (file.diffBase === file.currentText) {
        return emptyPatch();
    }

    return buildPatchFromTexts(file.diffBase, file.currentText);
}

function getTrackedFileVisibleRanges(
    file: TrackedFile,
    visiblePatch = getTrackedFileVisiblePatch(file),
): TextRangePatch {
    if (file.diffBase === file.currentText) {
        return emptyTextRangePatch();
    }

    return buildTextRangePatchFromTexts(
        file.diffBase,
        file.currentText,
        visiblePatch,
    );
}

function trackedFileRangesRebuildDiffBase(
    file: TrackedFile,
    ranges = getTrackedFileCanonicalRanges(file),
): boolean {
    return (
        rebuildDiffBaseFromPendingSpans(
            file.diffBase,
            file.currentText,
            ranges.spans,
        ) === file.diffBase
    );
}

/**
 * Compute the canonical FNV-1a hash for a diffBase value. Returns "" for the
 * empty baseline so `diffBaseHash` is always a plain string when present.
 */
export function computeDiffBaseHash(diffBase: string): string {
    return hashTextContent(diffBase) ?? "";
}

function captureDiffBaseMetadata(
    diffBase: string,
    timestamp: number,
): { diffBaseHash: string; diffBaseCapturedAt: number } {
    return {
        diffBaseHash: computeDiffBaseHash(diffBase),
        diffBaseCapturedAt: timestamp,
    };
}

/**
 * Keep the previous diffBase metadata when `next` reuses the same diffBase,
 * and recompute it otherwise. Used to wrap Rust/JS engine results that may
 * replace diffBase without knowing about the hash cache.
 */
function reconcileDiffBaseMetadata(
    previous: TrackedFile,
    next: TrackedFile,
    now: number,
): TrackedFile {
    if (next.diffBase === previous.diffBase) {
        const prevHash = previous.diffBaseHash;
        const prevAt = previous.diffBaseCapturedAt;
        if (prevHash === undefined || prevAt === undefined) {
            // Parent was also missing metadata; fall through to recompute so
            // the first sync backfills it cleanly.
            return {
                ...next,
                ...captureDiffBaseMetadata(next.diffBase, now),
            };
        }
        if (
            next.diffBaseHash === prevHash &&
            next.diffBaseCapturedAt === prevAt
        ) {
            return next;
        }
        return {
            ...next,
            diffBaseHash: prevHash,
            diffBaseCapturedAt: prevAt,
        };
    }
    return {
        ...next,
        ...captureDiffBaseMetadata(next.diffBase, now),
    };
}

export function validateTrackedFileDomain(
    file: TrackedFile,
): TrackedFileDomainViolation[] {
    const violations: TrackedFileDomainViolation[] = [];
    const canonicalRanges = getTrackedFileCanonicalRanges(file);
    const visiblePatch = getTrackedFileVisiblePatch(file);
    const derivedPatch = deriveLinePatchFromTextRanges(
        file.diffBase,
        file.currentText,
        canonicalRanges.spans,
    );

    if (
        file.diffBase === file.currentText &&
        canonicalRanges.spans.length > 0
    ) {
        violations.push({
            id: "empty_diff_has_no_pending_ranges",
            message:
                "TrackedFile has no visible diff, but still carries pending text ranges.",
        });
    }

    if (
        file.diffBase === file.currentText &&
        !patchIsEmpty(file.unreviewedEdits)
    ) {
        violations.push({
            id: "empty_diff_has_no_pending_line_patch",
            message:
                "TrackedFile has no visible diff, but still carries pending line hunks.",
        });
    }

    if (!linePatchesEqual(derivedPatch, visiblePatch)) {
        violations.push({
            id: "pending_ranges_cover_visible_diff",
            message:
                "TrackedFile pending ranges no longer match the visible diff between diffBase and currentText.",
        });
    }

    if (!trackedFileRangesRebuildDiffBase(file, canonicalRanges)) {
        violations.push({
            id: "pending_ranges_rebuild_diff_base",
            message:
                "TrackedFile pending ranges no longer reconstruct the canonical diffBase from currentText.",
        });
    }

    if (!linePatchesEqual(file.unreviewedEdits, derivedPatch)) {
        violations.push({
            id: "line_patch_matches_ranges",
            message:
                "TrackedFile line hunks are out of sync with the canonical pending ranges.",
        });
    }

    const expectedDiffBaseHash = computeDiffBaseHash(file.diffBase);
    if (
        file.diffBaseHash !== undefined &&
        file.diffBaseHash !== expectedDiffBaseHash
    ) {
        violations.push({
            id: "diff_base_hash_matches_content",
            message:
                "TrackedFile diffBaseHash does not match hashTextContent(diffBase).",
        });
    }

    return violations;
}

function repairTrackedFileDomain(file: TrackedFile): TrackedFile {
    const visiblePatch = getTrackedFileVisiblePatch(file);
    const canonicalRanges = getTrackedFileCanonicalRanges(file);
    const rangesPatch = deriveLinePatchFromTextRanges(
        file.diffBase,
        file.currentText,
        canonicalRanges.spans,
    );
    const rangesStillCoverVisibleDiff = linePatchesEqual(
        rangesPatch,
        visiblePatch,
    );
    const rangesRebuildDiffBase = trackedFileRangesRebuildDiffBase(
        file,
        canonicalRanges,
    );
    const repairedRanges =
        rangesStillCoverVisibleDiff && rangesRebuildDiffBase
            ? canonicalRanges
            : getTrackedFileVisibleRanges(file, visiblePatch);
    const repairedLinePatch = deriveLinePatchFromTextRanges(
        file.diffBase,
        file.currentText,
        repairedRanges.spans,
    );
    const rangesAlreadySynced =
        file.unreviewedRanges &&
        spansEqual(file.unreviewedRanges.spans, repairedRanges.spans);
    const linePatchAlreadySynced = linePatchesEqual(
        file.unreviewedEdits,
        repairedLinePatch,
    );

    const expectedDiffBaseHash = computeDiffBaseHash(file.diffBase);
    const diffBaseHashSynced = file.diffBaseHash === expectedDiffBaseHash;
    // Backfill timestamp from updatedAt when missing so legacy sessions keep a
    // meaningful capture time instead of jumping to "now" at load.
    const repairedDiffBaseCapturedAt =
        file.diffBaseCapturedAt ?? file.updatedAt;
    const diffBaseCapturedAtSynced =
        file.diffBaseCapturedAt !== undefined &&
        file.diffBaseCapturedAt === repairedDiffBaseCapturedAt;

    if (
        rangesAlreadySynced &&
        linePatchAlreadySynced &&
        diffBaseHashSynced &&
        diffBaseCapturedAtSynced
    ) {
        return file;
    }

    return {
        ...file,
        unreviewedRanges: repairedRanges,
        unreviewedEdits: repairedLinePatch,
        diffBaseHash: expectedDiffBaseHash,
        diffBaseCapturedAt: repairedDiffBaseCapturedAt,
    };
}

function resolveTrackedFilePatches(
    diffBase: string,
    currentText: string,
): {
    unreviewedEdits: LinePatch;
    unreviewedRanges: TextRangePatch;
} {
    if (diffBase === currentText) {
        return {
            unreviewedEdits: emptyPatch(),
            unreviewedRanges: emptyTextRangePatch(),
        };
    }

    const unreviewedEdits = buildPatchFromTexts(diffBase, currentText);
    const unreviewedRanges = buildTextRangePatchFromTexts(
        diffBase,
        currentText,
        unreviewedEdits,
    );

    return {
        unreviewedEdits,
        unreviewedRanges,
    };
}

export function mapTextPositionThroughEdits(
    position: number,
    edits: TextEdit[],
    assoc: -1 | 1,
): number {
    return mapTextPositionThroughEditsRust(position, edits, assoc);
}

export function mapAgentSpanThroughTextEdits(
    span: AgentTextSpan,
    edits: TextEdit[],
): AgentTextSpan | null {
    return mapAgentSpanThroughTextEditsRust(span, edits);
}

export function rebuildDiffBaseFromPendingSpans(
    originalDiffBase: string,
    currentText: string,
    spans: AgentTextSpan[],
): string {
    return rebuildDiffBaseFromPendingSpansRust(
        originalDiffBase,
        currentText,
        spans,
    );
}

export function partitionSpansByOverlap(
    spans: AgentTextSpan[],
    ranges: Array<{ start: number; end: number }>,
    baseText: string,
    currentText: string,
): {
    overlapping: AgentTextSpan[];
    nonOverlapping: AgentTextSpan[];
} {
    return partitionSpansByOverlapRust(spans, ranges, baseText, currentText);
}

/** Build a line patch through the shared Rust diff engine. */
export function buildPatchFromTexts(
    oldText: string,
    newText: string,
): LinePatch {
    return buildPatchFromTextsRust(oldText, newText);
}

export function buildTextRangePatchFromTexts(
    oldText: string,
    newText: string,
    linePatch?: LinePatch,
): TextRangePatch {
    const effectiveLinePatch =
        linePatch ?? buildPatchFromTexts(oldText, newText);
    const patch = buildTextRangePatchFromTextsRust(
        oldText,
        newText,
        effectiveLinePatch,
    );
    return refineDisjointInlineSpans(
        oldText,
        newText,
        effectiveLinePatch,
        patch,
    );
}

function refineDisjointInlineSpans(
    baseText: string,
    currentText: string,
    linePatch: LinePatch,
    patch: TextRangePatch,
): TextRangePatch {
    if (patch.spans.length === 0 || linePatch.edits.length === 0) {
        return patch;
    }

    const baseLineStarts = buildLineStartOffsets(baseText);
    const currentLineStarts = buildLineStartOffsets(currentText);
    const editWindows = linePatch.edits.map((edit) => ({
        edit,
        baseFrom: lineIndexToOffset(baseLineStarts, baseText, edit.oldStart),
        baseTo: lineIndexToOffset(baseLineStarts, baseText, edit.oldEnd),
        currentFrom: lineIndexToOffset(
            currentLineStarts,
            currentText,
            edit.newStart,
        ),
        currentTo: lineIndexToOffset(
            currentLineStarts,
            currentText,
            edit.newEnd,
        ),
    }));
    const spanToEditIndex = patch.spans.map((span) =>
        editWindows.findIndex(
            (window) =>
                span.baseFrom >= window.baseFrom &&
                span.baseTo <= window.baseTo &&
                span.currentFrom >= window.currentFrom &&
                span.currentTo <= window.currentTo,
        ),
    );
    const spansPerEdit = new Map<number, number>();
    spanToEditIndex.forEach((editIndex) => {
        if (editIndex < 0) return;
        spansPerEdit.set(editIndex, (spansPerEdit.get(editIndex) ?? 0) + 1);
    });

    let changed = false;
    const nextSpans: AgentTextSpan[] = [];

    patch.spans.forEach((span, spanIndex) => {
        const editIndex = spanToEditIndex[spanIndex] ?? -1;
        if (editIndex < 0 || spansPerEdit.get(editIndex) !== 1) {
            nextSpans.push(span);
            return;
        }

        const splitSpans = splitSingleLineSpanByWordDiff(
            baseText,
            currentText,
            editWindows[editIndex]!.edit,
            span,
        );
        if (!splitSpans) {
            nextSpans.push(span);
            return;
        }

        changed = true;
        nextSpans.push(...splitSpans);
    });

    return changed ? { spans: nextSpans } : patch;
}

function splitSingleLineSpanByWordDiff(
    baseText: string,
    currentText: string,
    edit: LineEdit,
    span: AgentTextSpan,
): AgentTextSpan[] | null {
    if (
        edit.oldEnd - edit.oldStart !== 1 ||
        edit.newEnd - edit.newStart !== 1
    ) {
        return null;
    }

    if (span.baseFrom === span.baseTo || span.currentFrom === span.currentTo) {
        return null;
    }

    const wordDiffs = computeWordDiffsForHunk(baseText, currentText, edit, {
        maxLines: 1,
        maxChars: 4000,
    });
    if (!wordDiffs) {
        return null;
    }

    const baseRanges = wordDiffs.baseRanges;
    const bufferRanges = wordDiffs.bufferRanges;
    if (baseRanges.length <= 1 || baseRanges.length !== bufferRanges.length) {
        return null;
    }

    const candidates: AgentTextSpan[] = [];
    for (let index = 0; index < baseRanges.length; index += 1) {
        const baseRange = baseRanges[index]!;
        const bufferRange = bufferRanges[index]!;
        const candidate: AgentTextSpan = {
            baseFrom: baseRange.baseFrom,
            baseTo: baseRange.baseTo,
            currentFrom: bufferRange.from,
            currentTo: bufferRange.to,
        };

        const insideSpan =
            candidate.baseFrom >= span.baseFrom &&
            candidate.baseTo <= span.baseTo &&
            candidate.currentFrom >= span.currentFrom &&
            candidate.currentTo <= span.currentTo;
        if (!insideSpan) {
            return null;
        }
        if (
            candidate.baseFrom === candidate.baseTo ||
            candidate.currentFrom === candidate.currentTo
        ) {
            return null;
        }

        candidates.push(candidate);
    }

    candidates.sort(
        (left, right) =>
            left.currentFrom - right.currentFrom ||
            left.currentTo - right.currentTo ||
            left.baseFrom - right.baseFrom ||
            left.baseTo - right.baseTo,
    );

    for (let index = 1; index < candidates.length; index += 1) {
        const prev = candidates[index - 1]!;
        const next = candidates[index]!;
        if (prev.currentTo > next.currentFrom || prev.baseTo > next.baseFrom) {
            return null;
        }
    }

    return candidates.length > 1 ? candidates : null;
}

export function computeWordDiffsForHunk(
    baseText: string,
    currentText: string,
    edit: LineEdit,
    options: {
        maxLines?: number;
        maxChars?: number;
    } = {},
): HunkWordDiffs | null {
    return computeWordDiffsForHunkRust(baseText, currentText, edit, options);
}

export function deriveLinePatchFromTextRanges(
    baseText: string,
    currentText: string,
    spans: AgentTextSpan[],
): LinePatch {
    return deriveLinePatchFromTextRangesRust(baseText, currentText, spans);
}

/**
 * Cached form of a TrackedFile with derived fields in sync with canonical
 * state. The cache is keyed by object identity — callers MUST create a new
 * TrackedFile instance whenever any canonical field changes. In-place
 * mutation would leave the cache returning a stale derived view against a
 * mutated canonical baseline. A DEV assertion below guards against that
 * anti-pattern: if the cached hit disagrees with the canonical baseline, we
 * log and bypass the cache instead of returning stale data.
 */
export function syncDerivedLinePatch(file: TrackedFile): TrackedFile {
    const cached = syncedTrackedFileCache.get(file);
    if (cached) {
        if (import.meta.env.DEV) {
            const expectedHash = computeDiffBaseHash(file.diffBase);
            if (
                cached.version !== file.version ||
                (cached.diffBaseHash !== undefined &&
                    cached.diffBaseHash !== expectedHash)
            ) {
                logWarn(
                    "action-log-engine",
                    "sync cache hit disagrees with canonical TrackedFile; bypassing (likely in-place mutation upstream)",
                    {
                        identityKey: file.identityKey,
                        cachedVersion: cached.version,
                        fileVersion: file.version,
                        cachedHash: cached.diffBaseHash,
                        expectedHash,
                    },
                    {
                        onceKey: `action-log-engine:stale-sync-cache:${file.identityKey}`,
                    },
                );
                syncedTrackedFileCache.delete(file);
            } else {
                return cached;
            }
        } else {
            return cached;
        }
    }

    const synced = repairTrackedFileDomain(syncDerivedLinePatchRust(file));
    const result =
        file.unreviewedRanges &&
        synced.unreviewedRanges &&
        spansEqual(
            file.unreviewedRanges.spans,
            synced.unreviewedRanges.spans,
        ) &&
        linePatchesEqual(file.unreviewedEdits, synced.unreviewedEdits)
            ? file
            : synced;

    syncedTrackedFileCache.set(file, result);
    return result;
}

function syncTrackedFiles(
    files: Record<string, TrackedFile>,
): Record<string, TrackedFile> {
    const cached = syncedTrackedFilesCache.get(files);
    if (cached) {
        return cached;
    }

    let changed = false;
    const next: Record<string, TrackedFile> = {};

    for (const [key, file] of Object.entries(files)) {
        const synced = syncDerivedLinePatch(file);
        next[key] = synced;
        if (synced !== file) {
            changed = true;
        }
    }

    const result = changed ? next : files;
    syncedTrackedFilesCache.set(files, result);
    return result;
}

export function getTrackedFileReviewState(file: TrackedFile): ReviewState {
    return file.reviewState ?? "finalized";
}

export function finalizeTrackedFile(file: TrackedFile): TrackedFile {
    if (getTrackedFileReviewState(file) === "finalized") {
        return file;
    }

    return {
        ...file,
        reviewState: "finalized",
        version: file.version + 1,
    };
}

export function finalizeTrackedFiles(
    files: Record<string, TrackedFile>,
): Record<string, TrackedFile> {
    let changed = false;
    const next: Record<string, TrackedFile> = {};

    for (const [key, file] of Object.entries(files)) {
        const finalized = finalizeTrackedFile(file);
        next[key] = finalized;
        if (finalized !== file) {
            changed = true;
        }
    }

    return changed ? next : files;
}

// ---------------------------------------------------------------------------
// TrackedFile creation / update from AIFileDiff
// ---------------------------------------------------------------------------

function statusFromDiffKind(kind: AIFileDiff["kind"]): TrackedFileStatus {
    switch (kind) {
        case "add":
            return { kind: "created", existingFileContent: null };
        case "delete":
            return { kind: "deleted" };
        default:
            // "update" | "move"
            return { kind: "modified" };
    }
}

export function createTrackedFileFromDiff(
    diff: AIFileDiff,
    timestamp: number,
): TrackedFile {
    const oldText = diff.old_text ?? "";
    const newText = diff.new_text ?? "";
    const status = statusFromDiffKind(diff.kind);

    // For "add", diffBase is empty (file didn't exist).
    // For "delete", currentText is empty (file will be removed).
    const diffBase = diff.kind === "add" ? "" : oldText;
    const currentText = diff.kind === "delete" ? "" : newText;

    const { unreviewedEdits, unreviewedRanges } = resolveTrackedFilePatches(
        diffBase,
        currentText,
    );

    return {
        identityKey: diff.path,
        originPath: diff.previous_path ?? diff.path,
        path: diff.path,
        previousPath: diff.previous_path ?? null,
        status,
        reviewState: "pending",
        diffBase,
        ...captureDiffBaseMetadata(diffBase, timestamp),
        currentText,
        unreviewedRanges,
        unreviewedEdits,
        version: 1,
        isText: diff.is_text !== false,
        updatedAt: timestamp,
    };
}

/**
 * Whether a TrackedFile has reliable enough data to show inline
 * decorations in the editor.  When `diffBase` is empty for a
 * non-created file it means `old_text` was missing from the agent
 * diff, so the computed line positions would be wrong (everything
 * at line 0).
 */
export function shouldShowInlineDiff(tracked: TrackedFile): boolean {
    const synced = syncDerivedLinePatch(tracked);
    if (synced.unreviewedEdits.edits.length === 0) return false;
    if (synced.diffBase === "" && synced.status.kind !== "created")
        return false;
    return true;
}

export function updateTrackedFileWithDiff(
    file: TrackedFile,
    diff: AIFileDiff,
    timestamp: number,
): TrackedFile {
    const newText = diff.new_text ?? "";
    const currentText = diff.kind === "delete" ? "" : newText;

    // diffBase stays the same (always the pre-agent state)
    const { unreviewedEdits, unreviewedRanges } = resolveTrackedFilePatches(
        file.diffBase,
        currentText,
    );

    // Update status if operation changed (e.g. update → delete)
    let { status } = file;
    if (diff.kind === "delete") {
        status = { kind: "deleted" };
    } else if (
        status.kind === "deleted" &&
        (diff.kind === "update" || diff.kind === "move")
    ) {
        status = { kind: "modified" };
    }

    return {
        ...file,
        path: diff.path,
        previousPath: diff.previous_path ?? file.previousPath,
        status,
        reviewState: "pending",
        currentText,
        unreviewedRanges,
        unreviewedEdits,
        conflictHash: null,
        version: file.version + 1,
        updatedAt: timestamp,
    };
}

export function replaceTrackedFileCurrentText(
    file: TrackedFile,
    currentText: string,
    timestamp: number,
): TrackedFile {
    const synced = syncDerivedLinePatch(file);
    const { unreviewedEdits, unreviewedRanges } = resolveTrackedFilePatches(
        synced.diffBase,
        currentText,
    );

    const didChangeText = synced.currentText !== currentText;
    const didClearConflict = synced.conflictHash !== null;
    if (!didChangeText && !didClearConflict) {
        return synced;
    }

    return {
        ...synced,
        currentText,
        unreviewedRanges,
        unreviewedEdits,
        conflictHash: null,
        version: didChangeText ? synced.version + 1 : synced.version,
        updatedAt: timestamp,
    };
}

// ---------------------------------------------------------------------------
// Consolidation (replaces consolidateEditedFilesBuffer for new sessions)
// ---------------------------------------------------------------------------

function getDiffLookupKey(diff: AIFileDiff): string {
    return diff.kind === "move" && diff.previous_path
        ? diff.previous_path
        : diff.path;
}

function findTrackedFile(
    files: Record<string, TrackedFile>,
    diff: AIFileDiff,
    options?: {
        vaultPath?: string | null;
    },
): TrackedFile | null {
    const key = getDiffLookupKey(diff);
    if (files[key]) return files[key];
    const vaultPath = options?.vaultPath ?? null;

    // Fallback: search by path or originPath for moves
    if (diff.kind === "move" && diff.previous_path) {
        for (const file of Object.values(files)) {
            if (
                pathsMatchVaultScoped(
                    file.path,
                    diff.previous_path,
                    vaultPath,
                    {
                        includeLegacyLeadingSlashRelative: true,
                    },
                ) ||
                pathsMatchVaultScoped(
                    file.originPath,
                    diff.previous_path,
                    vaultPath,
                    {
                        includeLegacyLeadingSlashRelative: true,
                    },
                )
            ) {
                return file;
            }
        }
    }

    // Fallback: search by current path for any diff type (handles move+update sequences)
    for (const file of Object.values(files)) {
        if (
            pathsMatchVaultScoped(file.path, diff.path, vaultPath, {
                includeLegacyLeadingSlashRelative: true,
            }) ||
            pathsMatchVaultScoped(file.identityKey, diff.path, vaultPath, {
                includeLegacyLeadingSlashRelative: true,
            })
        ) {
            return file;
        }
    }

    return null;
}

export function consolidateTrackedFiles(
    files: Record<string, TrackedFile>,
    diffs: AIFileDiff[],
    timestamp: number,
    options?: {
        vaultPath?: string | null;
    },
): Record<string, TrackedFile> {
    const next = { ...files };

    for (const diff of diffs) {
        if (diff.is_text === false || diff.reversible === false) {
            continue; // Skip unsupported files
        }

        const existing = findTrackedFile(next, diff, options);

        if (existing) {
            // Remove old key if identity changed (e.g. move)
            if (existing.identityKey !== diff.path) {
                delete next[existing.identityKey];
            }
            const updated = updateTrackedFileWithDiff(
                existing,
                diff,
                timestamp,
            );
            // If changes revert to original, remove from tracking
            if (
                patchIsEmpty(updated.unreviewedEdits) &&
                updated.path === updated.originPath
            ) {
                delete next[updated.identityKey];
            } else {
                next[updated.identityKey] = updated;
            }
        } else {
            const tracked = createTrackedFileFromDiff(diff, timestamp);
            // Track if there are text changes, or if this is a move (path changed)
            if (
                !patchIsEmpty(tracked.unreviewedEdits) ||
                tracked.path !== tracked.originPath
            ) {
                next[tracked.identityKey] = tracked;
            }
        }
    }

    return next;
}

// ---------------------------------------------------------------------------
// applyNonConflictingEdits — the core algorithm from Zed
// ---------------------------------------------------------------------------

/**
 * When the user edits a file that has pending agent changes, absorb user
 * edits into diffBase while preserving only the agent hunks the user has not
 * touched.
 *
 * - Untouched agent hunks stay pending review
 * - Any agent hunk touched by the user is retired from agent attribution
 *
 * Returns updated TrackedFile (immutable).
 */
export function applyNonConflictingEdits(
    file: TrackedFile,
    userEdits: TextEdit[],
    newFullText: string,
): TrackedFile {
    const result = applyNonConflictingEditsRust(file, userEdits, newFullText);
    return reconcileDiffBaseMetadata(file, result, Date.now());
}

// ---------------------------------------------------------------------------
// Lifecycle-aware restore action
// ---------------------------------------------------------------------------

export type RestoreAction =
    | { kind: "delete" }
    | { kind: "write"; content: string; previousPath?: string }
    | { kind: "skip"; reason: "user_owns_content" };

/**
 * Compute the disk restore action needed to reject a tracked file,
 * based on its lifecycle status.
 */
export function computeRestoreAction(
    file: TrackedFile,
    liveText?: string | null,
): RestoreAction {
    switch (file.status.kind) {
        case "created":
            if (file.status.existingFileContent === null) {
                // Agent created the file from nothing — delete it only if the
                // live content still matches the agent-authored snapshot.
                if (
                    liveText == null ||
                    (typeof liveText === "string" &&
                        liveText !== file.currentText)
                ) {
                    return {
                        kind: "skip",
                        reason: "user_owns_content",
                    };
                }
                return { kind: "delete" };
            }
            // Agent overwrote an existing file — restore previous content
            return { kind: "write", content: file.status.existingFileContent };
        case "modified":
            // Revert to diffBase; undo rename if path changed
            return {
                kind: "write",
                content: file.diffBase,
                previousPath:
                    file.originPath !== file.path ? file.path : undefined,
            };
        case "deleted":
            // Agent deleted the file — restore from diffBase
            return { kind: "write", content: file.diffBase };
    }
}

// ---------------------------------------------------------------------------
// Accept / Reject operations
// ---------------------------------------------------------------------------

/**
 * Accept all agent edits for a file — clears unreviewed state.
 * The file is removed from tracking (caller should delete from map).
 */
export function keepAllEdits(file: TrackedFile): TrackedFile {
    const syncedFile = syncDerivedLinePatch(file);
    return {
        ...syncedFile,
        diffBase: syncedFile.currentText,
        ...captureDiffBaseMetadata(syncedFile.currentText, Date.now()),
        unreviewedRanges: emptyTextRangePatch(),
        unreviewedEdits: emptyPatch(),
        version: syncedFile.version + 1,
    };
}

export function keepExactSpans(
    file: TrackedFile,
    spans: AgentTextSpan[],
): TrackedFile {
    if (spans.length === 0) {
        return syncDerivedLinePatch(file);
    }

    // Exact review resolution is canonical-span based. This path must stay
    // independent from overlap-based line-range selection.
    const result = keepExactSpansRust(file, spans);
    return reconcileDiffBaseMetadata(file, result, Date.now());
}

export interface ReviewHunkSelection {
    trackedVersion: number;
    memberSpans: ReviewHunkMemberSpan[];
}

function collectExactSpansFromReviewSelections(
    file: TrackedFile,
    reviewSelections: readonly ReviewHunkSelection[],
): AgentTextSpan[] {
    const syncedFile = syncDerivedLinePatch(file);
    const currentSpans = syncedFile.unreviewedRanges?.spans ?? [];
    const selectedSpans = dedupeSpans(
        resolveReviewIndexHunksToExactSpans(reviewSelections),
    );

    if (
        reviewSelections.some(
            (selection) => selection.trackedVersion !== syncedFile.version,
        )
    ) {
        throw new Error(
            `Review hunk version mismatch for ${syncedFile.identityKey}: expected ${syncedFile.version}.`,
        );
    }

    const missingSpan = selectedSpans.find(
        (selected) =>
            !currentSpans.some((current) => spanEquals(current, selected)),
    );
    if (missingSpan) {
        throw new Error(
            `Review hunk span is stale for ${syncedFile.identityKey}. Recompute the review projection before resolving.`,
        );
    }

    return selectedSpans;
}

export function keepReviewHunks(
    file: TrackedFile,
    reviewHunks: readonly ReviewHunkSelection[],
): TrackedFile {
    return keepExactSpans(
        file,
        collectExactSpansFromReviewSelections(file, reviewHunks),
    );
}

/**
 * Reject all agent edits — revert file to diffBase.
 * Returns updated file + undo data.
 */
export function rejectAllEdits(file: TrackedFile): {
    file: TrackedFile;
    undoData: PerFileUndo;
} {
    const result = rejectAllEditsRust(file);
    return {
        file: reconcileDiffBaseMetadata(file, result.file, Date.now()),
        undoData: result.undoData,
    };
}

export function rejectExactSpans(
    file: TrackedFile,
    spans: AgentTextSpan[],
): { file: TrackedFile; undoData: PerFileUndo } {
    if (spans.length === 0) {
        return {
            file: syncDerivedLinePatch(file),
            undoData: {
                path: file.path,
                editsToRestore: [],
                previousStatus: file.status,
            },
        };
    }

    // Exact review resolution is canonical-span based. This path must stay
    // independent from overlap-based line-range selection.
    const result = rejectExactSpansRust(file, spans);
    return {
        file: reconcileDiffBaseMetadata(file, result.file, Date.now()),
        undoData: result.undoData,
    };
}

export function rejectReviewHunks(
    file: TrackedFile,
    reviewHunks: readonly ReviewHunkSelection[],
): { file: TrackedFile; undoData: PerFileUndo } {
    return rejectExactSpans(
        file,
        collectExactSpansFromReviewSelections(file, reviewHunks),
    );
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

/**
 * Restore agent edits that were previously rejected.
 * Applies the stored text back into the file.
 */
export function applyRejectUndo(
    file: TrackedFile,
    undo: PerFileUndo,
): TrackedFile {
    const result = applyRejectUndoRust(file, undo);
    return reconcileDiffBaseMetadata(file, result, Date.now());
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export function hashTextContent(
    text: string | null | undefined,
): string | null {
    if (text == null) return null;
    const bytes = new TextEncoder().encode(text);
    let hash = 0xcbf29ce484222325n;
    for (const byte of bytes) {
        hash ^= BigInt(byte);
        hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    return hash.toString(16).padStart(16, "0");
}

/** Derive the display operation from a TrackedFile's status and paths. */
export function getFileOperation(
    file: TrackedFile,
): "add" | "delete" | "move" | "update" {
    if (file.status.kind === "created") return "add";
    if (file.status.kind === "deleted") return "delete";
    if (file.originPath !== file.path) return "move";
    return "update";
}

/**
 * Convert a TrackedFile's unreviewedEdits into AIFileDiffHunk[] so that
 * the diff display can use the exact hunk path (buildExactHunkData)
 * instead of recomputing LCS. This bypasses the 700-line limit.
 */
export function unreviewedEditsToHunks(file: TrackedFile): AIFileDiffHunk[] {
    const syncedFile = syncDerivedLinePatch(file);
    if (patchIsEmpty(syncedFile.unreviewedEdits)) return [];

    const baseLines = syncedFile.diffBase.split("\n");
    const currentLines = syncedFile.currentText.split("\n");

    return syncedFile.unreviewedEdits.edits.map((edit) => {
        const lines: AIFileDiffHunkLine[] = [];

        for (let i = edit.oldStart; i < edit.oldEnd; i++) {
            lines.push({ type: "remove", text: baseLines[i] ?? "" });
        }
        for (let i = edit.newStart; i < edit.newEnd; i++) {
            lines.push({ type: "add", text: currentLines[i] ?? "" });
        }

        return {
            old_start: edit.oldStart + 1, // 0-based → 1-based
            old_count: edit.oldEnd - edit.oldStart,
            new_start: edit.newStart + 1,
            new_count: edit.newEnd - edit.newStart,
            lines,
        };
    });
}

// ---------------------------------------------------------------------------
// ActionLogState helpers
// ---------------------------------------------------------------------------

export function emptyActionLogState(): ActionLogState {
    return {
        trackedFilesByIdentityKey: {},
        trackedFileIdsByWorkCycleId: {},
        trackedFilesByWorkCycleId: {},
        lastRejectUndo: null,
    };
}

export function getTrackedFilesForWorkCycle(
    state: ActionLogState,
    workCycleId: string | null | undefined,
): Record<string, TrackedFile> {
    if (!workCycleId) return {};
    return (
        normalizeActionLogStorage(state).trackedFilesByWorkCycleId[
            workCycleId
        ] ?? {}
    );
}

function shouldPreferTrackedFile(
    candidate: TrackedFile,
    current: TrackedFile,
): boolean {
    if (candidate.updatedAt !== current.updatedAt) {
        return candidate.updatedAt > current.updatedAt;
    }
    if (candidate.version !== current.version) {
        return candidate.version > current.version;
    }
    const candidatePending = getTrackedFileReviewState(candidate) === "pending";
    const currentPending = getTrackedFileReviewState(current) === "pending";
    if (candidatePending !== currentPending) {
        return candidatePending;
    }
    return candidate.path >= current.path;
}

export function getTrackedFilesForSession(
    state: ActionLogState | null | undefined,
): Record<string, TrackedFile> {
    if (!state) {
        return {};
    }

    return normalizeActionLogStorage(state).trackedFilesByIdentityKey;
}

export function setTrackedFilesForWorkCycle(
    state: ActionLogState,
    workCycleId: string,
    files: Record<string, TrackedFile>,
): ActionLogState {
    const normalized = normalizeActionLogStorage(state);
    const syncedFiles = syncTrackedFiles(files);
    const trackedFileIdsByWorkCycleId = {
        ...normalized.trackedFileIdsByWorkCycleId,
    };

    if (Object.keys(syncedFiles).length === 0) {
        delete trackedFileIdsByWorkCycleId[workCycleId];
    } else {
        trackedFileIdsByWorkCycleId[workCycleId] = Object.keys(syncedFiles);
    }

    const candidateFiles = {
        ...normalized.trackedFilesByIdentityKey,
        ...syncedFiles,
    };
    const trackedFilesByIdentityKey: Record<string, TrackedFile> = {};
    const referencedIds = new Set(
        Object.values(trackedFileIdsByWorkCycleId).flat(),
    );

    for (const identityKey of referencedIds) {
        const file = candidateFiles[identityKey];
        if (file) {
            trackedFilesByIdentityKey[identityKey] = file;
        }
    }

    const trackedFilesByWorkCycleId = buildTrackedFilesByWorkCycleId(
        trackedFilesByIdentityKey,
        trackedFileIdsByWorkCycleId,
    );

    return {
        ...state,
        trackedFilesByIdentityKey,
        trackedFileIdsByWorkCycleId,
        trackedFilesByWorkCycleId,
    };
}
