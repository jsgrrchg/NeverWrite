import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
} from "react";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { openPath } from "@neverwrite/runtime";
import {
    ContextMenu,
    type ContextMenuEntry,
    type ContextMenuState,
} from "../../components/context-menu/ContextMenu";
import {
    useEditorStore,
    isPdfTab,
    selectEditorPaneActiveTab,
    type PdfTab,
} from "../../app/store/editorStore";
import {
    useSettingsStore,
    type PdfFilterMode,
} from "../../app/store/settingsStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { buildVaultPreviewUrlFromAbsolutePath } from "../../app/utils/filePreviewUrl";
import { formatZoomPercentage } from "../../app/utils/zoom";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
    import.meta.url,
).toString();

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const CONTINUOUS_PAGE_GAP = 20;
const CONTINUOUS_OVERSCAN_PX = 1200;
const CONTINUOUS_MAX_RENDERED_PAGES = 15;
const VIEWPORT_HEIGHT_FALLBACK = 800;
const PDF_SURFACE_PADDING_PX = 24;
const SCROLL_PERSIST_THRESHOLD_PX = 24;
const SCROLL_EDGE_EPSILON_PX = 2;
const KEYBOARD_HORIZONTAL_PAN_PX = 120;
const KEYBOARD_VERTICAL_PAN_PX = 120;
const PDF_TEXT_CONTENT_OPTIONS = {
    includeMarkedContent: true,
    disableNormalization: true,
} as const;

const PDF_FILTERS: { mode: PdfFilterMode; label: string; css: string }[] = [
    { mode: "none", label: "Normal", css: "none" },
    { mode: "dark", label: "Dark", css: "invert(1) hue-rotate(180deg)" },
    { mode: "sepia", label: "Sepia", css: "sepia(1)" },
    { mode: "grayscale", label: "B&W", css: "grayscale(1)" },
];

const PDF_DOCUMENT_OPTIONS = {
    isImageDecoderSupported: false,
    isOffscreenCanvasSupported: false,
    stopAtErrors: true,
    useSystemFonts: true,
    verbosity: pdfjsLib.VerbosityLevel.ERRORS,
};

function getPixelRatio() {
    if (typeof window === "undefined") return 1;
    return window.devicePixelRatio || 1;
}

function getSelectionText() {
    return window.getSelection()?.toString() ?? "";
}

function clampZoom(zoom: number, direction: "in" | "out"): number {
    if (direction === "out") {
        for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
            if (ZOOM_STEPS[i] < zoom) return ZOOM_STEPS[i];
        }
        return ZOOM_STEPS[0];
    }
    for (const step of ZOOM_STEPS) {
        if (step > zoom) return step;
    }
    return ZOOM_STEPS[ZOOM_STEPS.length - 1];
}

const PINCH_GESTURE_EVENTS = [
    "gesturestart",
    "gesturechange",
    "gestureend",
] as const;

function classifyPdfError(raw: string): string {
    const lower = raw.toLowerCase();
    if (lower.includes("password") || lower.includes("encrypted"))
        return "This PDF is password-protected and cannot be opened in the viewer.";
    if (
        lower.includes("invalid") ||
        lower.includes("corrupt") ||
        lower.includes("not a pdf")
    )
        return "This file appears to be corrupted or is not a valid PDF.";
    if (
        lower.includes("not found") ||
        lower.includes("no such file") ||
        lower.includes("404")
    )
        return "The PDF file was not found. It may have been moved or deleted.";
    if (lower.includes("network") || lower.includes("fetch"))
        return "Could not load the PDF file. Check that the file is accessible.";
    return "An unexpected error occurred while loading this PDF.";
}

type LoadedPdfState = {
    path: string;
    retryCount: number;
    pdf: pdfjsLib.PDFDocumentProxy;
    numPages: number;
};

type PdfErrorState = {
    path: string;
    retryCount: number;
    message: string;
};

type PdfPageMetric = {
    pageNumber: number;
    width: number;
    height: number;
};

type PdfRenderedPageSize = {
    width: number;
    height: number;
};

type PdfPageLayout = PdfPageMetric & {
    offsetTop: number;
    bottom: number;
};

type PdfScrollPosition = {
    top: number;
    left: number;
};

function normalizeScrollPosition(position: PdfScrollPosition) {
    return {
        top: Math.max(0, Math.round(position.top)),
        left: Math.max(0, Math.round(position.left)),
    };
}

function getMaxScrollLeft(element: HTMLElement) {
    return Math.max(0, element.scrollWidth - element.clientWidth);
}

function getMaxScrollTop(element: HTMLElement) {
    return Math.max(0, element.scrollHeight - element.clientHeight);
}

function canScrollLeft(element: HTMLElement) {
    return element.scrollLeft > SCROLL_EDGE_EPSILON_PX;
}

function canScrollRight(element: HTMLElement) {
    return (
        getMaxScrollLeft(element) - element.scrollLeft >
        SCROLL_EDGE_EPSILON_PX
    );
}

function canScrollUp(element: HTMLElement) {
    return element.scrollTop > SCROLL_EDGE_EPSILON_PX;
}

function canScrollDown(element: HTMLElement) {
    return (
        getMaxScrollTop(element) - element.scrollTop >
        SCROLL_EDGE_EPSILON_PX
    );
}

function scrollPdfSurfaceTo(
    element: HTMLElement,
    position: Partial<PdfScrollPosition>,
) {
    element.scrollTo({
        top: Math.max(0, position.top ?? element.scrollTop),
        left: Math.max(0, position.left ?? element.scrollLeft),
        behavior: "auto",
    });
}

function isEditableEventTarget(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) return false;
    const tagName = target.tagName.toLowerCase();
    return (
        tagName === "input" ||
        tagName === "textarea" ||
        tagName === "select" ||
        target.isContentEditable
    );
}

function buildPageLayouts(
    metrics: PdfPageMetric[],
    zoom: number,
): PdfPageLayout[] {
    let offsetTop = 0;
    return metrics.map((metric) => {
        const width = metric.width * zoom;
        const height = metric.height * zoom;
        const layout = {
            ...metric,
            width,
            height,
            offsetTop,
            bottom: offsetTop + height,
        };
        offsetTop = layout.bottom + CONTINUOUS_PAGE_GAP;
        return layout;
    });
}

function findFirstLayoutEndingAfter(
    layouts: PdfPageLayout[],
    offset: number,
): number {
    let low = 0;
    let high = layouts.length - 1;
    let result = layouts.length - 1;

    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (layouts[mid].bottom >= offset) {
            result = mid;
            high = mid - 1;
        } else {
            low = mid + 1;
        }
    }

    return result;
}

