import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
});
