import { useLayoutEffect, useState, type RefObject } from "react";

export type EditorTabDensity = "comfortable" | "compact" | "tight" | "overflow";

export interface EditorTabLayout {
    density: EditorTabDensity;
    tabWidth: number;
    tabGap: number;
    tabPaddingX: number;
    titleFontSize: number;
    closeButtonSize: number;
    closeIconSize: number;
    stripGap: number;
    stripPaddingX: number;
    overflow: boolean;
}

export const EDITOR_TAB_MAX_WIDTH = 160;
export const EDITOR_TAB_MIN_WIDTH = 96;
export const EDITOR_TAB_STRIP_GAP = 0;
export const EDITOR_TAB_STRIP_PADDING_X = 0;

const COMFORTABLE_WIDTH = 144;
const COMPACT_WIDTH = 118;
const DENSITY_HYSTERESIS = 6;

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}

function interpolate(min: number, max: number, ratio: number) {
    return min + (max - min) * ratio;
}

function roundTo(value: number, decimals: number) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
}

function getVisualRatio(tabWidth: number) {
    return clamp(
        (tabWidth - EDITOR_TAB_MIN_WIDTH) /
            (EDITOR_TAB_MAX_WIDTH - EDITOR_TAB_MIN_WIDTH),
        0,
        1,
    );
}

function resolveDensity(
    tabWidth: number,
    overflow: boolean,
    previousDensity?: EditorTabDensity,
): EditorTabDensity {
    if (overflow) {
        return "overflow";
    }

    switch (previousDensity) {
        case "comfortable":
            return tabWidth >= COMFORTABLE_WIDTH - DENSITY_HYSTERESIS
                ? "comfortable"
                : tabWidth >= COMPACT_WIDTH
                  ? "compact"
                  : "tight";
        case "compact":
            if (tabWidth >= COMFORTABLE_WIDTH + DENSITY_HYSTERESIS) {
                return "comfortable";
            }
            return tabWidth >= COMPACT_WIDTH - DENSITY_HYSTERESIS
                ? "compact"
                : "tight";
        case "tight":
            return tabWidth >= COMPACT_WIDTH + DENSITY_HYSTERESIS
                ? "compact"
                : "tight";
        case "overflow":
            if (tabWidth <= EDITOR_TAB_MIN_WIDTH + DENSITY_HYSTERESIS) {
                return "tight";
            }
            return tabWidth >= COMPACT_WIDTH ? "compact" : "tight";
        default:
            if (tabWidth >= COMFORTABLE_WIDTH) {
                return "comfortable";
            }
            if (tabWidth >= COMPACT_WIDTH) {
                return "compact";
            }
            return "tight";
    }
}

function layoutsEqual(left: EditorTabLayout, right: EditorTabLayout) {
    return (
        left.density === right.density &&
        left.tabWidth === right.tabWidth &&
        left.tabGap === right.tabGap &&
        left.tabPaddingX === right.tabPaddingX &&
        left.titleFontSize === right.titleFontSize &&
        left.closeButtonSize === right.closeButtonSize &&
        left.closeIconSize === right.closeIconSize &&
        left.stripGap === right.stripGap &&
        left.stripPaddingX === right.stripPaddingX &&
        left.overflow === right.overflow
    );
}

function buildFallbackLayout(
    previousDensity?: EditorTabDensity,
): EditorTabLayout {
    return resolveEditorTabLayout({
        stripWidth: 0,
        tabCount: 1,
        previousDensity,
    });
}

export function resolveEditorTabLayout({
    stripWidth,
    tabCount,
    previousDensity,
}: {
    stripWidth: number;
    tabCount: number;
    previousDensity?: EditorTabDensity;
}): EditorTabLayout {
    if (tabCount <= 1 || stripWidth <= 0) {
        return {
            density: "comfortable",
            tabWidth: EDITOR_TAB_MAX_WIDTH,
            tabGap: 6,
            tabPaddingX: 12,
            titleFontSize: 12,
            closeButtonSize: 16,
            closeIconSize: 10,
            stripGap: EDITOR_TAB_STRIP_GAP,
            stripPaddingX: EDITOR_TAB_STRIP_PADDING_X,
            overflow: false,
        };
    }

    const availableWidth =
        stripWidth -
        EDITOR_TAB_STRIP_PADDING_X * 2 -
        Math.max(0, tabCount - 1) * EDITOR_TAB_STRIP_GAP;
    const idealWidth = availableWidth / tabCount;
    const tabWidth = roundTo(
        clamp(idealWidth, EDITOR_TAB_MIN_WIDTH, EDITOR_TAB_MAX_WIDTH),
        2,
    );
    const ratio = getVisualRatio(tabWidth);
    const overflow = idealWidth < EDITOR_TAB_MIN_WIDTH;

    return {
        density: resolveDensity(tabWidth, overflow, previousDensity),
        tabWidth,
        tabGap: 6,
        tabPaddingX: roundTo(interpolate(10, 12, ratio), 2),
        titleFontSize: 12,
        closeButtonSize: 16,
        closeIconSize: 10,
        stripGap: EDITOR_TAB_STRIP_GAP,
        stripPaddingX: EDITOR_TAB_STRIP_PADDING_X,
        overflow,
    };
}

export function useResponsiveEditorTabLayout({
    stripRef,
    tabCount,
    freeze,
}: {
    stripRef: RefObject<HTMLDivElement | null>;
    tabCount: number;
    freeze: boolean;
}) {
    const [layout, setLayout] = useState<EditorTabLayout>(() =>
        buildFallbackLayout(),
    );

    useLayoutEffect(() => {
        if (freeze) {
            return;
        }

        const strip = stripRef.current;
        if (!strip) {
            return;
        }

        const measure = () => {
            setLayout((current) => {
                const next = resolveEditorTabLayout({
                    stripWidth: strip.clientWidth,
                    tabCount,
                    previousDensity: current.density,
                });
                return layoutsEqual(current, next) ? current : next;
            });
        };

        measure();

        const frame = window.requestAnimationFrame(measure);
        let resizeObserver: ResizeObserver | null = null;

        if (typeof ResizeObserver !== "undefined") {
            resizeObserver = new ResizeObserver(() => {
                measure();
            });
            resizeObserver.observe(strip);
        }

        window.addEventListener("resize", measure);

        return () => {
            window.cancelAnimationFrame(frame);
            resizeObserver?.disconnect();
            window.removeEventListener("resize", measure);
        };
    }, [freeze, stripRef, tabCount]);

    return layout;
}
