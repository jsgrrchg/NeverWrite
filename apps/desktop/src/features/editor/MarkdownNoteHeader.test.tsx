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

    return document.querySelector(
        '[data-editor-note-header="true"]',
    ) as HTMLElement | null;
}

describe("MarkdownNoteHeader", () => {
    it("keeps the centered reading layout when line wrapping is enabled", () => {
        const header = renderHeader(true);
        expect(header).not.toBeNull();
        expect(header).toHaveAttribute("data-line-wrapping", "true");
        expect(header).toHaveStyle({
            maxWidth: "var(--editor-content-width)",
            margin: "0 auto",
            padding: "40px var(--editor-horizontal-inset) 0",
        });
        expect(screen.getByDisplayValue("Example note")).toBeInTheDocument();
    });

    it("switches to a left-aligned layout when line wrapping is disabled", () => {
        const header = renderHeader(false);
        expect(header).not.toBeNull();
        expect(header).toHaveAttribute("data-line-wrapping", "false");
        expect(header).toHaveStyle({
            maxWidth: "none",
            margin: "0px",
            padding: "40px var(--editor-horizontal-inset) 0",
        });
    });
});
