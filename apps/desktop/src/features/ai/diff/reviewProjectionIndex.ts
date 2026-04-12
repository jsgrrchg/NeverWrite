import type { AgentTextSpan, TrackedFile } from "./actionLogTypes";
import { buildLineStartOffsets, deriveOffsetLineRange } from "./lineMap";
import {
  deriveLinePatchFromTextRanges,
  syncDerivedLinePatch,
} from "../store/actionLogModel";

export interface ReviewHunkId {
  trackedVersion: number;
  key: string;
}

export interface ReviewChunkId {
  trackedVersion: number;
  key: string;
}

export interface ReviewHunkMemberSpan {
  spanIndex: number;
  baseFrom: number;
  baseTo: number;
  currentFrom: number;
  currentTo: number;
}

export interface ReviewProjectionIndexHunk {
  id: ReviewHunkId;
  identityKey: string;
  trackedVersion: number;
  oldStartLine: number;
  oldEndLine: number;
  newStartLine: number;
  newEndLine: number;
  visualStartLine: number;
  visualEndLine: number;
  baseFrom: number;
  baseTo: number;
  currentFrom: number;
  currentTo: number;
  memberSpans: ReviewHunkMemberSpan[];
  chunkId: ReviewChunkId;
  overlapGroupId: string;
  overlapGroupSize: number;
  hasConflict: boolean;
}

export interface ReviewProjectionIndexChunk {
  id: ReviewChunkId;
  identityKey: string;
  trackedVersion: number;
  startLine: number;
  endLine: number;
  hunkIds: ReviewHunkId[];
  overlapGroupIds: string[];
  overlapGroupByHunkKey: Record<string, string>;
  overlapGroupSizeByHunkKey: Record<string, number>;
  multiHunk: boolean;
  hasConflict: boolean;
  ambiguous: boolean;
}

export interface ReviewProjectionIndex {
  trackedVersion: number;
  trackedFile: TrackedFile;
  hunks: readonly ReviewProjectionIndexHunk[];
  chunks: readonly ReviewProjectionIndexChunk[];
  hunkByIdKey: ReadonlyMap<string, ReviewProjectionIndexHunk>;
  chunkByIdKey: ReadonlyMap<string, ReviewProjectionIndexChunk>;
}

interface ReviewHunkSeed {
  id: ReviewHunkId;
  identityKey: string;
  trackedVersion: number;
  oldStartLine: number;
  oldEndLine: number;
  newStartLine: number;
  newEndLine: number;
  baseFrom: number;
  baseTo: number;
  currentFrom: number;
  currentTo: number;
  memberSpans: ReviewHunkMemberSpan[];
  hasConflict: boolean;
  visualStartLine: number;
  visualEndLine: number;
}

interface ReviewChunkSeed {
  id: ReviewChunkId;
  identityKey: string;
  trackedVersion: number;
  startLine: number;
  endLine: number;
  hunkIds: ReviewHunkId[];
  overlapGroupIds: string[];
  overlapGroupByHunkKey: Record<string, string>;
  overlapGroupSizeByHunkKey: Record<string, number>;
  multiHunk: boolean;
  hasConflict: boolean;
  ambiguous: boolean;
}

const projectionIndexCache = new WeakMap<TrackedFile, ReviewProjectionIndex>();
const DEFAULT_CHUNK_LINE_GAP = 1;

export function compareReviewSpans(
  left: Pick<
    AgentTextSpan,
    "currentFrom" | "currentTo" | "baseFrom" | "baseTo"
  >,
  right: Pick<
    AgentTextSpan,
    "currentFrom" | "currentTo" | "baseFrom" | "baseTo"
  >,
): number {
  return (
    left.currentFrom - right.currentFrom ||
    left.currentTo - right.currentTo ||
    left.baseFrom - right.baseFrom ||
    left.baseTo - right.baseTo
  );
}

