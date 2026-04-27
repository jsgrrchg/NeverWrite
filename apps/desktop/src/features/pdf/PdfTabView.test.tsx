import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfTabView } from "./PdfTabView";
import {
    createDeferred,
    renderComponent,
    setEditorTabs,
    setVaultEntries,
} from "../../test/test-utils";
import { useEditorStore } from "../../app/store/editorStore";
import { useSettingsStore } from "../../app/store/settingsStore";

const { getDocumentMock } = vi.hoisted(() => ({
    getDocumentMock: vi.fn(),
}));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => {
    class RenderingCancelledException extends Error {}
    class TextLayer {
        container: HTMLElement;

        constructor({ container }: { container: HTMLElement }) {
            this.container = container;
        }

        render() {
            const span = document.createElement("span");
            span.textContent = "PDF text";
            this.container.append(span);
            return Promise.resolve();
        }

        cancel() {}
    }

    return {
        GlobalWorkerOptions: { workerSrc: "" },
        RenderingCancelledException,
        TextLayer,
        VerbosityLevel: { ERRORS: 0 },
        getDocument: getDocumentMock,
    };
});

beforeAll(() => {
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
        configurable: true,
        value: vi.fn(() => ({ clearRect: vi.fn() })),
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
        configurable: true,
        value(this: HTMLElement, options?: ScrollToOptions | number) {
            if (typeof options === "number") {
                this.scrollTop = options;
                return;
            }
            this.scrollTop = options?.top ?? this.scrollTop;
            this.scrollLeft = options?.left ?? this.scrollLeft;
        },
    });
});

function createResolvedRenderTask() {
    return {
        cancel: vi.fn(),
        promise: Promise.resolve(),
    };
}

function createMockPage(renderTask = createResolvedRenderTask()) {
    return {
        getViewport: vi.fn(({ scale = 1 }) => ({
            width: 640 * scale,
            height: 800 * scale,
            scale,
        })),
        render: vi.fn(() => renderTask),
        streamTextContent: vi.fn(() => ({})),
        cleanup: vi.fn(),
        userUnit: 1,
    };
}