function findLastLayoutStartingBefore(
    layouts: PdfPageLayout[],
    offset: number,
): number {
    let low = 0;
    let high = layouts.length - 1;
    let result = 0;

    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (layouts[mid].offsetTop <= offset) {
            result = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    return result;
}

function findClosestLayoutIndex(
    layouts: PdfPageLayout[],
    probeY: number,
): number {
    const currentIndex = findLastLayoutStartingBefore(layouts, probeY);
    const nextIndex = Math.min(currentIndex + 1, layouts.length - 1);

    const currentDistance = Math.abs(layouts[currentIndex].offsetTop - probeY);
    const nextDistance = Math.abs(layouts[nextIndex].offsetTop - probeY);

    return nextDistance < currentDistance ? nextIndex : currentIndex;
}

function clampContinuousWindow(
    layouts: PdfPageLayout[],
    startIndex: number,
    endIndex: number,
): PdfPageLayout[] {
    if (layouts.length <= CONTINUOUS_MAX_RENDERED_PAGES) {
        return layouts.slice(startIndex, endIndex);
    }

    const midpoint = Math.floor((startIndex + endIndex - 1) / 2);
    let nextStart = Math.max(
        0,
        midpoint - Math.floor(CONTINUOUS_MAX_RENDERED_PAGES / 2),
    );
    const nextEnd = Math.min(
        layouts.length,
        nextStart + CONTINUOUS_MAX_RENDERED_PAGES,
    );

    nextStart = Math.max(0, nextEnd - CONTINUOUS_MAX_RENDERED_PAGES);
    return layouts.slice(nextStart, nextEnd);
}

interface PdfTabViewProps {
    paneId?: string;
}

export function PdfTabView({ paneId }: PdfTabViewProps) {
    const tab = useEditorStore((s) => {
        const current = selectEditorPaneActiveTab(s, paneId);
        return current && isPdfTab(current) ? current : null;
    });

    if (!tab) {
        return (
            <div
                className="h-full flex items-center justify-center"
                style={{ color: "var(--text-secondary)" }}
            >
                No PDF tab active
            </div>
        );
    }

    return <PdfViewer tab={tab} />;
}

function PdfViewer({ tab }: { tab: PdfTab }) {
    const vaultPath = useVaultStore((state) => state.vaultPath);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});
    const previousViewModeRef = useRef(tab.viewMode);
    const pendingProgrammaticPageRef = useRef<number | null>(null);
    const restoredScrollKeyRef = useRef<string | null>(null);
    const completedScrollRestoreKeyRef = useRef<string | null>(null);
    const restoreAnimationFrameRef = useRef<number | null>(null);
    const isRestoringScrollRef = useRef(false);
    const lastPersistedScrollTopRef = useRef(tab.scrollTop);
    const lastPersistedScrollLeftRef = useRef(tab.scrollLeft);
    const spacePressedRef = useRef(false);
    const dragPanRef = useRef<{
        pointerId: number;
        lastX: number;
        lastY: number;
    } | null>(null);
    const [contextMenu, setContextMenu] = useState<ContextMenuState<{
        pageNumber: number;
        selectedText: string;
        hasSelection: boolean;
    }> | null>(null);

    const pdfFilter = useSettingsStore((s) => s.pdfFilter);
    const setSetting = useSettingsStore((s) => s.setSetting);
    const [loadedPdf, setLoadedPdf] = useState<LoadedPdfState | null>(null);
    const [errorState, setErrorState] = useState<PdfErrorState | null>(null);
    const [pageMetrics, setPageMetrics] = useState<PdfPageMetric[] | null>(
        null,
    );
    const [retryCount, setRetryCount] = useState(0);
    const [scrollTop, setScrollTop] = useState(0);
    const [scrollContainer, setScrollContainer] =
        useState<HTMLDivElement | null>(null);
    const [viewportHeight, setViewportHeight] = useState(
        VIEWPORT_HEIGHT_FALLBACK,
    );
    const [viewportWidth, setViewportWidth] = useState(0);
    const [singlePageSize, setSinglePageSize] =
        useState<PdfRenderedPageSize | null>(null);
    const [isPanModifierActive, setIsPanModifierActive] = useState(false);
    const [isDraggingToPan, setIsDraggingToPan] = useState(false);

    const updatePdfPage = useEditorStore((s) => s.updatePdfPage);
    const updatePdfZoom = useEditorStore((s) => s.updatePdfZoom);
    const updatePdfViewMode = useEditorStore((s) => s.updatePdfViewMode);
    const updatePdfScrollPosition = useEditorStore(
        (s) => s.updatePdfScrollPosition,
    );
    const previewUrl = useMemo(
        () => buildVaultPreviewUrlFromAbsolutePath(tab.path, vaultPath),
        [tab.path, vaultPath],
    );

    const activePdf =
        loadedPdf?.path === tab.path && loadedPdf.retryCount === retryCount
            ? loadedPdf
            : null;
    const error =
        errorState?.path === tab.path && errorState.retryCount === retryCount
            ? errorState.message
            : null;
    const loading = !error && !activePdf;
    const pdf = activePdf?.pdf ?? null;
    const numPages = activePdf?.numPages ?? 0;
    const effectiveZoom = tab.zoom;
    const continuousLayouts = useMemo(
        () => (pageMetrics ? buildPageLayouts(pageMetrics, effectiveZoom) : []),
        [effectiveZoom, pageMetrics],
    );
    const effectiveViewportHeight = Math.max(
        viewportHeight,
        VIEWPORT_HEIGHT_FALLBACK,
    );
    const scrollRestoreKey = useMemo(
        () =>
            [
                tab.id,
                tab.path,
                retryCount,
                tab.viewMode,
                effectiveZoom,
            ].join(":"),
        [effectiveZoom, retryCount, tab.id, tab.path, tab.viewMode],
    );
    const visibleContinuousLayouts = useMemo(() => {
        if (tab.viewMode !== "continuous" || continuousLayouts.length === 0) {
            return [];
        }

        const overscan = Math.max(
            CONTINUOUS_OVERSCAN_PX,
            effectiveViewportHeight,
        );
        const visibleStart = Math.max(0, scrollTop - overscan);
        const visibleEnd = scrollTop + effectiveViewportHeight + overscan;
        const startIndex = findFirstLayoutEndingAfter(
            continuousLayouts,
            visibleStart,
        );
        const endIndex =
            findLastLayoutStartingBefore(continuousLayouts, visibleEnd) + 1;

        return clampContinuousWindow(continuousLayouts, startIndex, endIndex);
    }, [continuousLayouts, effectiveViewportHeight, scrollTop, tab.viewMode]);
    const totalContinuousHeight =
        continuousLayouts.length > 0
            ? continuousLayouts[continuousLayouts.length - 1].bottom
            : 0;
    const continuousContentWidth = useMemo(() => {
        const availableWidth = Math.max(
            0,
            viewportWidth - PDF_SURFACE_PADDING_PX * 2,
        );
        const widestPage = continuousLayouts.reduce(
            (widest, layout) => Math.max(widest, layout.width),
            0,
        );
        return Math.max(availableWidth, widestPage);
    }, [continuousLayouts, viewportWidth]);
    const singlePageContentWidth = useMemo(() => {
        const availableWidth = Math.max(
            0,
            viewportWidth - PDF_SURFACE_PADDING_PX * 2,
        );
        return Math.max(availableWidth, singlePageSize?.width ?? 0);
    }, [singlePageSize?.width, viewportWidth]);
    const pdfContentReady =
        tab.viewMode === "continuous"
            ? continuousLayouts.length > 0 && continuousContentWidth > 0
            : Boolean(singlePageSize && singlePageContentWidth > 0);

    const setPdfError = useCallback(
        (message: string) => {
            setErrorState({
                path: tab.path,
                retryCount,
                message,
            });
        },
        [retryCount, tab.path],
    );

    const registerPageElement = useCallback(
        (pageNumber: number, element: HTMLDivElement | null) => {
            if (element) {
                pageRefs.current[pageNumber] = element;
                return;
            }
            delete pageRefs.current[pageNumber];
        },
        [],
    );

    const registerContainerElement = useCallback(
        (element: HTMLDivElement | null) => {
            containerRef.current = element;
            setScrollContainer(element);
        },
        [],
    );

    const syncScrollStateFromContainer = useCallback(
        (container: HTMLElement) => {
            setViewportHeight(
                container.clientHeight || VIEWPORT_HEIGHT_FALLBACK,
            );
            setViewportWidth(container.clientWidth || 0);
            setScrollTop(container.scrollTop);
        },
        [],
    );

    const persistScrollPosition = useCallback(
        (
            position: PdfScrollPosition,
            force = false,
            allowBeforeRestoreComplete = false,
        ) => {
            if (allowBeforeRestoreComplete) {
                if (restoreAnimationFrameRef.current !== null) {
                    window.cancelAnimationFrame(restoreAnimationFrameRef.current);
                    restoreAnimationFrameRef.current = null;
                }
                isRestoringScrollRef.current = false;
                completedScrollRestoreKeyRef.current = scrollRestoreKey;
            }

            if (
                isRestoringScrollRef.current ||
                (!allowBeforeRestoreComplete &&
                    completedScrollRestoreKeyRef.current !== scrollRestoreKey)
            ) {
                return;
            }

            const normalized = normalizeScrollPosition(position);
            if (
                !force &&
                Math.abs(
                    normalized.top - lastPersistedScrollTopRef.current,
                ) < SCROLL_PERSIST_THRESHOLD_PX &&
                Math.abs(
                    normalized.left - lastPersistedScrollLeftRef.current,
                ) < SCROLL_PERSIST_THRESHOLD_PX
            ) {
                return;
            }

            lastPersistedScrollTopRef.current = normalized.top;
            lastPersistedScrollLeftRef.current = normalized.left;
            updatePdfScrollPosition(tab.id, normalized.top, normalized.left);
        },
        [scrollRestoreKey, tab.id, updatePdfScrollPosition],
    );

    const panScrollSurfaceBy = useCallback(
        (deltaLeft: number, deltaTop: number) => {
            const container = containerRef.current;
            if (!container) return false;

            const previousTop = container.scrollTop;
            const previousLeft = container.scrollLeft;
            scrollPdfSurfaceTo(container, {
                top: previousTop + deltaTop,
                left: previousLeft + deltaLeft,
            });
            syncScrollStateFromContainer(container);
            persistScrollPosition(
                {
                    top: container.scrollTop,
                    left: container.scrollLeft,
                },
                false,
                true,
            );

            return (
                Math.abs(container.scrollTop - previousTop) > 0 ||
                Math.abs(container.scrollLeft - previousLeft) > 0
            );
        },
        [persistScrollPosition, syncScrollStateFromContainer],
    );

    const scrollToPage = useCallback(
        (pageNumber: number, behavior: ScrollBehavior) => {
            const container = containerRef.current;
            if (!container) return;

            if (tab.viewMode === "continuous") {
                const layout = continuousLayouts[pageNumber - 1];
                if (!layout) return;
                pendingProgrammaticPageRef.current = pageNumber;

                container.scrollTo({
                    top: Math.max(layout.offsetTop, 0),
                    left: container.scrollLeft,
                    behavior,
                });
                return;
            }

            const element = pageRefs.current[pageNumber];
            if (!element) return;

            container.scrollTo({
                top: Math.max(element.offsetTop - 24, 0),
                left: container.scrollLeft,
                behavior,
            });
        },
        [continuousLayouts, tab.viewMode],
    );

    useEffect(() => {
        pageRefs.current = {};
    }, [effectiveZoom, retryCount, tab.path, tab.viewMode]);

    useEffect(() => {
        setSinglePageSize(null);
    }, [effectiveZoom, retryCount, tab.page, tab.path]);

    useEffect(() => {
        lastPersistedScrollTopRef.current = tab.scrollTop;
        lastPersistedScrollLeftRef.current = tab.scrollLeft;
    }, [tab.id, tab.scrollLeft, tab.scrollTop]);

    useEffect(() => {
        queueMicrotask(() => setPageMetrics(null));
    }, [retryCount, tab.path]);

    useEffect(() => {
        let cancelled = false;
        let resolvedPdf: pdfjsLib.PDFDocumentProxy | null = null;

        if (!previewUrl) {
            queueMicrotask(() => {
                setLoadedPdf(null);
                setPdfError(
                    "This PDF can no longer be previewed because it is outside the active vault.",
                );
            });
            return;
        }

        const loadingTask = pdfjsLib.getDocument({
            ...PDF_DOCUMENT_OPTIONS,
            url: previewUrl,
        });

        loadingTask.promise
            .then((nextPdf: pdfjsLib.PDFDocumentProxy) => {
                resolvedPdf = nextPdf;
                if (cancelled) {
                    void nextPdf.destroy();
                    return;
                }
                setLoadedPdf({
                    path: tab.path,
                    retryCount,
                    pdf: nextPdf,
                    numPages: nextPdf.numPages,
                });
                setErrorState(null);
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                setPdfError(String(err));
            });

        return () => {
            cancelled = true;
            void loadingTask.destroy();
            if (resolvedPdf) {
                void resolvedPdf.destroy();
            }
        };
    }, [previewUrl, retryCount, setPdfError, tab.path]);

    useEffect(() => {
        const previousViewMode = previousViewModeRef.current;
        previousViewModeRef.current = tab.viewMode;

        if (
            tab.viewMode !== "continuous" ||
            loading ||
            error ||
            !numPages ||
            continuousLayouts.length === 0
        ) {
            return;
        }
        if (
            previousViewMode === "continuous" &&
            previousViewMode === tab.viewMode
        ) {
            return;
        }

        const frame = window.requestAnimationFrame(() => {
            scrollToPage(Math.max(1, Math.min(tab.page, numPages)), "auto");
        });
        return () => window.cancelAnimationFrame(frame);
    }, [
        continuousLayouts.length,
        error,
        loading,
        numPages,
        scrollToPage,
        tab.page,
        tab.viewMode,
    ]);

    useEffect(() => {
        if (!scrollContainer) return;

        let frame = 0;
        const scheduleSync = () => {
            persistScrollPosition({
                top: scrollContainer.scrollTop,
                left: scrollContainer.scrollLeft,
            });
            window.cancelAnimationFrame(frame);
            frame = window.requestAnimationFrame(() =>
                syncScrollStateFromContainer(scrollContainer),
            );
        };

        syncScrollStateFromContainer(scrollContainer);
        scrollContainer.addEventListener("scroll", scheduleSync, {
            passive: true,
        });
        window.addEventListener("resize", scheduleSync);
        return () => {
            window.cancelAnimationFrame(frame);
            persistScrollPosition(
                {
                    top: scrollContainer.scrollTop,
                    left: scrollContainer.scrollLeft,
                },
                true,
            );
            scrollContainer.removeEventListener("scroll", scheduleSync);
            window.removeEventListener("resize", scheduleSync);
        };
    }, [
        persistScrollPosition,
        scrollContainer,
        syncScrollStateFromContainer,
    ]);

    useEffect(() => {
        if (!scrollContainer || loading || error) return;
        if (!pdfContentReady) return;

        if (restoredScrollKeyRef.current === scrollRestoreKey) return;
        restoredScrollKeyRef.current = scrollRestoreKey;
        completedScrollRestoreKeyRef.current = null;
        isRestoringScrollRef.current = true;

        const targetScrollTop =
            tab.scrollTop > 0
                ? tab.scrollTop
                : tab.viewMode === "continuous"
                  ? (continuousLayouts[tab.page - 1]?.offsetTop ?? 0)
                  : 0;

        const frame = window.requestAnimationFrame(() => {
            restoreAnimationFrameRef.current = null;
            scrollContainer.scrollTo({
                top: Math.max(0, targetScrollTop),
                left: Math.max(0, tab.scrollLeft),
                behavior: "auto",
            });
            syncScrollStateFromContainer(scrollContainer);
            lastPersistedScrollTopRef.current = Math.max(
                0,
                Math.round(scrollContainer.scrollTop),
            );
            lastPersistedScrollLeftRef.current = Math.max(
                0,
                Math.round(scrollContainer.scrollLeft),
            );
            completedScrollRestoreKeyRef.current = scrollRestoreKey;
            isRestoringScrollRef.current = false;
        });
        restoreAnimationFrameRef.current = frame;

        return () => {
            isRestoringScrollRef.current = false;
            restoreAnimationFrameRef.current = null;
            window.cancelAnimationFrame(frame);
        };
    }, [
        continuousLayouts,
        error,
        loading,
        pdfContentReady,
        scrollRestoreKey,
        scrollContainer,
        syncScrollStateFromContainer,
        tab.page,
        tab.scrollLeft,
        tab.scrollTop,
        tab.viewMode,
    ]);

    useEffect(() => {
        if (tab.viewMode !== "continuous" || !pdf || pageMetrics) return;

        let cancelled = false;

        const loadPageMetrics = async () => {
            const nextMetrics: PdfPageMetric[] = [];

            for (
                let pageNumber = 1;
                pageNumber <= pdf.numPages;
                pageNumber += 1
            ) {
                const page = await pdf.getPage(pageNumber);
                const viewport = page.getViewport({ scale: 1 });
                page.cleanup?.();

                if (cancelled) {
                    return;
                }

                nextMetrics.push({
                    pageNumber,
                    width: viewport.width,
                    height: viewport.height,
                });
            }

            if (!cancelled) {
                setPageMetrics(nextMetrics);
            }
        };

        loadPageMetrics().catch((err: unknown) => {
            if (!cancelled) {
                setPdfError(String(err));
            }
        });

        return () => {
            cancelled = true;
        };
    }, [pageMetrics, pdf, setPdfError, tab.viewMode]);

    useEffect(() => {
        if (tab.viewMode !== "continuous" || continuousLayouts.length === 0) {
            return;
        }
        if (
            isRestoringScrollRef.current ||
            completedScrollRestoreKeyRef.current !== scrollRestoreKey
        ) {
            return;
        }

        const pendingPageNumber = pendingProgrammaticPageRef.current;
        if (pendingPageNumber !== null) {
            const pendingLayout = continuousLayouts[pendingPageNumber - 1];
            if (!pendingLayout) {
                pendingProgrammaticPageRef.current = null;
                return;
            }

            if (Math.abs(scrollTop - pendingLayout.offsetTop) > 2) {
                return;
            }

            pendingProgrammaticPageRef.current = null;
        }

        const probeY =
            scrollTop + Math.min(effectiveViewportHeight * 0.35, 240);
        const closestIndex = findClosestLayoutIndex(continuousLayouts, probeY);
        const closestPage = continuousLayouts[closestIndex]?.pageNumber;

        if (closestPage && closestPage !== tab.page) {
            updatePdfPage(tab.id, closestPage);
        }
    }, [
        continuousLayouts,
        effectiveViewportHeight,
        scrollTop,
        scrollRestoreKey,
        tab.id,
        tab.page,
        tab.viewMode,
        updatePdfPage,
    ]);

    const goToPreviousPage = useCallback(() => {
        const targetPage = Math.max(1, tab.page - 1);
        if (targetPage === tab.page) return;

        updatePdfPage(tab.id, targetPage);
        if (tab.viewMode === "continuous") {
            scrollToPage(targetPage, "smooth");
        }
    }, [scrollToPage, tab.id, tab.page, tab.viewMode, updatePdfPage]);

    const goToNextPage = useCallback(() => {
        const targetPage = Math.min(numPages, tab.page + 1);
        if (targetPage === tab.page) return;

        updatePdfPage(tab.id, targetPage);
        if (tab.viewMode === "continuous") {
            scrollToPage(targetPage, "smooth");
        }
    }, [numPages, scrollToPage, tab.id, tab.page, tab.viewMode, updatePdfPage]);

    const zoomIn = useCallback(() => {
        updatePdfZoom(tab.id, clampZoom(effectiveZoom, "in"));
    }, [effectiveZoom, tab.id, updatePdfZoom]);

    const zoomOut = useCallback(() => {
        updatePdfZoom(tab.id, clampZoom(effectiveZoom, "out"));
    }, [effectiveZoom, tab.id, updatePdfZoom]);

    const toggleViewMode = useCallback(() => {
        const nextViewMode =
            tab.viewMode === "continuous" ? "single" : "continuous";
        updatePdfViewMode(tab.id, nextViewMode);
    }, [tab.id, tab.viewMode, updatePdfViewMode]);

    const openExternally = useCallback(() => {
        void openPath(tab.path);
    }, [tab.path]);

    const selectAllTextForPage = useCallback((pageNumber: number) => {
        const textLayer = containerRef.current?.querySelector<HTMLElement>(
            `[data-page-number="${pageNumber}"] .textLayer`,
        );
        if (!textLayer) return;

        const selection = window.getSelection();
        if (!selection) return;

        const range = document.createRange();
        range.selectNodeContents(textLayer);
        selection.removeAllRanges();
        selection.addRange(range);
    }, []);

    const copySelectedText = useCallback(async (text: string) => {
        if (!text) return;
        await navigator.clipboard.writeText(text);
    }, []);

    const handlePdfContextMenu = useCallback(
        (event: ReactMouseEvent<HTMLDivElement>, pageNumber: number) => {
            event.preventDefault();
            const selectedText = getSelectionText();
            setContextMenu({
                x: event.clientX,
                y: event.clientY,
                payload: {
                    pageNumber,
                    selectedText,
                    hasSelection: selectedText.length > 0,
                },
            });
        },
        [],
    );

    const handlePageDimensions = useCallback(
        (pageNumber: number, size: PdfRenderedPageSize) => {
            if (pageNumber !== tab.page) return;
            setSinglePageSize((current) =>
                current?.width === size.width && current.height === size.height
                    ? current
                    : size,
            );
        },
        [tab.page],
    );

    const handlePanPointerDown = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            if (
                !spacePressedRef.current ||
                (event.button !== 0 && event.buttons !== 1)
            ) {
                return;
            }
            event.preventDefault();
            event.currentTarget.setPointerCapture?.(event.pointerId);
            dragPanRef.current = {
                pointerId: event.pointerId,
                lastX: event.clientX,
                lastY: event.clientY,
            };
            setIsDraggingToPan(true);
        },
        [],
    );

    const handlePanPointerMove = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            const dragState = dragPanRef.current;
            if (!dragState || dragState.pointerId !== event.pointerId) return;

            event.preventDefault();
            const deltaX = event.clientX - dragState.lastX;
            const deltaY = event.clientY - dragState.lastY;
            dragPanRef.current = {
                pointerId: event.pointerId,
                lastX: event.clientX,
                lastY: event.clientY,
            };
            panScrollSurfaceBy(-deltaX, -deltaY);
        },
        [panScrollSurfaceBy],
    );

    const handlePanMouseDown = useCallback(
        (event: ReactMouseEvent<HTMLDivElement>) => {
            if ("PointerEvent" in window) return;
            if (
                !spacePressedRef.current ||
                (event.button !== 0 && event.buttons !== 1)
            ) {
                return;
            }
            event.preventDefault();
            dragPanRef.current = {
                pointerId: -1,
                lastX: event.clientX,
                lastY: event.clientY,
            };
            setIsDraggingToPan(true);
        },
        [],
    );

    const handlePanMouseMove = useCallback(
        (event: ReactMouseEvent<HTMLDivElement>) => {
            if ("PointerEvent" in window) return;
            const dragState = dragPanRef.current;
            if (!dragState || dragState.pointerId !== -1) return;

            event.preventDefault();
            const deltaX = event.clientX - dragState.lastX;
            const deltaY = event.clientY - dragState.lastY;
            dragPanRef.current = {
                pointerId: -1,
                lastX: event.clientX,
                lastY: event.clientY,
            };
            panScrollSurfaceBy(-deltaX, -deltaY);
        },
        [panScrollSurfaceBy],
    );

    const stopMousePan = useCallback(() => {
        const dragState = dragPanRef.current;
        if (!dragState || dragState.pointerId !== -1) return;
        dragPanRef.current = null;
        setIsDraggingToPan(false);
    }, []);

    const stopPointerPan = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            const dragState = dragPanRef.current;
            if (!dragState || dragState.pointerId !== event.pointerId) return;
            event.currentTarget.releasePointerCapture?.(event.pointerId);
            dragPanRef.current = null;
            setIsDraggingToPan(false);
        },
        [],
    );

    const activeFilter =
        PDF_FILTERS.find((f) => f.mode === pdfFilter) ?? PDF_FILTERS[0];
    const cycleFilter = useCallback(() => {
        const index = PDF_FILTERS.findIndex((f) => f.mode === pdfFilter);
        const nextFilter = PDF_FILTERS[(index + 1) % PDF_FILTERS.length].mode;
        setSetting("pdfFilter", nextFilter);
    }, [pdfFilter, setSetting]);

    useEffect(() => {
        if (!scrollContainer) return;
        const container = scrollContainer;

        function handleWheel(event: WheelEvent) {
            if (event.metaKey || event.ctrlKey) {
                event.preventDefault();
                return;
            }

            if (!event.shiftKey) return;

            const horizontalDelta =
                event.deltaX !== 0 ? event.deltaX : event.deltaY;
            if (horizontalDelta === 0) return;

            event.preventDefault();
            scrollPdfSurfaceTo(container, {
                left: container.scrollLeft + horizontalDelta,
            });
            syncScrollStateFromContainer(container);
            persistScrollPosition(
                {
                    top: container.scrollTop,
                    left: container.scrollLeft,
                },
                false,
                true,
            );
        }

        const suppressPinchGesture = (event: Event) => {
            event.preventDefault();
        };

        container.addEventListener("wheel", handleWheel, {
            passive: false,
        });
        for (const eventName of PINCH_GESTURE_EVENTS) {
            container.addEventListener(eventName, suppressPinchGesture, {
                passive: false,
            });
        }
        return () => {
            container.removeEventListener("wheel", handleWheel);
            for (const eventName of PINCH_GESTURE_EVENTS) {
                container.removeEventListener(eventName, suppressPinchGesture);
            }
        };
    }, [persistScrollPosition, scrollContainer, syncScrollStateFromContainer]);

    useEffect(() => {
        function handleKeyDown(event: KeyboardEvent) {
            if (isEditableEventTarget(event.target)) return;

            if (event.code === "Space") {
                event.preventDefault();
                if (!spacePressedRef.current) {
                    spacePressedRef.current = true;
                    setIsPanModifierActive(true);
                }
                return;
            }

            const container = containerRef.current;

            if (event.key === "ArrowLeft") {
                event.preventDefault();
                if (container && canScrollLeft(container)) {
                    panScrollSurfaceBy(-KEYBOARD_HORIZONTAL_PAN_PX, 0);
                } else {
                    goToPreviousPage();
                }
                return;
            }

            if (event.key === "ArrowRight") {
                event.preventDefault();
                if (container && canScrollRight(container)) {
                    panScrollSurfaceBy(KEYBOARD_HORIZONTAL_PAN_PX, 0);
                } else {
                    goToNextPage();
                }
                return;
            }

            if (event.key === "ArrowUp") {
                event.preventDefault();
                if (container && canScrollUp(container)) {
                    panScrollSurfaceBy(0, -KEYBOARD_VERTICAL_PAN_PX);
                } else if (tab.viewMode === "single") {
                    goToPreviousPage();
                }
                return;
            }

            if (event.key === "ArrowDown") {
                event.preventDefault();
                if (container && canScrollDown(container)) {
                    panScrollSurfaceBy(0, KEYBOARD_VERTICAL_PAN_PX);
                } else if (tab.viewMode === "single") {
                    goToNextPage();
                }
                return;
            }

            if (event.key === "PageUp") {
                event.preventDefault();
                goToPreviousPage();
                return;
            }

            if (event.key === "PageDown") {
                event.preventDefault();
                goToNextPage();
                return;
            }

            if (event.key === "Home") {
                event.preventDefault();
                if (tab.viewMode === "continuous" && container) {
                    scrollPdfSurfaceTo(container, { top: 0 });
                    syncScrollStateFromContainer(container);
                    persistScrollPosition(
                        {
                            top: container.scrollTop,
                            left: container.scrollLeft,
                        },
                        false,
                        true,
                    );
                } else if (tab.page !== 1) {
                    updatePdfPage(tab.id, 1);
                }
                return;
            }

            if (event.key === "End") {
                event.preventDefault();
                if (tab.viewMode === "continuous" && container) {
                    scrollPdfSurfaceTo(container, {
                        top: getMaxScrollTop(container),
                    });
                    syncScrollStateFromContainer(container);
                    persistScrollPosition(
                        {
                            top: container.scrollTop,
                            left: container.scrollLeft,
                        },
                        false,
                        true,
                    );
                } else if (tab.page !== numPages) {
                    updatePdfPage(tab.id, numPages);
                }
            }
        }

        function handleKeyUp(event: KeyboardEvent) {
            if (event.code !== "Space") return;
            spacePressedRef.current = false;
            setIsPanModifierActive(false);
            dragPanRef.current = null;
            setIsDraggingToPan(false);
        }

        function handleBlur() {
            spacePressedRef.current = false;
            setIsPanModifierActive(false);
            dragPanRef.current = null;
            setIsDraggingToPan(false);
        }

        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("keyup", handleKeyUp);
        window.addEventListener("blur", handleBlur);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("keyup", handleKeyUp);
            window.removeEventListener("blur", handleBlur);
        };
    }, [
        goToNextPage,
        goToPreviousPage,
        numPages,
        panScrollSurfaceBy,
        persistScrollPosition,
        syncScrollStateFromContainer,
        tab.id,
        tab.page,
        tab.viewMode,
        updatePdfPage,
    ]);

    if (loading) {
        return (
            <div
                className="h-full flex items-center justify-center"
                style={{ color: "var(--text-secondary)" }}
            >
                Loading PDF...
            </div>
        );
    }

    if (error) {
        const friendlyMessage = classifyPdfError(error);
        return (
            <div
                className="h-full flex flex-col items-center justify-center gap-3 px-8"
                style={{ color: "var(--text-secondary)" }}
            >
                <svg
                    width="32"
                    height="32"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ opacity: 0.4 }}
                >
                    <path d="M4 1h6l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1z" />
                    <path d="M10 1v4h4" />
                    <path d="M6 10l4-4M6 6l4 4" />
                </svg>
                <span
                    className="text-[13px] font-medium"
                    style={{ color: "var(--text-primary)" }}
                >
                    Failed to load PDF
                </span>
                <span className="text-[12px] text-center max-w-sm">
                    {friendlyMessage}
                </span>
                <div className="flex items-center gap-2 mt-1">
                    <button
                        onClick={() => setRetryCount((count) => count + 1)}
                        className="px-3 py-1 rounded text-[12px] transition-colors"
                        style={{
                            backgroundColor: "var(--bg-secondary)",
                            border: "1px solid var(--border)",
                            color: "var(--text-primary)",
                        }}
                        onMouseEnter={(event) => {
                            event.currentTarget.style.borderColor =
                                "var(--accent)";
                        }}
                        onMouseLeave={(event) => {
                            event.currentTarget.style.borderColor =
                                "var(--border)";
                        }}
                    >
                        Retry
                    </button>
                    <button
                        onClick={() => void openPath(tab.path)}
                        className="px-3 py-1 rounded text-[12px] transition-colors"
                        style={{
                            backgroundColor: "var(--bg-secondary)",
                            border: "1px solid var(--border)",
                            color: "var(--text-primary)",
                        }}
                        onMouseEnter={(event) => {
                            event.currentTarget.style.borderColor =
                                "var(--accent)";
                        }}
                        onMouseLeave={(event) => {
                            event.currentTarget.style.borderColor =
                                "var(--border)";
                        }}
                    >
                        Open Externally
                    </button>
                </div>
            </div>
        );
    }

    if (!pdf) return null;

    const contextMenuEntries: ContextMenuEntry[] = contextMenu
        ? [
              {
                  label: "Copy",
                  action: () =>
                      void copySelectedText(contextMenu.payload.selectedText),
                  disabled: !contextMenu.payload.hasSelection,
              },
              {
                  label: "Select All",
                  action: () =>
                      selectAllTextForPage(contextMenu.payload.pageNumber),
              },
          ]
        : [];

    return (
        <div
            className="h-full min-w-0 flex flex-col overflow-hidden"
            style={{ background: "var(--bg-primary)" }}
        >
            <div
                className="flex min-w-0 items-center gap-2 overflow-x-auto px-3 shrink-0"
                style={{
                    height: 39,
                    borderBottom: "1px solid var(--border)",
                    background: "var(--bg-secondary)",
                    color: "var(--text-secondary)",
                    fontSize: 12,
                }}
            >
                <ToolbarButton
                    onClick={goToPreviousPage}
                    disabled={tab.page <= 1}
                    title="Previous page"
                >
                    <ChevronLeftIcon />
                    <span>Previous</span>
                </ToolbarButton>

                <span
                    style={{
                        color: "var(--text-primary)",
                        fontVariantNumeric: "tabular-nums",
                    }}
                >
                    Page {tab.page} / {numPages}
                </span>

                <ToolbarButton
                    onClick={goToNextPage}
                    disabled={tab.page >= numPages}
                    title="Next page"
                >
                    <span>Next</span>
                    <ChevronRightIcon />
                </ToolbarButton>

                <div
                    style={{
                        width: 1,
                        height: 16,
                        background: "var(--border)",
                        margin: "0 4px",
                    }}
                />

                <ToolbarButton
                    onClick={zoomOut}
                    disabled={effectiveZoom <= ZOOM_STEPS[0]}
                    title="Zoom out"
                >
                    <MinusIcon />
                </ToolbarButton>
                <span
                    style={{
                        minWidth: 48,
                        textAlign: "center",
                        fontVariantNumeric: "tabular-nums",
                    }}
                >
                    {formatZoomPercentage(effectiveZoom)}
                </span>
                <ToolbarButton
                    onClick={zoomIn}
                    disabled={
                        effectiveZoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]
                    }
                    title="Zoom in"
                >
                    <PlusIcon />
                </ToolbarButton>

                <div
                    style={{
                        width: 1,
                        height: 16,
                        background: "var(--border)",
                        margin: "0 4px",
                    }}
                />

                <ToolbarButton
                    onClick={toggleViewMode}
                    active={tab.viewMode === "continuous"}
                    title={
                        tab.viewMode === "continuous"
                            ? "Switch to single-page view"
                            : "Switch to continuous view"
                    }
                >
                    <StackPagesIcon />
                    <span>
                        {tab.viewMode === "continuous"
                            ? "Continuous"
                            : "Single Page"}
                    </span>
                </ToolbarButton>

                <div
                    style={{
                        width: 1,
                        height: 16,
                        background: "var(--border)",
                        margin: "0 4px",
                    }}
                />

                <ToolbarButton
                    onClick={cycleFilter}
                    active={pdfFilter !== "none"}
                    title={`Filter: ${activeFilter.label}`}
                >
                    <FilterIcon />
                    <span>{activeFilter.label}</span>
                </ToolbarButton>

                <div style={{ flex: 1 }} />

                <ToolbarButton onClick={openExternally} title="Open externally">
                    <ExternalLinkIcon />
                    <span>Open Externally</span>
                </ToolbarButton>
            </div>

            <div
                ref={registerContainerElement}
                className="min-w-0 flex-1 overflow-auto"
                data-pdf-scroll-surface="true"
                onPointerDown={handlePanPointerDown}
                onPointerMove={handlePanPointerMove}
                onPointerUp={stopPointerPan}
                onPointerCancel={stopPointerPan}
                onMouseDown={handlePanMouseDown}
                onMouseMove={handlePanMouseMove}
                onMouseUp={stopMousePan}
                onMouseLeave={stopMousePan}
                style={{
                    padding: PDF_SURFACE_PADDING_PX,
                    background:
                        "color-mix(in srgb, var(--bg-primary) 92%, #000)",
                    // Preserve native panning in both axes while requiring
                    // explicit toolbar controls for zoom changes.
                    touchAction: "pan-x pan-y",
                    cursor: isDraggingToPan
                        ? "grabbing"
                        : isPanModifierActive
                          ? "grab"
                          : undefined,
                }}
            >
                {tab.viewMode === "continuous" ? (
                    <div
                        ref={contentRef}
                        className="min-w-0"
                        data-pdf-content="continuous"
                        style={{
                            filter: activeFilter.css,
                            position:
                                continuousLayouts.length > 0
                                    ? "relative"
                                    : "static",
                            width: `${continuousContentWidth}px`,
                            minWidth: `${continuousContentWidth}px`,
                            height:
                                continuousLayouts.length > 0
                                    ? `${totalContinuousHeight}px`
                                    : undefined,
                        }}
                    >
                        {continuousLayouts.length === 0 ? (
                            <div
                                className="flex items-center justify-center py-10 text-[12px]"
                                style={{ color: "var(--text-secondary)" }}
                            >
                                Preparing pages...
                            </div>
                        ) : (
                            visibleContinuousLayouts.map((layout) => (
                                <PdfPageCanvas
                                    key={`${tab.path}:${retryCount}:${layout.pageNumber}:${effectiveZoom}`}
                                    pdf={pdf}
                                    pageNumber={layout.pageNumber}
                                    zoom={effectiveZoom}
                                    onRenderError={setPdfError}
                                    onContextMenu={handlePdfContextMenu}
                                    registerElement={registerPageElement}
                                    wrapperStyle={{
                                        position: "absolute",
                                        insetInline: 0,
                                        top: `${layout.offsetTop}px`,
                                    }}
                                />
                            ))
                        )}
                    </div>
                ) : (
                    <div
                        ref={contentRef}
                        className="min-w-0 flex justify-center"
                        data-pdf-content="single"
                        style={{
                            filter: activeFilter.css,
                            width: `${singlePageContentWidth}px`,
                            minWidth: `${singlePageContentWidth}px`,
                        }}
                    >
                        <PdfPageCanvas
                            key={`${tab.path}:${retryCount}:${tab.page}:${effectiveZoom}`}
                            pdf={pdf}
                            pageNumber={tab.page}
                            zoom={effectiveZoom}
                            onRenderError={setPdfError}
                            onContextMenu={handlePdfContextMenu}
                            onPageDimensions={handlePageDimensions}
                        />
                    </div>
                )}
            </div>
            {contextMenu ? (
                <ContextMenu
                    menu={contextMenu}
                    entries={contextMenuEntries}
                    onClose={() => setContextMenu(null)}
                />
            ) : null}
        </div>
    );
}