function compareReviewHunkSeeds(
  left: Pick<
    ReviewHunkSeed,
    | "visualStartLine"
    | "visualEndLine"
    | "currentFrom"
    | "currentTo"
    | "baseFrom"
    | "baseTo"
    | "id"
  >,
  right: Pick<
    ReviewHunkSeed,
    | "visualStartLine"
    | "visualEndLine"
    | "currentFrom"
    | "currentTo"
    | "baseFrom"
    | "baseTo"
    | "id"
  >,
): number {
  return (
    left.visualStartLine - right.visualStartLine ||
    left.visualEndLine - right.visualEndLine ||
    compareReviewSpans(left, right) ||
    left.id.key.localeCompare(right.id.key)
  );
}

function deriveSpanLineRange(
  baseText: string,
  currentText: string,
  span: AgentTextSpan,
): {
  oldStartLine: number;
  oldEndLine: number;
  newStartLine: number;
  newEndLine: number;
} {
  const clampPointRangeToDocument = (
    lineCount: number,
    start: number,
    end: number,
  ) => {
    if (start !== end) {
      return { start, end };
    }

    const maxLineIndex = Math.max(0, lineCount - 1);
    const clampedPoint = Math.min(start, maxLineIndex);
    return { start: clampedPoint, end: clampedPoint };
  };

  const patch = deriveLinePatchFromTextRanges(baseText, currentText, [span]);
  const baseLineCount = buildLineStartOffsets(baseText).length;
  const currentLineCount = buildLineStartOffsets(currentText).length;
  if (patch.edits.length > 0) {
    const oldRange = clampPointRangeToDocument(
      baseLineCount,
      Math.min(...patch.edits.map((edit) => edit.oldStart)),
      Math.max(...patch.edits.map((edit) => edit.oldEnd)),
    );
    const newRange = clampPointRangeToDocument(
      currentLineCount,
      Math.min(...patch.edits.map((edit) => edit.newStart)),
      Math.max(...patch.edits.map((edit) => edit.newEnd)),
    );
    return {
      oldStartLine: oldRange.start,
      oldEndLine: oldRange.end,
      newStartLine: newRange.start,
      newEndLine: newRange.end,
    };
  }

  const baseLineStarts = buildLineStartOffsets(baseText);
  const currentLineStarts = buildLineStartOffsets(currentText);
  const baseRange = deriveOffsetLineRange(
    baseLineStarts,
    span.baseFrom,
    span.baseTo,
  );
  const currentRange = deriveOffsetLineRange(
    currentLineStarts,
    span.currentFrom,
    span.currentTo,
  );
  const normalizedBaseRange = clampPointRangeToDocument(
    baseLineStarts.length,
    baseRange.start,
    baseRange.end,
  );
  const normalizedCurrentRange = clampPointRangeToDocument(
    currentLineStarts.length,
    currentRange.start,
    currentRange.end,
  );

  return {
    oldStartLine: normalizedBaseRange.start,
    oldEndLine: normalizedBaseRange.end,
    newStartLine: normalizedCurrentRange.start,
    newEndLine: normalizedCurrentRange.end,
  };
}

function rangesStrictlyOverlap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
): boolean {
  if (leftStart === leftEnd && rightStart === rightEnd) {
    return leftStart === rightStart;
  }

  return leftStart < rightEnd && rightStart < leftEnd;
}

function hunksOverlapCanonically(
  left: Pick<
    ReviewHunkSeed,
    "baseFrom" | "baseTo" | "currentFrom" | "currentTo"
  >,
  right: Pick<
    ReviewHunkSeed,
    "baseFrom" | "baseTo" | "currentFrom" | "currentTo"
  >,
): boolean {
  return (
    rangesStrictlyOverlap(
      left.baseFrom,
      left.baseTo,
      right.baseFrom,
      right.baseTo,
    ) ||
    rangesStrictlyOverlap(
      left.currentFrom,
      left.currentTo,
      right.currentFrom,
      right.currentTo,
    )
  );
}

function buildReviewHunkId(
  trackedVersion: number,
  memberSpans: ReviewHunkMemberSpan[],
): ReviewHunkId {
  return {
    trackedVersion,
    key: memberSpans
      .map(
        (span) =>
          `${span.baseFrom}:${span.baseTo}:${span.currentFrom}:${span.currentTo}`,
      )
      .join("|"),
  };
}

