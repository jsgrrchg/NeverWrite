export type LivePreviewListKind = "unordered" | "ordered" | "task";

export const LIVE_PREVIEW_UNORDERED_MARKER_WIDTH_EM = 1.3;
export const LIVE_PREVIEW_TASK_MARKER_WIDTH_EM = 1.2;
export const LIVE_PREVIEW_LIST_MARKER_GAP_EM = 0.55;
export const LIVE_PREVIEW_LIST_PADDING_Y_EM = 0.08;
export const LIVE_PREVIEW_LIST_CONTINUATION_PADDING_Y_EM = 0.04;
export const LIVE_PREVIEW_LIST_NESTING_STEP_EM = 0.24;
export const LIVE_PREVIEW_TASK_CHECKBOX_SIZE_EM = 0.92;
export const LIVE_PREVIEW_TASK_CHECKBOX_RADIUS_EM = 0.24;
export const LIVE_PREVIEW_TASK_HIT_SLOP_PX = 2;
export const LIVE_PREVIEW_ORDERED_MARKER_MIN_WIDTH_CH = 2.4;
export const LIVE_PREVIEW_ORDERED_MARKER_PADDING_CH = 0.55;

export const LIVE_PREVIEW_UNORDERED_MARKER_WIDTH = `${LIVE_PREVIEW_UNORDERED_MARKER_WIDTH_EM}em`;
export const LIVE_PREVIEW_TASK_MARKER_WIDTH = `${LIVE_PREVIEW_TASK_MARKER_WIDTH_EM}em`;
export const LIVE_PREVIEW_LIST_MARKER_GAP = `${LIVE_PREVIEW_LIST_MARKER_GAP_EM}em`;
export const LIVE_PREVIEW_LIST_PADDING_Y = `${LIVE_PREVIEW_LIST_PADDING_Y_EM}em`;
export const LIVE_PREVIEW_LIST_CONTINUATION_PADDING_Y = `${LIVE_PREVIEW_LIST_CONTINUATION_PADDING_Y_EM}em`;
export const LIVE_PREVIEW_TASK_CHECKBOX_SIZE = `${LIVE_PREVIEW_TASK_CHECKBOX_SIZE_EM}em`;
export const LIVE_PREVIEW_TASK_CHECKBOX_RADIUS = `${LIVE_PREVIEW_TASK_CHECKBOX_RADIUS_EM}em`;
export const LIVE_PREVIEW_TASK_HIT_SLOP = `${LIVE_PREVIEW_TASK_HIT_SLOP_PX}px`;
export const LIVE_PREVIEW_LIST_MARKER_TOP = `calc(var(--cm-lp-list-padding-y, ${LIVE_PREVIEW_LIST_PADDING_Y}) + ((var(--text-input-line-height) * 1em - 1em) / 2))`;
export const LIVE_PREVIEW_TASK_CHECKBOX_TOP = `calc(var(--cm-lp-list-padding-y, ${LIVE_PREVIEW_LIST_PADDING_Y}) + ((var(--text-input-line-height) * 1em - ${LIVE_PREVIEW_TASK_CHECKBOX_SIZE}) / 2))`;
export const LIVE_PREVIEW_TASK_CHECKBOX_TICK_OFFSET = "0.26em";
export const LIVE_PREVIEW_TASK_CHECKBOX_PARTIAL_OFFSET = "0.40em";

export type LivePreviewListLinePresentation = {
    attrs?: Record<string, string>;
    styles: Record<string, string>;
};

function normalizeListLevel(level: number) {
    return Math.max(level, 1);
}

function getListNestingOffset(level: number) {
    return `${(normalizeListLevel(level) - 1) * LIVE_PREVIEW_LIST_NESTING_STEP_EM}em`;
}

function getListMarkerScale(kind: LivePreviewListKind, level: number) {
    const normalizedLevel = normalizeListLevel(level);
    if (kind === "unordered") {
        return normalizedLevel === 1 ? "1" : "0.92";
    }
    if (kind === "ordered") {
        return normalizedLevel === 1 ? "1" : "0.96";
    }
    return "1";
}

function getListMarkerOpacity(kind: LivePreviewListKind, level: number) {
    const normalizedLevel = normalizeListLevel(level);
    if (kind === "task") {
        return normalizedLevel === 1 ? "1" : "0.9";
    }
    return normalizedLevel === 1 ? "0.88" : "0.72";
}

function getUnorderedListMarker(level: number) {
    return normalizeListLevel(level) === 1 ? "\u2022" : "\u25e6";
}

export function getLooseListLevel(indentWidth: number) {
    return Math.max(1, Math.floor(indentWidth / 4) + 1);
}

export function createLivePreviewListLinePresentation({
    indentWidth,
    level,
    kind,
    markerWidth,
    markerText,
}: {
    indentWidth: number;
    level: number;
    kind: LivePreviewListKind;
    markerWidth: string;
    markerText?: string | null;
}): LivePreviewListLinePresentation {
    const normalizedLevel = normalizeListLevel(level);
    const resolvedMarkerText =
        markerText ??
        (kind === "unordered" ? getUnorderedListMarker(level) : null);

    return {
        attrs: resolvedMarkerText
            ? {
                  "data-lp-marker": resolvedMarkerText,
              }
            : undefined,
        styles: {
            "--cm-lp-indent": `${indentWidth}ch`,
            "--cm-lp-marker-width": markerWidth,
            "--cm-lp-marker-gap": LIVE_PREVIEW_LIST_MARKER_GAP,
            "--cm-lp-nesting-offset": getListNestingOffset(normalizedLevel),
            "--cm-lp-list-padding-y": LIVE_PREVIEW_LIST_PADDING_Y,
            "--cm-lp-list-continuation-padding-y":
                LIVE_PREVIEW_LIST_CONTINUATION_PADDING_Y,
            "--cm-lp-marker-scale": getListMarkerScale(kind, normalizedLevel),
            "--cm-lp-marker-opacity": getListMarkerOpacity(
                kind,
                normalizedLevel,
            ),
        },
    };
}
