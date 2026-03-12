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

vi.mock("pdfjs-dist/legacy/build/pdf", () => {
    class RenderingCancelledException extends Error {}

    return {
        GlobalWorkerOptions: { workerSrc: "" },
        RenderingCancelledException,
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
        const page = {
            getViewport: vi.fn(() => ({ width: 640, height: 800 })),
            render: vi.fn(() => renderTask),
        };
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
            screen.getByText("An unexpected error occurred while loading this PDF."),
        ).toBeInTheDocument();
    });

    it("toggles into continuous mode and renders every page", async () => {
        const user = userEvent.setup();
        const pdfDocument = {
            destroy: vi.fn(),
            getPage: vi.fn().mockImplementation(async () => ({
                getViewport: vi.fn(() => ({ width: 640, height: 800 })),
                render: vi.fn(() => createResolvedRenderTask()),
                cleanup: vi.fn(),
            })),
            numPages: 3,
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
            expect(container.querySelectorAll("canvas")).toHaveLength(3);
        });
    });
});