function PdfPageCanvas({
    pdf,
    pageNumber,
    zoom,
    onRenderError,
    onContextMenu,
    onPageDimensions,
    registerElement,
    wrapperStyle,
}: {
    pdf: pdfjsLib.PDFDocumentProxy;
    pageNumber: number;
    zoom: number;
    onRenderError: (message: string) => void;
    onContextMenu?: (
        event: ReactMouseEvent<HTMLDivElement>,
        pageNumber: number,
    ) => void;
    onPageDimensions?: (
        pageNumber: number,
        size: PdfRenderedPageSize,
    ) => void;
    registerElement?: (
        pageNumber: number,
        element: HTMLDivElement | null,
    ) => void;
    wrapperStyle?: CSSProperties;
}) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const pageShellRef = useRef<HTMLDivElement>(null);
    const textLayerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let cancelled = false;
        let renderTask: pdfjsLib.RenderTask | null = null;
        let textLayer: pdfjsLib.TextLayer | null = null;
        let currentPage: pdfjsLib.PDFPageProxy | null = null;

        const clearTextLayer = () => {
            const textLayerElement = textLayerRef.current;
            if (!textLayerElement) return;
            textLayerElement.replaceChildren();
        };

        pdf.getPage(pageNumber)
            .then((page: pdfjsLib.PDFPageProxy) => {
                currentPage = page;
                if (cancelled) return;

                const canvas = canvasRef.current;
                const pageShell = pageShellRef.current;
                const textLayerElement = textLayerRef.current;
                if (!canvas || !pageShell || !textLayerElement) return;

                const displayViewport = page.getViewport({ scale: zoom });
                const renderViewport = page.getViewport({
                    scale: zoom * getPixelRatio(),
                });

                pageShell.style.width = `${displayViewport.width}px`;
                pageShell.style.height = `${displayViewport.height}px`;
                pageShell.style.setProperty(
                    "--scale-factor",
                    String(displayViewport.scale),
                );
                pageShell.style.setProperty(
                    "--user-unit",
                    String(page.userUnit ?? 1),
                );
                onPageDimensions?.(pageNumber, {
                    width: displayViewport.width,
                    height: displayViewport.height,
                });

                clearTextLayer();

                canvas.width = renderViewport.width;
                canvas.height = renderViewport.height;
                canvas.style.width = `${displayViewport.width}px`;
                canvas.style.height = `${displayViewport.height}px`;

                const context = canvas.getContext("2d");
                if (!context) {
                    onRenderError(
                        "Could not create a canvas rendering context.",
                    );
                    return;
                }

                renderTask = page.render({
                    canvas,
                    canvasContext: context,
                    viewport: renderViewport,
                });
                renderTask.promise.catch((err: unknown) => {
                    if (
                        cancelled ||
                        err instanceof pdfjsLib.RenderingCancelledException
                    ) {
                        return;
                    }
                    onRenderError(String(err));
                });

                textLayer = new pdfjsLib.TextLayer({
                    textContentSource: page.streamTextContent(
                        PDF_TEXT_CONTENT_OPTIONS,
                    ),
                    container: textLayerElement,
                    viewport: displayViewport,
                });
                textLayer.render().then(
                    () => {
                        if (cancelled) return;
                        const endOfContent = document.createElement("div");
                        endOfContent.className = "endOfContent";
                        textLayerElement.append(endOfContent);
                    },
                    (err: unknown) => {
                        if (cancelled) return;
                        onRenderError(String(err));
                    },
                );
            })
            .catch((err: unknown) => {
                if (!cancelled) {
                    onRenderError(String(err));
                }
            });

        return () => {
            cancelled = true;
            renderTask?.cancel();
            textLayer?.cancel();
            clearTextLayer();
            currentPage?.cleanup?.();
        };
    }, [onPageDimensions, onRenderError, pageNumber, pdf, zoom]);

    return (
        <div
            ref={(element) => registerElement?.(pageNumber, element)}
            className="flex justify-center w-full"
            data-page-number={pageNumber}
            style={wrapperStyle}
            onContextMenu={(event) => onContextMenu?.(event, pageNumber)}
        >
            <div ref={pageShellRef} className="pdf-page-shell">
                <canvas
                    ref={canvasRef}
                    style={{
                        boxShadow: "0 2px 16px rgba(0,0,0,0.15)",
                        background: "#fff",
                    }}
                />
                <div
                    ref={textLayerRef}
                    className="textLayer"
                    data-selectable="true"
                />
            </div>
        </div>
    );
}