describe("PdfTabView", () => {
    beforeEach(() => {
        getDocumentMock.mockReset();
        vi.useRealTimers();
        setVaultEntries([], "/vault");
    });

    it("shows an error state when page rendering fails", async () => {
        const renderDeferred = createDeferred<void>();
        const renderTask = {
            cancel: vi.fn(),
            promise: renderDeferred.promise,
        };
        const page = createMockPage(renderTask);
        const pdfDocument = {
            destroy: vi.fn(),
            getPage: vi.fn().mockResolvedValue(page),
            numPages: 8,
        };

        getDocumentMock.mockReturnValue({
            destroy: vi.fn(),
            promise: Promise.resolve(pdfDocument),
        });

        setEditorTabs([
            {
                kind: "pdf",
                id: "pdf-tab",
                entryId: "entry-1",
                title: "Doc",
                path: "/vault/docs/doc.pdf",
                page: 1,
                zoom: 1,
                viewMode: "single",
            },
        ]);

        renderComponent(<PdfTabView />);
        await waitFor(() => {
            expect(page.render).toHaveBeenCalled();
        });
        renderDeferred.reject(new Error("render boom"));

        await waitFor(() => {
            expect(screen.getByText("Failed to load PDF")).toBeInTheDocument();
        });

        expect(
            screen.getByText(
                "An unexpected error occurred while loading this PDF.",
            ),
        ).toBeInTheDocument();
    });

    it("toggles into continuous mode and only renders the visible pages", async () => {
        const user = userEvent.setup();
        const pdfDocument = {
            destroy: vi.fn(),
            getPage: vi.fn().mockImplementation(async () => createMockPage()),
            numPages: 30,
        };

        getDocumentMock.mockReturnValue({
            destroy: vi.fn(),
            promise: Promise.resolve(pdfDocument),
        });

        setEditorTabs([
            {
                kind: "pdf",
                id: "pdf-tab",
                entryId: "entry-1",
                title: "Doc",
                path: "/vault/docs/doc.pdf",
                page: 1,
                zoom: 1,
                viewMode: "single",
            },
        ]);

        const { container } = renderComponent(<PdfTabView />);

        await waitFor(() => {
            expect(screen.getByText("Single Page")).toBeInTheDocument();
        });

        await user.click(screen.getByTitle("Switch to continuous view"));

        const scrollSurface = container.querySelector(
            "div[class*='overflow-auto']",
        ) as HTMLDivElement | null;

        expect(scrollSurface).toBeTruthy();

        await waitFor(() => {
            expect(screen.getByText("Continuous")).toBeInTheDocument();
            const canvases = container.querySelectorAll("canvas");
            const textLayers = container.querySelectorAll(".textLayer");
            expect(canvases.length).toBeGreaterThan(0);
            expect(canvases.length).toBeLessThan(pdfDocument.numPages);
            expect(canvases.length).toBeLessThanOrEqual(15);
            expect(textLayers.length).toBe(canvases.length);
            expect(
                container.querySelector('[data-page-number="1"]'),
            ).toBeTruthy();
        });

        Object.defineProperty(scrollSurface, "scrollTop", {
            configurable: true,
            writable: true,
            value: 14000,
        });

        fireEvent.scroll(scrollSurface!);

        await waitFor(() => {
            expect(
                container.querySelector('[data-page-number="18"]'),
            ).toBeTruthy();
            expect(
                container.querySelector('[data-page-number="1"]'),
            ).toBeFalsy();
        });
    });

    it("restores a persisted continuous scroll position when the PDF view remounts", async () => {
        const pdfDocument = {
            destroy: vi.fn(),
            getPage: vi.fn().mockImplementation(async () => createMockPage()),
            numPages: 30,
        };

        getDocumentMock.mockReturnValue({
            destroy: vi.fn(),
            promise: Promise.resolve(pdfDocument),
        });

        setEditorTabs([
            {
                kind: "pdf",
                id: "pdf-tab",
                entryId: "entry-1",
                title: "Doc",
                path: "/vault/docs/doc.pdf",
                page: 18,
                zoom: 1,
                viewMode: "continuous",
                scrollTop: 14000,
                scrollLeft: 320,
            },
        ]);

        const { container } = renderComponent(<PdfTabView />);

        await screen.findByText("Continuous");

        const scrollSurface = container.querySelector(
            "div[class*='overflow-auto']",
        ) as HTMLDivElement | null;

        expect(scrollSurface).toBeTruthy();

        await waitFor(() => {
            expect(scrollSurface!.scrollTop).toBe(14000);
            expect(scrollSurface!.scrollLeft).toBe(320);
            expect(
                container.querySelector('[data-page-number="18"]'),
            ).toBeTruthy();
            expect(
                container.querySelector('[data-page-number="1"]'),
            ).toBeFalsy();
        });
    });

    it("does not overwrite the saved page with page 1 while restoring continuous view", async () => {
        const pdfDocument = {
            destroy: vi.fn(),
            getPage: vi.fn().mockImplementation(async () => createMockPage()),
            numPages: 30,
        };

        getDocumentMock.mockReturnValue({
            destroy: vi.fn(),
            promise: Promise.resolve(pdfDocument),
        });

        setEditorTabs([
            {
                kind: "pdf",
                id: "pdf-tab",
                entryId: "entry-1",
                title: "Doc",
                path: "/vault/docs/doc.pdf",
                page: 18,
                zoom: 1,
                viewMode: "continuous",
                scrollTop: 0,
            },
        ]);

        renderComponent(<PdfTabView />);

        await waitFor(() => {
            expect(
                useEditorStore
                    .getState()
                    .tabs.find((tab) => tab.id === "pdf-tab"),
            ).toMatchObject({
                kind: "pdf",
                page: 18,
            });
        });

        await new Promise((resolve) => window.setTimeout(resolve, 0));

        expect(
            useEditorStore.getState().tabs.find((tab) => tab.id === "pdf-tab"),
        ).toMatchObject({
            kind: "pdf",
            page: 18,
        });
    });

    it("persists continuous scroll before the next animation frame", async () => {
        const pdfDocument = {
            destroy: vi.fn(),
            getPage: vi.fn().mockImplementation(async () => createMockPage()),
            numPages: 30,
        };

        getDocumentMock.mockReturnValue({
            destroy: vi.fn(),
            promise: Promise.resolve(pdfDocument),
        });

        setEditorTabs([
            {
                kind: "pdf",
                id: "pdf-tab",
                entryId: "entry-1",
                title: "Doc",
                path: "/vault/docs/doc.pdf",
                page: 1,
                zoom: 1,
                viewMode: "continuous",
            },
        ]);

        const { container } = renderComponent(<PdfTabView />);

        await waitFor(() => {
            expect(
                container.querySelector('[data-page-number="1"]'),
            ).toBeTruthy();
        });

        const scrollSurface = container.querySelector(
            "div[class*='overflow-auto']",
        ) as HTMLDivElement | null;

        expect(scrollSurface).toBeTruthy();

        await new Promise((resolve) => window.setTimeout(resolve, 0));

        scrollSurface!.scrollTop = 14000;
        scrollSurface!.scrollLeft = 420;
        fireEvent.scroll(scrollSurface!);

        expect(
            useEditorStore.getState().tabs.find((tab) => tab.id === "pdf-tab"),
        ).toMatchObject({
            kind: "pdf",
            scrollTop: 14000,
            scrollLeft: 420,
        });
    });

    it("renders a selectable text layer over the PDF canvas", async () => {
        const pdfDocument = {
            destroy: vi.fn(),
            getPage: vi.fn().mockImplementation(async () => createMockPage()),
            numPages: 1,
        };

        getDocumentMock.mockReturnValue({
            destroy: vi.fn(),
            promise: Promise.resolve(pdfDocument),
        });

        setEditorTabs([
            {
                kind: "pdf",
                id: "pdf-tab",
                entryId: "entry-1",
                title: "Doc",
                path: "/vault/docs/doc.pdf",
                page: 1,
                zoom: 1,
                viewMode: "single",
            },
        ]);

        const { container } = renderComponent(<PdfTabView />);

        await waitFor(() => {
            const textLayer = container.querySelector(".textLayer");
            expect(textLayer).toBeInTheDocument();
            expect(textLayer).toHaveAttribute("data-selectable", "true");
            expect(textLayer?.querySelector("span")).toBeInTheDocument();
        });
    });

    it("sizes the single-page PDF content to the rendered page width for horizontal scroll", async () => {
        const pdfDocument = {
            destroy: vi.fn(),
            getPage: vi.fn().mockImplementation(async () => createMockPage()),
            numPages: 1,
        };

        getDocumentMock.mockReturnValue({
            destroy: vi.fn(),
            promise: Promise.resolve(pdfDocument),
        });

        setEditorTabs([
            {
                kind: "pdf",
                id: "pdf-tab",
                entryId: "entry-1",
                title: "Doc",
                path: "/vault/docs/doc.pdf",
                page: 1,
                zoom: 2,
                viewMode: "single",
            },
        ]);

        const { container } = renderComponent(<PdfTabView />);

        await waitFor(() => {
            const content = container.querySelector(
                '[data-pdf-content="single"]',
            ) as HTMLDivElement | null;
            expect(content).toBeTruthy();
            expect(content!.style.width).toBe("1280px");
            expect(content!.style.minWidth).toBe("1280px");
        });
    });

    it("remembers the selected PDF filter after switching away and back", async () => {
        const user = userEvent.setup();
        const pdfDocument = {
            destroy: vi.fn(),
            getPage: vi.fn().mockImplementation(async () => createMockPage()),
            numPages: 1,
        };

        getDocumentMock.mockReturnValue({
            destroy: vi.fn(),
            promise: Promise.resolve(pdfDocument),
        });

        setEditorTabs([
            {
                kind: "pdf",
                id: "pdf-tab",
                entryId: "entry-1",
                title: "Doc",
                path: "/vault/docs/doc.pdf",
                page: 1,
                zoom: 1,
                viewMode: "single",
            },
            {
                kind: "note",
                id: "note-tab",
                noteId: "note-1",
                title: "Note",
                content: "A note",
            },
        ]);

        renderComponent(<PdfTabView />);

        await screen.findByTitle("Filter: Normal");
        await user.click(screen.getByTitle("Filter: Normal"));
        await user.click(screen.getByTitle("Filter: Dark"));

        expect(useSettingsStore.getState().pdfFilter).toBe("sepia");
        expect(screen.getByTitle("Filter: Sepia")).toBeInTheDocument();

        act(() => useEditorStore.getState().switchTab("note-tab"));
        expect(screen.getByText("No PDF tab active")).toBeInTheDocument();

        act(() => useEditorStore.getState().switchTab("pdf-tab"));

        expect(await screen.findByTitle("Filter: Sepia")).toBeInTheDocument();
    });

    it("shows PDF context menu actions for copy and select all", async () => {
        const user = userEvent.setup();
        const pdfDocument = {
            destroy: vi.fn(),
            getPage: vi.fn().mockImplementation(async () => createMockPage()),
            numPages: 1,
        };

        getDocumentMock.mockReturnValue({
            destroy: vi.fn(),
            promise: Promise.resolve(pdfDocument),
        });

        setEditorTabs([
            {
                kind: "pdf",
                id: "pdf-tab",
                entryId: "entry-1",
                title: "Doc",
                path: "/vault/docs/doc.pdf",
                page: 1,
                zoom: 1,
                viewMode: "single",
            },
        ]);

        const { container } = renderComponent(<PdfTabView />);

        const getTextLayer = async () => {
            await waitFor(() => {
                expect(
                    container.querySelector(".textLayer"),
                ).toBeInTheDocument();
            });
            return container.querySelector(".textLayer") as HTMLDivElement;
        };

        fireEvent.contextMenu(await getTextLayer(), {
            clientX: 24,
            clientY: 36,
        });

        expect(
            await screen.findByRole("button", { name: "Copy" }),
        ).toBeDisabled();
        expect(
            screen.getByRole("button", { name: "Select All" }),
        ).toBeEnabled();

        await user.click(screen.getByRole("button", { name: "Select All" }));

        expect(window.getSelection()?.toString()).toContain("PDF text");

        fireEvent.contextMenu(await getTextLayer(), {
            clientX: 24,
            clientY: 36,
        });

        expect(screen.getByRole("button", { name: "Copy" })).toBeEnabled();
    });

    it("blocks pinch-style wheel zoom and keeps toolbar controls as the only zoom path", async () => {
        const user = userEvent.setup();
        const pdfDocument = {
            destroy: vi.fn(),
            getPage: vi.fn().mockImplementation(async () => createMockPage()),
            numPages: 1,
        };

        getDocumentMock.mockReturnValue({
            destroy: vi.fn(),
            promise: Promise.resolve(pdfDocument),
        });

        setEditorTabs([
            {
                kind: "pdf",
                id: "pdf-tab",
                entryId: "entry-1",
                title: "Doc",
                path: "/vault/docs/doc.pdf",
                page: 1,
                zoom: 1,
                viewMode: "single",
            },
        ]);

        const { container } = renderComponent(<PdfTabView />);

        await waitFor(() => {
            expect(container.querySelector("canvas")).toBeInTheDocument();
            expect(screen.getByText("100%")).toBeInTheDocument();
        });

        const scrollSurface = container.querySelector(
            "div[class*='overflow-auto']",
        ) as HTMLDivElement | null;

        expect(scrollSurface).toBeTruthy();

        const pinchWheelEvent = new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
            deltaY: -100,
        });

        scrollSurface!.dispatchEvent(pinchWheelEvent);

        expect(pinchWheelEvent.defaultPrevented).toBe(true);
        expect(screen.getByText("100%")).toBeInTheDocument();

        await user.click(screen.getByTitle("Zoom in"));

        expect(screen.getByText("125%")).toBeInTheDocument();
    });

    it("maps shift-wheel input to horizontal PDF panning", async () => {
        const pdfDocument = {
            destroy: vi.fn(),
            getPage: vi.fn().mockImplementation(async () => createMockPage()),
            numPages: 1,
        };

        getDocumentMock.mockReturnValue({
            destroy: vi.fn(),
            promise: Promise.resolve(pdfDocument),
        });

        setEditorTabs([
            {
                kind: "pdf",
                id: "pdf-tab",
                entryId: "entry-1",
                title: "Doc",
                path: "/vault/docs/doc.pdf",
                page: 1,
                zoom: 2,
                viewMode: "single",
            },
        ]);

        const { container } = renderComponent(<PdfTabView />);

        await waitFor(() => {
            expect(container.querySelector("canvas")).toBeInTheDocument();
        });
        await new Promise((resolve) => window.setTimeout(resolve, 0));

        const scrollSurface = container.querySelector(
            "div[class*='overflow-auto']",
        ) as HTMLDivElement | null;

        expect(scrollSurface).toBeTruthy();

        const wheelEvent = new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            shiftKey: true,
            deltaY: 180,
        });

        act(() => {
            scrollSurface!.dispatchEvent(wheelEvent);
        });

        expect(wheelEvent.defaultPrevented).toBe(true);
        expect(scrollSurface!.scrollLeft).toBe(180);
        expect(
            useEditorStore.getState().tabs.find((tab) => tab.id === "pdf-tab"),
        ).toMatchObject({
            kind: "pdf",
            scrollLeft: 180,
        });
    });

    it("supports space-drag panning on the PDF surface", async () => {
        const pdfDocument = {
            destroy: vi.fn(),
            getPage: vi.fn().mockImplementation(async () => createMockPage()),
            numPages: 1,
        };

        getDocumentMock.mockReturnValue({
            destroy: vi.fn(),
            promise: Promise.resolve(pdfDocument),
        });

        setEditorTabs([
            {
                kind: "pdf",
                id: "pdf-tab",
                entryId: "entry-1",
                title: "Doc",
                path: "/vault/docs/doc.pdf",
                page: 1,
                zoom: 2,
                viewMode: "single",
            },
        ]);

        const { container } = renderComponent(<PdfTabView />);

        await waitFor(() => {
            expect(container.querySelector("canvas")).toBeInTheDocument();
        });
        await new Promise((resolve) => window.setTimeout(resolve, 0));

        const scrollSurface = container.querySelector(
            "div[class*='overflow-auto']",
        ) as HTMLDivElement | null;

        expect(scrollSurface).toBeTruthy();

        fireEvent.keyDown(window, { key: " ", code: "Space" });
        fireEvent.mouseDown(scrollSurface!, {
            button: 0,
            buttons: 1,
            clientX: 200,
            clientY: 200,
        });
        fireEvent.mouseMove(scrollSurface!, {
            buttons: 1,
            clientX: 120,
            clientY: 150,
        });
        fireEvent.mouseUp(scrollSurface!);
        fireEvent.keyUp(window, { key: " ", code: "Space" });

        expect(scrollSurface!.scrollLeft).toBe(80);
        expect(scrollSurface!.scrollTop).toBe(50);
        expect(
            useEditorStore.getState().tabs.find((tab) => tab.id === "pdf-tab"),
        ).toMatchObject({
            kind: "pdf",
            scrollLeft: 80,
            scrollTop: 50,
        });
    });

    it("preserves pan gestures while suppressing gesture-based pinch zoom on the PDF surface", async () => {
        const pdfDocument = {
            destroy: vi.fn(),
            getPage: vi.fn().mockImplementation(async () => createMockPage()),
            numPages: 1,
        };

        getDocumentMock.mockReturnValue({
            destroy: vi.fn(),
            promise: Promise.resolve(pdfDocument),
        });

        setEditorTabs([
            {
                kind: "pdf",
                id: "pdf-tab",
                entryId: "entry-1",
                title: "Doc",
                path: "/vault/docs/doc.pdf",
                page: 1,
                zoom: 1,
                viewMode: "single",
            },
        ]);

        const { container } = renderComponent(<PdfTabView />);

        await waitFor(() => {
            expect(container.querySelector("canvas")).toBeInTheDocument();
        });

        const scrollSurface = container.querySelector(
            "div[class*='overflow-auto']",
        ) as HTMLDivElement | null;
        const canvas = container.querySelector(
            "canvas",
        ) as HTMLCanvasElement | null;

        expect(scrollSurface?.style.touchAction).toBe("pan-x pan-y");
        expect(canvas?.style.touchAction).not.toBe("none");

        const panWheelEvent = new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            deltaY: 120,
        });
        scrollSurface!.dispatchEvent(panWheelEvent);

        const pinchGestureEvent = new Event("gesturestart", {
            bubbles: true,
            cancelable: true,
        });
        scrollSurface!.dispatchEvent(pinchGestureEvent);

        expect(panWheelEvent.defaultPrevented).toBe(false);
        expect(pinchGestureEvent.defaultPrevented).toBe(true);
    });
});
