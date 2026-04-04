import { type EditorView } from "@codemirror/view";

export interface GeometryRefreshUpdate {
    geometryChanged: boolean;
    heightChanged: boolean;
    viewportChanged: boolean;
}

export interface EditorGeometryRefreshControllerOptions {
    view: EditorView;
    readKey: (view: EditorView) => string;
    onGeometryChange: () => void;
    observeDocumentRoot?: boolean;
    observeBody?: boolean;
}

export class EditorGeometryRefreshController {
    private readonly view: EditorView;
    private readonly readKey: (view: EditorView) => string;
    private readonly onGeometryChange: () => void;
    private readonly observeDocumentRoot: boolean;
    private readonly observeBody: boolean;
    private resizeObserver: ResizeObserver | null = null;
    private mutationObserver: MutationObserver | null = null;
    private readonly fontSet: FontFaceSet | null =
        typeof document !== "undefined" && "fonts" in document
            ? (document.fonts as FontFaceSet)
            : null;
    private destroyed = false;
    private refreshFrame: number | null = null;
    private refreshScheduled = false;
    private lastGeometryKey: string;
    private readonly handleWindowResize = () => {
        this.scheduleRefresh();
    };
    private readonly handleWindowFocus = () => {
        this.scheduleRefresh();
    };
    private readonly handleVisibilityChange = () => {
        if (document.visibilityState === "visible") {
            this.scheduleRefresh();
        }
    };
    private readonly handleViewportResize = () => {
        this.scheduleRefresh();
    };
    private readonly handleFontEvent = () => {
        this.scheduleRefresh();
    };

    constructor(options: EditorGeometryRefreshControllerOptions) {
        this.view = options.view;
        this.readKey = options.readKey;
        this.onGeometryChange = options.onGeometryChange;
        this.observeDocumentRoot = options.observeDocumentRoot ?? false;
        this.observeBody = options.observeBody ?? false;
        this.lastGeometryKey = this.readKey(this.view);

        if (typeof ResizeObserver !== "undefined") {
            this.resizeObserver = new ResizeObserver(() => {
                this.scheduleRefresh();
            });
            this.resizeObserver.observe(this.view.dom);
            this.resizeObserver.observe(this.view.scrollDOM);
            this.resizeObserver.observe(this.view.contentDOM);
        }

        if (typeof MutationObserver !== "undefined") {
            this.mutationObserver = new MutationObserver(() => {
                this.scheduleRefresh();
            });
            this.mutationObserver.observe(this.view.dom, {
                attributes: true,
                attributeFilter: ["class", "style"],
            });
            this.mutationObserver.observe(this.view.scrollDOM, {
                attributes: true,
                attributeFilter: ["class", "style"],
            });
            this.mutationObserver.observe(this.view.contentDOM, {
                attributes: true,
                attributeFilter: ["class", "style"],
            });
            if (this.observeDocumentRoot) {
                this.mutationObserver.observe(document.documentElement, {
                    attributes: true,
                    attributeFilter: ["class", "style"],
                });
            }
            if (this.observeBody && document.body) {
                this.mutationObserver.observe(document.body, {
                    attributes: true,
                    attributeFilter: ["class", "style"],
                });
            }
        }

        if (this.fontSet) {
            this.fontSet.addEventListener(
                "loadingdone",
                this.handleFontEvent as EventListener,
            );
            this.fontSet.ready
                .then(() => {
                    if (!this.destroyed && this.view.dom.isConnected) {
                        this.scheduleRefresh();
                    }
                })
                .catch(() => {
                    // Keep the fallback listeners active if font loading
                    // signals aren't available in the current environment.
                });
        }

        window.addEventListener("resize", this.handleWindowResize);
        window.addEventListener("focus", this.handleWindowFocus);
        document.addEventListener(
            "visibilitychange",
            this.handleVisibilityChange,
        );
        window.visualViewport?.addEventListener(
            "resize",
            this.handleViewportResize,
        );
    }

    update(update: GeometryRefreshUpdate) {
        if (
            update.geometryChanged ||
            update.heightChanged ||
            update.viewportChanged
        ) {
            this.scheduleRefresh();
        }
    }

    destroy() {
        this.destroyed = true;
        if (this.refreshFrame !== null) {
            cancelAnimationFrame(this.refreshFrame);
            this.refreshFrame = null;
        }
        this.refreshScheduled = false;
        this.resizeObserver?.disconnect();
        this.mutationObserver?.disconnect();
        if (this.fontSet) {
            this.fontSet.removeEventListener(
                "loadingdone",
                this.handleFontEvent as EventListener,
            );
        }
        window.removeEventListener("resize", this.handleWindowResize);
        window.removeEventListener("focus", this.handleWindowFocus);
        document.removeEventListener(
            "visibilitychange",
            this.handleVisibilityChange,
        );
        window.visualViewport?.removeEventListener(
            "resize",
            this.handleViewportResize,
        );
    }

    private scheduleRefresh() {
        if (this.destroyed || this.refreshScheduled) {
            return;
        }

        this.refreshScheduled = true;
        this.refreshFrame = requestAnimationFrame(() => {
            this.refreshFrame = null;
            this.refreshScheduled = false;

            if (this.destroyed || !this.view.dom.isConnected) {
                return;
            }

            const nextGeometryKey = this.readKey(this.view);
            if (nextGeometryKey === this.lastGeometryKey) {
                return;
            }

            this.lastGeometryKey = nextGeometryKey;
            this.onGeometryChange();
        });
    }
}
