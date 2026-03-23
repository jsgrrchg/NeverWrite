import type { Text } from "@codemirror/state";
import type { Chunk } from "@codemirror/merge";

export type MergeChunkKind = "add" | "modify" | "delete";

// Visual-only mapping for rails and presentation. Review decisions must come
// from ReviewProjection, never from CodeMirror chunk coordinates.
export interface ChunkLineRange {
    startLine: number;
    endLine: number;
    anchorLine: number;
}

export function clampDocPos(doc: Text, pos: number) {
    return Math.max(0, Math.min(pos, doc.length));
}

export function getChunkKind(chunk: Chunk): MergeChunkKind {
    if (chunk.changes.every((change) => change.fromA === change.toA)) {
        return "add";
    }
    if (chunk.changes.every((change) => change.fromB === change.toB)) {
        return "delete";
    }
    return "modify";
}

export function getChunkMarkerKey(chunk: Chunk, index: number) {
    return [
        "chunk",
        index,
        getChunkKind(chunk),
        chunk.fromA,
        chunk.toA,
        chunk.fromB,
        chunk.toB,
        chunk.precise ? "precise" : "fallback",
    ].join("-");
}

export function getChunkLineRangeInDocB(
    chunk: Chunk,
    doc: Text,
): ChunkLineRange {
    const absoluteChanges = chunk.changes.map((change) => ({
        fromB: chunk.fromB + change.fromB,
        toB: chunk.fromB + change.toB,
    }));

    if (absoluteChanges.length === 0) {
        const anchorLine = getBoundaryAwareLineIndex(doc, chunk.fromB);
        return {
            startLine: anchorLine,
            endLine: anchorLine,
            anchorLine,
        };
    }

    const ranges = absoluteChanges
        .map(({ fromB, toB }) => buildLineRangeFromOffsets(doc, fromB, toB))
        .filter((range): range is ChunkLineRange => range !== null);

    if (ranges.length === 0) {
        const anchorLine = getBoundaryAwareLineIndex(doc, chunk.fromB);
        return {
            startLine: anchorLine,
            endLine: anchorLine,
            anchorLine,
        };
    }

    const startLine = Math.max(
        0,
        Math.min(...ranges.map((range) => range.startLine)),
    );
    const endLine = Math.max(...ranges.map((range) => range.endLine));
    const anchorLine = Math.max(
        0,
        Math.min(
            doc.lines,
            Math.min(...ranges.map((range) => range.anchorLine)),
        ),
    );

    return {
        startLine,
        endLine,
        anchorLine,
    };
}

function buildLineRangeFromOffsets(
    doc: Text,
    from: number,
    to: number,
): ChunkLineRange | null {
    if (from === to) {
        const anchorLine = getBoundaryAwareLineIndex(doc, from);
        return {
            startLine: anchorLine,
            endLine: anchorLine,
            anchorLine,
        };
    }

    const startLine = getBoundaryAwareLineIndex(doc, from);
    const lastChangedOffset = Math.max(0, to - 1);
    const endLineInclusive = getBoundaryAwareLineIndex(doc, lastChangedOffset);

    return {
        startLine,
        endLine: endLineInclusive + 1,
        anchorLine: startLine,
    };
}

function getBoundaryAwareLineIndex(doc: Text, pos: number) {
    const clampedPos = clampDocPos(doc, pos);
    const line = doc.lineAt(clampedPos);
    if (clampedPos === 0) {
        return 0;
    }

    if (clampedPos === line.to) {
        return line.number;
    }

    return Math.max(0, line.number - 1);
}
