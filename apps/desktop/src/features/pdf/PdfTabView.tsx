import { useCallback, useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import {
    useEditorStore,
    isPdfTab,
    type PdfTab,
} from "../../app/store/editorStore";
import {
    isWheelZoomGesture,
    useWheelZoomModifier,
} from "../../app/hooks/useWheelZoomModifier";
import { formatZoomPercentage, persistWheelZoom } from "../../app/utils/zoom";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
    import.meta.url,
).toString();

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const PIXEL_RATIO = window.devicePixelRatio || 1;
const PINCH_SENSITIVITY = 0.0025;
const PINCH_COMMIT_DELAY = 150;
const PDF_TEXT_CONTENT_OPTIONS = {
    includeMarkedContent: true,
    disableNormalization: true,
} as const;

type PdfFilter = "none" | "dark" | "sepia" | "grayscale";
const PDF_FILTERS: { mode: PdfFilter; label: string; css: string }[] = [
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

export function PdfTabView() {
    const tab = useEditorStore((s) => {
        const current = s.tabs.find(
            (candidate) => candidate.id === s.activeTabId,
        );
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
    const containerRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});
    const previousViewModeRef = useRef(tab.viewMode);
    const pinchZoomRef = useRef(tab.zoom);
    const pinchTimerRef = useRef(0);
    const wheelZoomModifierRef = useWheelZoomModifier();

    const [pdfFilter, setPdfFilter] = useState<PdfFilter>("none");
    const [loadedPdf, setLoadedPdf] = useState<LoadedPdfState | null>(null);
    const [errorState, setErrorState] = useState<PdfErrorState | null>(null);
    const [retryCount, setRetryCount] = useState(0);

    const updatePdfPage = useEditorStore((s) => s.updatePdfPage);
    const updatePdfZoom = useEditorStore((s) => s.updatePdfZoom);
    const updatePdfViewMode = useEditorStore((s) => s.updatePdfViewMode);

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

    const scrollToPage = useCallback(
        (pageNumber: number, behavior: ScrollBehavior) => {
            const container = containerRef.current;
            const element = pageRefs.current[pageNumber];
            if (!container || !element) return;

            container.scrollTo({
                top: Math.max(element.offsetTop - 24, 0),
                behavior,
            });
        },
        [],
    );

    useEffect(() => {
        pageRefs.current = {};
    }, [tab.path, tab.viewMode, tab.zoom, retryCount]);

    useEffect(() => {
        let cancelled = false;
        let resolvedPdf: pdfjsLib.PDFDocumentProxy | null = null;

        const loadingTask = pdfjsLib.getDocument({
            ...PDF_DOCUMENT_OPTIONS,
            url: convertFileSrc(tab.path),
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
    }, [retryCount, setPdfError, tab.path]);

    useEffect(() => {
        const previousViewMode = previousViewModeRef.current;
        previousViewModeRef.current = tab.viewMode;

        if (tab.viewMode !== "continuous" || loading || error || !numPages) {
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
    }, [error, loading, numPages, scrollToPage, tab.page, tab.viewMode]);

    const syncVisiblePage = useCallback(() => {
        if (tab.viewMode !== "continuous" || !numPages) return;

        const container = containerRef.current;
        if (!container) return;

        const containerRect = container.getBoundingClientRect();
        const probeY =
            containerRect.top + Math.min(container.clientHeight * 0.35, 240);

        let closestPage = tab.page;
        let closestDistance = Number.POSITIVE_INFINITY;

        for (let pageNumber = 1; pageNumber <= numPages; pageNumber++) {
            const element = pageRefs.current[pageNumber];
            if (!element) continue;

            const rect = element.getBoundingClientRect();
            const visible =
                rect.bottom >= containerRect.top &&
                rect.top <= containerRect.bottom;
            if (!visible) continue;

            const distance = Math.abs(rect.top - probeY);
            if (distance < closestDistance) {
                closestDistance = distance;
                closestPage = pageNumber;
            }
        }

        if (closestPage !== tab.page) {
            updatePdfPage(tab.id, closestPage);
        }
    }, [numPages, tab.id, tab.page, tab.viewMode, updatePdfPage]);

    useEffect(() => {
        if (tab.viewMode !== "continuous" || !numPages) return;

        const container = containerRef.current;
        if (!container) return;

        let frame = 0;
        const handleScroll = () => {
            window.cancelAnimationFrame(frame);
            frame = window.requestAnimationFrame(syncVisiblePage);
        };

        handleScroll();
        container.addEventListener("scroll", handleScroll, { passive: true });
        return () => {
            window.cancelAnimationFrame(frame);
            container.removeEventListener("scroll", handleScroll);
        };
    }, [numPages, syncVisiblePage, tab.viewMode]);

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
        updatePdfZoom(tab.id, clampZoom(tab.zoom, "in"));
    }, [tab.id, tab.zoom, updatePdfZoom]);

    const zoomOut = useCallback(() => {
        updatePdfZoom(tab.id, clampZoom(tab.zoom, "out"));
    }, [tab.id, tab.zoom, updatePdfZoom]);

    const toggleViewMode = useCallback(() => {
        const nextViewMode =
            tab.viewMode === "continuous" ? "single" : "continuous";
        updatePdfViewMode(tab.id, nextViewMode);
    }, [tab.id, tab.viewMode, updatePdfViewMode]);

    const openExternally = useCallback(() => {
        void openPath(tab.path);
    }, [tab.path]);

    const activeFilter = PDF_FILTERS.find((f) => f.mode === pdfFilter)!;
    const cycleFilter = useCallback(() => {
        setPdfFilter((current) => {
            const index = PDF_FILTERS.findIndex((f) => f.mode === current);
            return PDF_FILTERS[(index + 1) % PDF_FILTERS.length].mode;
        });
    }, []);

    useEffect(() => {
        pinchZoomRef.current = tab.zoom;
    }, [tab.zoom]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        function handleWheel(event: WheelEvent) {
            if (!isWheelZoomGesture(event, wheelZoomModifierRef)) return;
            event.preventDefault();

            const prev = pinchZoomRef.current;
            const next = Math.min(
                MAX_ZOOM,
                Math.max(
                    MIN_ZOOM,
                    prev * (1 - event.deltaY * PINCH_SENSITIVITY),
                ),
            );
            pinchZoomRef.current = next;

            // Instant visual feedback via CSS transform
            const content = contentRef.current;
            if (content) {
                content.style.transformOrigin = "center top";
                content.style.transform = `scale(${next / tab.zoom})`;
            }

            // Debounce the actual re-render
            window.clearTimeout(pinchTimerRef.current);
            pinchTimerRef.current = window.setTimeout(() => {
                const content = contentRef.current;
                if (content) {
                    content.style.transform = "";
                }
                updatePdfZoom(tab.id, persistWheelZoom(next));
            }, PINCH_COMMIT_DELAY);
        }

        container.addEventListener("wheel", handleWheel, { passive: false });
        return () => {
            container.removeEventListener("wheel", handleWheel);
            window.clearTimeout(pinchTimerRef.current);
        };
    }, [tab.id, tab.zoom, updatePdfZoom, wheelZoomModifierRef]);

    useEffect(() => {
        function handleKeyDown(event: KeyboardEvent) {
            if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                event.preventDefault();
                goToPreviousPage();
            } else if (
                event.key === "ArrowRight" ||
                event.key === "ArrowDown"
            ) {
                event.preventDefault();
                goToNextPage();
            }
        }

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [goToNextPage, goToPreviousPage]);

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

    return (
        <div
            className="h-full flex flex-col"
            style={{ background: "var(--bg-primary)" }}
        >
            <div
                className="flex items-center gap-2 px-3 shrink-0"
                style={{
                    height: 36,
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
                    disabled={tab.zoom <= ZOOM_STEPS[0]}
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
                    {formatZoomPercentage(tab.zoom)}
                </span>
                <ToolbarButton
                    onClick={zoomIn}
                    disabled={tab.zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
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
                ref={containerRef}
                className={`flex-1 overflow-auto ${tab.viewMode === "continuous" ? "" : "flex justify-center"}`}
                style={{
                    padding: 24,
                    background:
                        "color-mix(in srgb, var(--bg-primary) 92%, #000)",
                    touchAction: "none",
                }}
            >
                {tab.viewMode === "continuous" ? (
                    <div
                        ref={contentRef}
                        className="w-full flex flex-col items-center"
                        style={{
                            gap: 20,
                            willChange: "transform",
                            filter: activeFilter.css,
                        }}
                    >
                        {Array.from({ length: numPages }, (_, index) => (
                            <PdfPageCanvas
                                key={`${tab.path}:${retryCount}:${index + 1}:${tab.zoom}`}
                                pdf={pdf}
                                pageNumber={index + 1}
                                zoom={tab.zoom}
                                onRenderError={setPdfError}
                                registerElement={registerPageElement}
                            />
                        ))}
                    </div>
                ) : (
                    <div
                        ref={contentRef}
                        className="w-full flex justify-center"
                        style={{
                            willChange: "transform",
                            filter: activeFilter.css,
                        }}
                    >
                        <PdfPageCanvas
                            key={`${tab.path}:${retryCount}:${tab.page}:${tab.zoom}`}
                            pdf={pdf}
                            pageNumber={tab.page}
                            zoom={tab.zoom}
                            onRenderError={setPdfError}
                        />
                    </div>
                )}
            </div>
        </div>
    );
}

function PdfPageCanvas({
    pdf,
    pageNumber,
    zoom,
    onRenderError,
    registerElement,
}: {
    pdf: pdfjsLib.PDFDocumentProxy;
    pageNumber: number;
    zoom: number;
    onRenderError: (message: string) => void;
    registerElement?: (
        pageNumber: number,
        element: HTMLDivElement | null,
    ) => void;
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
                    scale: zoom * PIXEL_RATIO,
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
    }, [onRenderError, pageNumber, pdf, zoom]);

    return (
        <div
            ref={(element) => registerElement?.(pageNumber, element)}
            className="flex justify-center w-full"
            data-page-number={pageNumber}
        >
            <div ref={pageShellRef} className="pdf-page-shell">
                <canvas
                    ref={canvasRef}
                    style={{
                        boxShadow: "0 2px 16px rgba(0,0,0,0.15)",
                        background: "#fff",
                        touchAction: "none",
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