function buildReviewChunkId(
  trackedVersion: number,
  hunkIds: ReviewHunkId[],
): ReviewChunkId {
  return {
    trackedVersion,
    key: hunkIds.map((id) => id.key).join("||"),
  };
}

function buildReviewHunkSeeds(file: TrackedFile): ReviewHunkSeed[] {
  const spans = file.unreviewedRanges?.spans ?? [];
  const hasConflict = file.conflictHash != null;

  return spans.map((span, spanIndex) => {
    const memberSpan: ReviewHunkMemberSpan = {
      spanIndex,
      baseFrom: span.baseFrom,
      baseTo: span.baseTo,
      currentFrom: span.currentFrom,
      currentTo: span.currentTo,
    };
    const lineRange = deriveSpanLineRange(
      file.diffBase,
      file.currentText,
      span,
    );

    return {
      id: buildReviewHunkId(file.version, [memberSpan]),
      identityKey: file.identityKey,
      trackedVersion: file.version,
      oldStartLine: lineRange.oldStartLine,
      oldEndLine: lineRange.oldEndLine,
      newStartLine: lineRange.newStartLine,
      newEndLine: lineRange.newEndLine,
      baseFrom: span.baseFrom,
      baseTo: span.baseTo,
      currentFrom: span.currentFrom,
      currentTo: span.currentTo,
      memberSpans: [memberSpan],
      hasConflict,
      // Inline controls anchor against the live editor document.
      visualStartLine: lineRange.newStartLine,
      visualEndLine: lineRange.newEndLine,
    };
  });
}

function buildReviewChunkSeeds(hunks: ReviewHunkSeed[]): ReviewChunkSeed[] {
  if (hunks.length === 0) {
    return [];
  }

  const chunks: ReviewChunkSeed[] = [];
  let currentHunks: ReviewHunkSeed[] = [hunks[0]!];
  let currentStartLine = hunks[0]!.visualStartLine;
  let currentEndLine = hunks[0]!.visualEndLine;

  const flushCurrentChunk = () => {
    const hunkIds = currentHunks.map((hunk) => hunk.id);
    const chunkId = buildReviewChunkId(
      currentHunks[0]!.trackedVersion,
      hunkIds,
    );
    const overlapGroupByHunkKey: Record<string, string> = {};
    const overlapGroupSizeByHunkKey: Record<string, number> = {};
    const overlapGroupIds: string[] = [];
    const visited = new Set<number>();

    for (let index = 0; index < currentHunks.length; index += 1) {
      if (visited.has(index)) {
        continue;
      }

      const stack = [index];
      const componentIndices: number[] = [];

      while (stack.length > 0) {
        const cursor = stack.pop();
        if (cursor == null || visited.has(cursor)) {
          continue;
        }

        visited.add(cursor);
        componentIndices.push(cursor);

        for (
          let candidate = 0;
          candidate < currentHunks.length;
          candidate += 1
        ) {
          if (visited.has(candidate) || candidate === cursor) {
            continue;
          }

          if (
            hunksOverlapCanonically(
              currentHunks[cursor]!,
              currentHunks[candidate]!,
            )
          ) {
            stack.push(candidate);
          }
        }
      }

      componentIndices.sort((left, right) => left - right);
      const componentKeys = componentIndices.map(
        (componentIndex) => currentHunks[componentIndex]!.id.key,
      );
      const overlapGroupId = `${chunkId.key}::${componentKeys.join("|")}`;
      overlapGroupIds.push(overlapGroupId);

      componentKeys.forEach((hunkKey) => {
        overlapGroupByHunkKey[hunkKey] = overlapGroupId;
        overlapGroupSizeByHunkKey[hunkKey] = componentKeys.length;
      });
    }

    const maxOverlapGroupSize = Object.values(overlapGroupSizeByHunkKey).reduce(
      (maxSize, size) => Math.max(maxSize, size),
      0,
    );

    chunks.push({
      id: chunkId,
      identityKey: currentHunks[0]!.identityKey,
      trackedVersion: currentHunks[0]!.trackedVersion,
      startLine: currentStartLine,
      endLine: currentEndLine,
      hunkIds,
      overlapGroupIds,
      overlapGroupByHunkKey,
      overlapGroupSizeByHunkKey,
      multiHunk: currentHunks.length > 1,
      hasConflict: currentHunks.some((hunk) => hunk.hasConflict),
      ambiguous: currentHunks.length > 1 && maxOverlapGroupSize > 1,
    });
  };

  for (const hunk of hunks.slice(1)) {
    const gap = hunk.visualStartLine - currentEndLine;
    if (gap <= DEFAULT_CHUNK_LINE_GAP) {
      currentHunks.push(hunk);
      currentStartLine = Math.min(currentStartLine, hunk.visualStartLine);
      currentEndLine = Math.max(currentEndLine, hunk.visualEndLine);
      continue;
    }

    flushCurrentChunk();
    currentHunks = [hunk];
    currentStartLine = hunk.visualStartLine;
    currentEndLine = hunk.visualEndLine;
  }

  flushCurrentChunk();
  return chunks;
}