function ToolbarButton({
    onClick,
    disabled,
    title,
    active,
    children,
}: {
    onClick: () => void;
    disabled?: boolean;
    title: string;
    active?: boolean;
    children: React.ReactNode;
}) {
    const idleBackground = active ? "var(--bg-tertiary)" : "transparent";

    return (
        <button
            onClick={onClick}
            disabled={disabled}
            title={title}
            className="flex items-center gap-1 px-2 rounded transition-colors"
            style={{
                height: 24,
                opacity: disabled ? 0.35 : 1,
                cursor: disabled ? "default" : "pointer",
                color: active ? "var(--text-primary)" : "inherit",
                background: idleBackground,
                border: "none",
            }}
            onMouseEnter={(event) => {
                if (!disabled) {
                    event.currentTarget.style.background = "var(--bg-tertiary)";
                }
            }}
            onMouseLeave={(event) => {
                event.currentTarget.style.background = idleBackground;
            }}
        >
            {children}
        </button>
    );
}

function FilterIcon() {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <circle cx="6" cy="6" r="3.5" />
            <circle cx="10" cy="10" r="3.5" />
        </svg>
    );
}

function ChevronLeftIcon() {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M10 4l-4 4 4 4" />
        </svg>
    );
}

function ChevronRightIcon() {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M6 4l4 4-4 4" />
        </svg>
    );
}

function MinusIcon() {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
        >
            <path d="M4 8h8" />
        </svg>
    );
}

function PlusIcon() {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
        >
            <path d="M8 4v8M4 8h8" />
        </svg>
    );
}

function StackPagesIcon() {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M4.5 2.5h6a1 1 0 011 1v8a1 1 0 01-1 1h-6a1 1 0 01-1-1v-8a1 1 0 011-1z" />
            <path d="M6 5.5h4" />
            <path d="M6 8h4" />
            <path d="M6 10.5h4" />
            <path d="M2.5 4.5v8a1 1 0 001 1h6" />
        </svg>
    );
}

function ExternalLinkIcon() {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M12 9v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h4" />
            <path d="M10 3h3v3" />
            <path d="M7 9l6-6" />
        </svg>
    );
}
