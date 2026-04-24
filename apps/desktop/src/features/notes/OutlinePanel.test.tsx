import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderComponent } from "../../test/test-utils";
import { OutlinePanel } from "./OutlinePanel";

function getOutlineRow(title: string) {
    const row = screen
        .getByText(title)
        .closest('[data-outline-row="true"]');

    if (!row) {
        throw new Error(`Outline row not found for ${title}`);
    }

    return row;
}

describe("OutlinePanel", () => {
    it("renders indent guides for nested headings without affecting root headings", () => {
        renderComponent(
            <OutlinePanel
                content={[
                    "# Root",
                    "",
                    "## Child",
                    "",
                    "### Grandchild",
                ].join("\n")}
                onSelectHeading={vi.fn()}
            />,
        );

        const rootRow = getOutlineRow("Root");
        const childRow = getOutlineRow("Child");
        const grandchildRow = getOutlineRow("Grandchild");
        const grandchildGuides = grandchildRow.querySelector(
            '[data-outline-indent-guides="true"]',
        );

        expect(
            rootRow.querySelector('[data-outline-indent-guides="true"]'),
        ).toBeNull();
        expect(
            childRow.querySelectorAll('[data-outline-guide-line="true"]'),
        ).toHaveLength(1);
        expect(grandchildRow).toHaveStyle({ position: "relative" });
        expect(grandchildGuides).not.toBeNull();
        expect(grandchildGuides).toHaveStyle({
            position: "absolute",
            pointerEvents: "none",
        });
        expect(
            grandchildRow.querySelectorAll('[data-outline-guide-line="true"]'),
        ).toHaveLength(2);
    });
});