export function reviewHunkIdEquals(
  left: ReviewHunkId,
  right: ReviewHunkId,
): boolean {
  return left.trackedVersion === right.trackedVersion && left.key === right.key;
}

export function reviewChunkIdEquals(
  left: ReviewChunkId,
  right: ReviewChunkId,
): boolean {
  return left.trackedVersion === right.trackedVersion && left.key === right.key;
}

export function buildReviewProjectionIndex(
  file: TrackedFile,
): ReviewProjectionIndex {
  const syncedFile = syncDerivedLinePatch(file);
  const cached = projectionIndexCache.get(syncedFile);
  if (cached) {
    return cached;
  }

  const hunkSeeds = buildReviewHunkSeeds(syncedFile).sort(
    compareReviewHunkSeeds,
  );
  const chunkSeeds = buildReviewChunkSeeds(hunkSeeds);
  const chunkIdByHunkKey = new Map<string, ReviewChunkId>();
  const overlapGroupIdByHunkKey = new Map<string, string>();
  const overlapGroupSizeByHunkKey = new Map<string, number>();

  chunkSeeds.forEach((chunk) => {
    chunk.hunkIds.forEach((hunkId) => {
      chunkIdByHunkKey.set(hunkId.key, chunk.id);
      overlapGroupIdByHunkKey.set(
        hunkId.key,
        chunk.overlapGroupByHunkKey[hunkId.key] ?? chunk.id.key,
      );
      overlapGroupSizeByHunkKey.set(
        hunkId.key,
        chunk.overlapGroupSizeByHunkKey[hunkId.key] ?? 1,
      );
    });
  });

  const hunks: ReviewProjectionIndexHunk[] = hunkSeeds.map((seed) => {
    const chunkId = chunkIdByHunkKey.get(seed.id.key);
    if (!chunkId) {
      throw new Error(`Missing ReviewChunk for ReviewHunk ${seed.id.key}`);
    }

    return {
      id: seed.id,
      identityKey: seed.identityKey,
      trackedVersion: seed.trackedVersion,
      oldStartLine: seed.oldStartLine,
      oldEndLine: seed.oldEndLine,
      newStartLine: seed.newStartLine,
      newEndLine: seed.newEndLine,
      visualStartLine: seed.visualStartLine,
      visualEndLine: seed.visualEndLine,
      baseFrom: seed.baseFrom,
      baseTo: seed.baseTo,
      currentFrom: seed.currentFrom,
      currentTo: seed.currentTo,
      memberSpans: seed.memberSpans,
      chunkId,
      overlapGroupId: overlapGroupIdByHunkKey.get(seed.id.key) ?? chunkId.key,
      overlapGroupSize: overlapGroupSizeByHunkKey.get(seed.id.key) ?? 1,
      hasConflict: seed.hasConflict,
    };
  });

  const chunks: ReviewProjectionIndexChunk[] = chunkSeeds.map((chunk) => ({
    id: chunk.id,
    identityKey: chunk.identityKey,
    trackedVersion: chunk.trackedVersion,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    hunkIds: chunk.hunkIds,
    overlapGroupIds: chunk.overlapGroupIds,
    overlapGroupByHunkKey: chunk.overlapGroupByHunkKey,
    overlapGroupSizeByHunkKey: chunk.overlapGroupSizeByHunkKey,
    multiHunk: chunk.multiHunk,
    hasConflict: chunk.hasConflict,
    ambiguous: chunk.ambiguous,
  }));

  const index: ReviewProjectionIndex = {
    trackedVersion: syncedFile.version,
    trackedFile: syncedFile,
    hunks,
    chunks,
    hunkByIdKey: new Map(hunks.map((hunk) => [hunk.id.key, hunk])),
    chunkByIdKey: new Map(chunks.map((chunk) => [chunk.id.key, chunk])),
  };

  projectionIndexCache.set(syncedFile, index);
  if (syncedFile !== file) {
    projectionIndexCache.set(file, index);
  }

  return index;
}

