import { useEffect, useMemo, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { useEditorStore } from "../../app/store/editorStore";
import type { TrackedFile } from "../ai/diff/actionLogTypes";
import { ChangeRail } from "./ChangeRail";
import { deriveFileChangePresentation } from "./changePresentationModel";
import {
    setInlineDiffActiveEditIndex,
    setInlineDiffHoveredEditIndex,
} from "./extensions/inlineDiff";
import {
    getAdjacentMarker,
    getMarkerKeyForSelection,
    getMarkerKeyForViewport,
    revealChangeMarker,
} from "./changeNavigation";

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
    const [activeMarkerKey, setActiveMarkerKey] = useState<string | null>(null);
    const [hoveredMarkerKey, setHoveredMarkerKey] = useState<string | null>(
        null,
    );

    const presentation = useMemo(() => {
        return trackedFile ? deriveFileChangePresentation(trackedFile) : null;
    }, [trackedFile]);
    const markers = useMemo(() => presentation?.railMarkers ?? [], [presentation]);
    const resolvedActiveMarkerKey = useMemo(() => {
        if (markers.length === 0) {
            return null;
        }

        return markers.some((marker) => marker.key === activeMarkerKey)
            ? activeMarkerKey
            : markers[0]?.key ?? null;
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

    useEffect(() => {
        if (!view) {
            return;
        }

        const nextEditIndex =
            markers.find((marker) => marker.key === resolvedActiveMarkerKey)
                ?.editIndex ?? null;
        view.dispatch({
            effects: [setInlineDiffActiveEditIndex.of(nextEditIndex)],
        });
    }, [markers, resolvedActiveMarkerKey, view]);

    useEffect(() => {
        if (!view) {
            return;
        }

        const nextEditIndex =
            markers.find((marker) => marker.key === resolvedHoveredMarkerKey)
                ?.editIndex ?? null;
        view.dispatch({
            effects: [setInlineDiffHoveredEditIndex.of(nextEditIndex)],
        });
    }, [markers, resolvedHoveredMarkerKey, view]);

    if (!presentation || markers.length === 0) {
        return null;
    }

    const changeCountLabel =
        presentation.hunkCount === 1
            ? "1 change"
            : `${presentation.hunkCount} changes`;

    const handleMarkerClick = (markerKey: string) => {
        const marker = markers.find((candidate) => candidate.key === markerKey);
        if (!marker) {
            return;
        }

        setActiveMarkerKey(marker.key);
        revealChangeMarker(view, marker);
    };

    const handleStep = (direction: 1 | -1) => {
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
                {presentation.preferReview && sessionId && (
                    <button
                        type="button"
                        onClick={() =>
                            useEditorStore.getState().openReview(sessionId, {
                                title: "Review",
                            })
                        }
                        className="mt-2 w-full rounded-md px-1.5 py-1 text-[10px] font-medium"
                        style={reviewButtonStyle}
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
