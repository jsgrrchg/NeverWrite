import type { EditorState } from "@codemirror/state";
import { getChunks, type Chunk } from "@codemirror/merge";
import { ViewPlugin, type ViewUpdate } from "@codemirror/view";

export interface MergeChunkSnapshot {
    chunks: readonly Chunk[];
    side: "a" | "b" | null;
}

export const mergeChunkSnapshotEventName = "vaultai:merge-chunk-snapshot";

export function readMergeChunkSnapshot(
    state: EditorState,
): MergeChunkSnapshot | null {
    const snapshot = getChunks(state);
    return snapshot
        ? {
              chunks: snapshot.chunks,
              side: snapshot.side,
          }
        : null;
}

export function mergeChunkSnapshotsEqual(
    a: MergeChunkSnapshot | null,
    b: MergeChunkSnapshot | null,
) {
    if (a === b) {
        return true;
    }
    if (!a || !b) {
        return false;
    }
    if (a.side !== b.side || a.chunks.length !== b.chunks.length) {
        return false;
    }

    return a.chunks.every((chunk, index) =>
        chunkEquals(chunk, b.chunks[index]),
    );
}

export function findMergeChunkAtPos(
    chunks: readonly Chunk[],
    pos: number,
): Chunk | null {
    const exact = chunks.find((chunk) => {
        if (chunk.fromB === chunk.toB) {
            return pos === chunk.fromB;
        }

        return pos >= chunk.fromB && pos <= chunk.endB;
    });
    if (exact) {
        return exact;
    }

    // Fallback: nearest chunk within a small tolerance.
    // posAtDOM on buttons inside deletion widgets can return positions
    // slightly off from the chunk boundary.
    let best: Chunk | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const chunk of chunks) {
        const dist =
            chunk.fromB === chunk.toB
                ? Math.abs(pos - chunk.fromB)
                : pos < chunk.fromB
                  ? chunk.fromB - pos
                  : pos > chunk.endB
                    ? pos - chunk.endB
                    : 0;
        if (dist < bestDist) {
            bestDist = dist;
            best = chunk;
        }
    }

    return bestDist <= 1 ? best : null;
}

export const mergeChunkSnapshotPlugin = ViewPlugin.fromClass(
    class {
        private snapshot: MergeChunkSnapshot | null;
        private view: ViewUpdate["view"];

        constructor(view: ViewUpdate["view"]) {
            this.view = view;
            this.snapshot = readMergeChunkSnapshot(view.state);
            emitMergeChunkSnapshot(view.dom, this.snapshot);
        }

        update(update: ViewUpdate) {
            const nextSnapshot = readMergeChunkSnapshot(update.state);
            if (!mergeChunkSnapshotsEqual(this.snapshot, nextSnapshot)) {
                this.snapshot = nextSnapshot;
                emitMergeChunkSnapshot(update.view.dom, nextSnapshot);
            }
        }

        destroy() {
            emitMergeChunkSnapshot(this.view.dom, null);
        }
    },
);

function chunkEquals(a: Chunk, b: Chunk | undefined) {
    if (!b) {
        return false;
    }

    if (
        a.fromA !== b.fromA ||
        a.toA !== b.toA ||
        a.fromB !== b.fromB ||
        a.toB !== b.toB ||
        a.precise !== b.precise ||
        a.changes.length !== b.changes.length
    ) {
        return false;
    }

    return a.changes.every((change, index) => {
        const other = b.changes[index];
        return (
            !!other &&
            change.fromA === other.fromA &&
            change.toA === other.toA &&
            change.fromB === other.fromB &&
            change.toB === other.toB
        );
    });
}

function emitMergeChunkSnapshot(
    target: HTMLElement,
    snapshot: MergeChunkSnapshot | null,
) {
    target.dispatchEvent(
        new CustomEvent<MergeChunkSnapshot | null>(
            mergeChunkSnapshotEventName,
            {
                detail: snapshot,
            },
        ),
    );
}