export function getReviewIndexHunk(
  index: ReviewProjectionIndex,
  id: ReviewHunkId,
): ReviewProjectionIndexHunk | undefined {
  return index.hunkByIdKey.get(id.key);
}

export function getReviewIndexChunk(
  index: ReviewProjectionIndex,
  id: ReviewChunkId,
): ReviewProjectionIndexChunk | undefined {
  return index.chunkByIdKey.get(id.key);
}

export function getReviewIndexHunksForChunk(
  index: Pick<ReviewProjectionIndex, "hunks">,
  chunkId: ReviewChunkId,
): ReviewProjectionIndexHunk[] {
  return index.hunks.filter((hunk) =>
    reviewChunkIdEquals(hunk.chunkId, chunkId),
  );
}

export function expandReviewIndexHunksToOverlapClosure<
  THunk extends Pick<ReviewProjectionIndexHunk, "overlapGroupId">,
>(
  source: { hunks: readonly THunk[] },
  selectedHunks: readonly THunk[],
): THunk[] {
  if (selectedHunks.length === 0) {
    return [];
  }

  const selectedOverlapGroupIds = new Set(
    selectedHunks.map((hunk) => hunk.overlapGroupId),
  );
  const expanded = source.hunks.filter((hunk) =>
    selectedOverlapGroupIds.has(hunk.overlapGroupId),
  );

  return expanded.length === 0 ? [...selectedHunks] : expanded;
}

export function expandReviewHunkIdsToOverlapClosure(
  index: ReviewProjectionIndex,
  hunkIds: readonly ReviewHunkId[],
): ReviewHunkId[] {
  const selectedHunks = hunkIds
    .map((id) => getReviewIndexHunk(index, id))
    .filter((hunk): hunk is ReviewProjectionIndexHunk => hunk != null);

  return expandReviewIndexHunksToOverlapClosure(index, selectedHunks).map(
    (hunk) => hunk.id,
  );
}

export function resolveReviewIndexHunksToExactSpans(
  selectedHunks: readonly Pick<ReviewProjectionIndexHunk, "memberSpans">[],
): AgentTextSpan[] {
  const exactSpans = new Map<string, AgentTextSpan>();

  selectedHunks.forEach((hunk) => {
    hunk.memberSpans.forEach((span) => {
      const key = `${span.baseFrom}:${span.baseTo}:${span.currentFrom}:${span.currentTo}`;
      exactSpans.set(key, {
        baseFrom: span.baseFrom,
        baseTo: span.baseTo,
        currentFrom: span.currentFrom,
        currentTo: span.currentTo,
      });
    });
  });

  return [...exactSpans.values()].sort(compareReviewSpans);
}

export function resolveReviewHunkIdsToExactSpans(
  index: ReviewProjectionIndex,
  hunkIds: readonly ReviewHunkId[],
): AgentTextSpan[] {
  const selectedHunks = hunkIds
    .map((id) => getReviewIndexHunk(index, id))
    .filter((hunk): hunk is ReviewProjectionIndexHunk => hunk != null);

  return resolveReviewIndexHunksToExactSpans(selectedHunks);
}
