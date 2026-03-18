import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfTabView } from "./PdfTabView";
import {
    createDeferred,
    renderComponent,
    setEditorTabs,
} from "../../test/test-utils";

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
                path: "/tmp/doc.pdf",
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
            numPages: 10,
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
                path: "/tmp/doc.pdf",
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

        await waitFor(() => {
            expect(screen.getByText("Continuous")).toBeInTheDocument();
            const canvases = container.querySelectorAll("canvas");
            const textLayers = container.querySelectorAll(".textLayer");
            expect(canvases.length).toBeGreaterThan(0);
            expect(canvases.length).toBeLessThan(pdfDocument.numPages);
            expect(textLayers.length).toBe(canvases.length);
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
                path: "/tmp/doc.pdf",
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

    it("exposes native pinch-zoom touch action on the PDF surface", async () => {
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
                path: "/tmp/doc.pdf",
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

        expect(scrollSurface?.style.touchAction).toBe("none");
        expect(canvas?.style.touchAction).toBe("none");
    });
});
