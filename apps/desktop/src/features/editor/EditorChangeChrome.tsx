import { useEffect, useMemo, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { useEditorStore } from "../../app/store/editorStore";
import type { TrackedFile } from "../ai/diff/actionLogTypes";
import { ChangeRail } from "./ChangeRail";
import {
    deriveFileChangePresentation,
    deriveMarkersFromChunks,
    MEDIUM_MAX_HUNKS,
} from "./changePresentationModel";
import {
    getAdjacentMarker,
    getMarkerKeyForSelection,
    getMarkerKeyForViewport,
    navigateByChunk,
    revealChangeMarker,
} from "./changeNavigation";
import {
    mergeChunkSnapshotEventName,
    readMergeChunkSnapshot,
    type MergeChunkSnapshot,
} from "./mergeChunks";

interface EditorChangeChromeProps {
    trackedFile: TrackedFile | null;
    sessionId: string | null;
    view: EditorView | null;
}

export function EditorChangeChrome({
    trackedFile,
    sessionId,
    view,
}: EditorChangeChromeProps) {
    const [chunkSnapshot, setChunkSnapshot] =
        useState<MergeChunkSnapshot | null>(() =>
            view ? readMergeChunkSnapshot(view.state) : null,
        );
    const [activeMarkerKey, setActiveMarkerKey] = useState<string | null>(null);
    const [hoveredMarkerKey, setHoveredMarkerKey] = useState<string | null>(
        null,
    );

    const presentation = useMemo(() => {
        return trackedFile ? deriveFileChangePresentation(trackedFile) : null;
    }, [trackedFile]);
    const markers = useMemo(() => {
        if (!presentation || !view || !chunkSnapshot) {
            return [];
        }

        return deriveMarkersFromChunks(
            chunkSnapshot.chunks,
            view.state.doc,
            presentation.reviewState,
        );
    }, [chunkSnapshot, presentation, view]);
    const visibleChangeCount = chunkSnapshot
        ? markers.length
        : (presentation?.hunkCount ?? 0);
    const effectivePreferReview =
        (presentation?.preferReview ?? false) ||
        visibleChangeCount > MEDIUM_MAX_HUNKS;
    const resolvedActiveMarkerKey = useMemo(() => {
        if (markers.length === 0) {
            return null;
        }

        return markers.some((marker) => marker.key === activeMarkerKey)
            ? activeMarkerKey
            : (markers[0]?.key ?? null);
    }, [activeMarkerKey, markers]);
    const resolvedHoveredMarkerKey = useMemo(() => {
        if (markers.length === 0) {
            return null;
        }

        return markers.some((marker) => marker.key === hoveredMarkerKey)
            ? hoveredMarkerKey
            : null;
    }, [hoveredMarkerKey, markers]);

    useEffect(() => {
        if (!view) {
            setChunkSnapshot(null);
            return;
        }

        setChunkSnapshot(readMergeChunkSnapshot(view.state));

        const handleSnapshot = (event: Event) => {
            const nextSnapshot = (
                event as CustomEvent<MergeChunkSnapshot | null>
            ).detail;
            setChunkSnapshot(nextSnapshot);
        };

        view.dom.addEventListener(mergeChunkSnapshotEventName, handleSnapshot);
        return () => {
            view.dom.removeEventListener(
                mergeChunkSnapshotEventName,
                handleSnapshot,
            );
        };
    }, [view]);

    useEffect(() => {
        if (!view || markers.length === 0) {
            return;
        }

        const syncActiveMarker = () => {
            const selectionMarkerKey = getMarkerKeyForSelection(view, markers);
            const nextMarkerKey =
                selectionMarkerKey ?? getMarkerKeyForViewport(view, markers);
            if (nextMarkerKey) {
                setActiveMarkerKey(nextMarkerKey);
            }
        };

        syncActiveMarker();
        const scrollElement = view.scrollDOM;

        scrollElement.addEventListener("scroll", syncActiveMarker, {
            passive: true,
        });
        view.dom.addEventListener("keyup", syncActiveMarker);
        view.dom.addEventListener("mouseup", syncActiveMarker);
        view.dom.addEventListener("focusin", syncActiveMarker);

        return () => {
            scrollElement.removeEventListener("scroll", syncActiveMarker);
            view.dom.removeEventListener("keyup", syncActiveMarker);
            view.dom.removeEventListener("mouseup", syncActiveMarker);
            view.dom.removeEventListener("focusin", syncActiveMarker);
        };
    }, [markers, view]);

    if (!presentation) {
        return null;
    }

    const changeCountLabel =
        visibleChangeCount === 1 ? "1 change" : `${visibleChangeCount} changes`;
    const reviewStatusLabel =
        presentation.reviewState === "pending"
            ? "Pending review"
            : effectivePreferReview
              ? "Ready for review"
              : "Review finalized";

    const handleMarkerClick = (markerKey: string) => {
        const marker = markers.find((candidate) => candidate.key === markerKey);
        if (!marker) {
            return;
        }

        setActiveMarkerKey(marker.key);
        revealChangeMarker(view, marker);
    };

    const handleStep = (direction: 1 | -1) => {
        if (navigateByChunk(view, direction)) {
            const nextMarkerKey =
                getMarkerKeyForSelection(view, markers) ??
                getMarkerKeyForViewport(view, markers);
            if (nextMarkerKey) {
                setActiveMarkerKey(nextMarkerKey);
            }
            return;
        }

        const marker = getAdjacentMarker(
            markers,
            resolvedActiveMarkerKey,
            direction,
        );
        if (!marker) {
            return;
        }

        setActiveMarkerKey(marker.key);
        revealChangeMarker(view, marker);
    };

    return (
        <aside
            className="flex h-full w-14 shrink-0 flex-col border-l"
            style={{
                borderColor: "var(--border)",
                backgroundColor: "var(--bg-primary)",
            }}
        >
            <div className="px-2 py-2">
                <div
                    className="text-[11px] font-medium leading-tight"
                    style={{ color: "var(--text-primary)" }}
                >
                    {changeCountLabel}
                </div>
                <div
                    className="mt-1 text-[10px] leading-tight"
                    style={{ color: "var(--text-secondary)" }}
                >
                    {`+${presentation.additions} -${presentation.deletions}`}
                </div>
                <div
                    className="mt-1 text-[10px] font-medium leading-tight"
                    style={{ color: "var(--text-secondary)" }}
                >
                    {reviewStatusLabel}
                </div>
                {effectivePreferReview && sessionId && (
                    <button
                        type="button"
                        onClick={() =>
                            useEditorStore.getState().openReview(sessionId, {
                                title: "Review",
                            })
                        }
                        className="mt-2 w-full rounded-md px-1.5 py-1 text-[10px] font-medium"
                        style={
                            presentation.reviewState === "pending"
                                ? reviewButtonPendingStyle
                                : reviewButtonStyle
                        }
                    >
                        Open review
                    </button>
                )}
            </div>

            <div className="min-h-0 flex-1 px-2 pb-2">
                <ChangeRail
                    markers={markers}
                    activeMarkerKey={resolvedActiveMarkerKey}
                    hoveredMarkerKey={resolvedHoveredMarkerKey}
                    onMarkerHover={setHoveredMarkerKey}
                    onMarkerClick={handleMarkerClick}
                    onPreviousChange={() => handleStep(-1)}
                    onNextChange={() => handleStep(1)}
                />
            </div>
        </aside>
    );
}

const reviewButtonStyle = {
    border: "1px solid color-mix(in srgb, var(--accent) 24%, var(--border))",
    backgroundColor: "color-mix(in srgb, var(--accent) 8%, var(--bg-primary))",
    color: "var(--text-primary)",
} as const;

const reviewButtonPendingStyle = {
    border: "1px solid color-mix(in srgb, var(--accent) 36%, var(--border))",
    backgroundColor:
        "color-mix(in srgb, var(--accent) 14%, var(--bg-secondary))",
    color: "var(--text-primary)",
    boxShadow: "inset 0 0 0 1px color-mix(in srgb, white 10%, transparent)",
} as const;
