import { describe, expect, it } from "vitest";

import {
    deriveDisplayedTitle,
    getLeadingContentCollapseRanges,
    remapPositionPastLeadingContentCollapse,
} from "./noteTitleHelpers";

describe("deriveDisplayedTitle", () => {
    it("uses the leading H1 when there is no frontmatter title", () => {
        expect(
            deriveDisplayedTitle(
                null,
                "# Live Preview\n\nBody copy",
                "Fallback",
            ),
        ).toBe("Live Preview");
    });

    it("prefers frontmatter title over the leading H1", () => {
        expect(
            deriveDisplayedTitle(
                "---\ntitle: Frontmatter Title\n---\n",
                "# Body Heading\n\nBody copy",
                "Fallback",
            ),
        ).toBe("Frontmatter Title");
    });

    it("computes the leading frontmatter and H1 collapse ranges", () => {
        const body = "---\ntitle: Hello\n---\n\n# Hello\n\nBody text";

        expect(getLeadingContentCollapseRanges(body)).toEqual([
            { from: 0, to: 21 },
            { from: 22, to: 30 },
        ]);
    });

    it("remaps positions inside collapsed leading content to the next visible offset", () => {
        const body = "---\ntitle: Hello\n---\n\n# Hello\n\nBody text";

        expect(remapPositionPastLeadingContentCollapse(body, 5)).toBe(21);
        expect(remapPositionPastLeadingContentCollapse(body, 25)).toBe(30);
        expect(remapPositionPastLeadingContentCollapse(body, 35)).toBe(35);
    });
});
