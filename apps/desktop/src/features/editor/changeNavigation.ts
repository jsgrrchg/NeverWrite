import type { EditorView } from "@codemirror/view";
import { goToNextChunk, goToPreviousChunk } from "@codemirror/merge";
import type { ChangeRailMarker } from "./changePresentationModel";
import { readMergeChunkSnapshot } from "./mergeChunks";

export function revealChangeMarker(
    view: EditorView | null,
    marker: ChangeRailMarker,
) {
    if (!view) {
        return;
    }

    const pos = getMarkerAnchorPosition(view, marker);
    view.dispatch({
        selection: {
            anchor: pos,
            head: pos,
        },
        scrollIntoView: true,
    });
    view.focus();
}

export function getAdjacentMarker(
    markers: ChangeRailMarker[],
    currentMarkerKey: string | null,
    direction: 1 | -1,
) {
    if (markers.length === 0) {
        return null;
    }

    const currentIndex = markers.findIndex(
        (marker) => marker.key === currentMarkerKey,
    );
    if (currentIndex < 0) {
        return direction === 1 ? markers[0] : markers[markers.length - 1];
    }

    const nextIndex =
        (currentIndex + direction + markers.length) % markers.length;
    return markers[nextIndex] ?? null;
}

export function getMarkerKeyForLine(
    markers: ChangeRailMarker[],
    lineNumber: number,
) {
    if (markers.length === 0) {
        return null;
    }

    let bestMarker: ChangeRailMarker | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const marker of markers) {
        const start = marker.startLine;
        const endExclusive =
            marker.endLine > marker.startLine
                ? marker.endLine
                : marker.startLine + 1;

        if (lineNumber >= start && lineNumber < endExclusive) {
            return marker.key;
        }

        const distance = lineNumber < start ? start - lineNumber : lineNumber - endExclusive + 1;
        if (distance < bestDistance) {
            bestDistance = distance;
            bestMarker = marker;
        }
    }

    return bestMarker?.key ?? null;
}

export function getMarkerKeyForSelection(
    view: EditorView | null,
    markers: ChangeRailMarker[],
) {
    if (!view || markers.length === 0) {
        return null;
    }

    const lineNumber = view.state.doc.lineAt(view.state.selection.main.head)
        .number;
    return getMarkerKeyForLine(markers, lineNumber - 1);
}

export function getMarkerKeyForViewport(
    view: EditorView | null,
    markers: ChangeRailMarker[],
) {
    if (!view || markers.length === 0) {
        return null;
    }

    const topLineBlock = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
    const lineNumber = view.state.doc.lineAt(topLineBlock.from).number;
    return getMarkerKeyForLine(markers, lineNumber - 1);
}

function getMarkerAnchorPosition(view: EditorView, marker: ChangeRailMarker) {
    const totalLines = Math.max(view.state.doc.lines, 1);
    const targetLine = clamp(marker.anchorLine + 1, 1, totalLines);
    return view.state.doc.line(targetLine).from;
}

export function navigateByChunk(
    view: EditorView | null,
    direction: 1 | -1,
) {
    if (!view || !readMergeChunkSnapshot(view.state)) {
        return false;
    }

    const command = direction === 1 ? goToNextChunk : goToPreviousChunk;
    return command({
        state: view.state,
        dispatch: view.dispatch.bind(view),
    });
}

function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max);
}
