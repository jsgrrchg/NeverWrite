import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownNoteHeader } from "./MarkdownNoteHeader";

function renderHeader(lineWrapping: boolean) {
    render(
        <MarkdownNoteHeader
            editableTitle="Example note"
            lineWrapping={lineWrapping}
            onTitleChange={() => {}}
            titleInputRef={{ current: null }}
            locationParent="Notes"
            frontmatterRaw={null}
            onFrontmatterChange={() => {}}
            propertiesExpanded={false}
            onToggleProperties={vi.fn()}
            onSearchClick={vi.fn()}
        />,
    );

    return {
        outer: document.querySelector(
            '[data-editor-note-header="true"]',
        ) as HTMLElement | null,
        inner: document.querySelector(
            '[data-editor-note-header-inner="true"]',
        ) as HTMLElement | null,
    };
}

describe("MarkdownNoteHeader", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("keeps the centered reading layout when line wrapping is enabled", () => {
        const { outer, inner } = renderHeader(true);
        expect(outer).not.toBeNull();
        expect(inner).not.toBeNull();
        expect(outer).toHaveAttribute("data-line-wrapping", "true");
        expect(outer).toHaveStyle({
            width: "100%",
            padding: "40px var(--editor-horizontal-inset) 0",
        });
        expect(inner).toHaveStyle({
            width: "min(100%, var(--editor-content-width))",
            maxWidth: "var(--editor-content-width)",
            margin: "0 auto",
            minWidth: "0",
        });
        expect(screen.getByDisplayValue("Example note")).toBeInTheDocument();
    });

    it("switches to a left-aligned layout when line wrapping is disabled", () => {
        const { outer, inner } = renderHeader(false);
        expect(outer).not.toBeNull();
        expect(inner).not.toBeNull();
        expect(outer).toHaveAttribute("data-line-wrapping", "false");
        expect(outer).toHaveStyle({
            width: "100%",
            padding: "40px var(--editor-horizontal-inset) 0",
        });
        expect(inner).toHaveStyle({
            width: "100%",
            maxWidth: "none",
            margin: "0px",
            minWidth: "0",
        });
    });

    it("allows the secondary toolbar actions to wrap instead of collapsing the header width", () => {
        renderHeader(true);

        const propertiesButton = screen.getByRole("button", {
            name: "Properties",
        });
        const toolbar = propertiesButton.parentElement;

        expect(toolbar).not.toBeNull();
        expect(toolbar).toHaveStyle({
            display: "flex",
            flexWrap: "wrap",
            minWidth: "0",
        });
    });

    it("recalculates the title height when the available width changes", async () => {
        let resizeCallback: ResizeObserverCallback | null = null;
        const originalResizeObserver = globalThis.ResizeObserver;
        const originalFonts = document.fonts;
        const originalScrollHeight = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            "scrollHeight",
        );
        let currentScrollHeight = 78;

        class MockResizeObserver {
            constructor(callback: ResizeObserverCallback) {
                resizeCallback = callback;
            }

            observe() {}
            unobserve() {}
            disconnect() {}
        }

        try {
            Object.defineProperty(globalThis, "ResizeObserver", {
                configurable: true,
                writable: true,
                value: MockResizeObserver,
            });
            Object.defineProperty(document, "fonts", {
                configurable: true,
                value: {
                    ready: Promise.resolve(),
                },
            });
            Object.defineProperty(
                HTMLTextAreaElement.prototype,
                "scrollHeight",
                {
                    configurable: true,
                    get: () => currentScrollHeight,
                },
            );

            renderHeader(true);

            const titleInput = screen.getByDisplayValue(
                "Example note",
            ) as HTMLTextAreaElement;

            await waitFor(() => {
                expect(titleInput.style.height).toBe("78px");
            });

            currentScrollHeight = 42;

            await act(async () => {
                resizeCallback?.(
                    [
                        {
                            contentRect: {
                                width: 640,
                                height: 0,
                                x: 0,
                                y: 0,
                                top: 0,
                                right: 640,
                                bottom: 0,
                                left: 0,
                                toJSON: () => ({}),
                            },
                        } as ResizeObserverEntry,
                    ],
                    {} as ResizeObserver,
                );
                await new Promise((resolve) => setTimeout(resolve, 0));
            });

            expect(titleInput.style.height).toBe("42px");
        } finally {
            Object.defineProperty(globalThis, "ResizeObserver", {
                configurable: true,
                writable: true,
                value: originalResizeObserver,
            });
            Object.defineProperty(document, "fonts", {
                configurable: true,
                value: originalFonts,
            });
            if (originalScrollHeight) {
                Object.defineProperty(
                    HTMLTextAreaElement.prototype,
                    "scrollHeight",
                    originalScrollHeight,
                );
            } else {
                delete (
                    HTMLTextAreaElement.prototype as unknown as Record<
                        string,
                        unknown
                    >
                ).scrollHeight;
            }
        }
    });
});
