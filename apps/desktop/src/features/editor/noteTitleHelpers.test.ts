import { describe, expect, it } from "vitest";

import { deriveDisplayedTitle } from "./noteTitleHelpers";

describe("deriveDisplayedTitle", () => {
    it("uses the leading H1 when there is no frontmatter title", () => {
        expect(
            deriveDisplayedTitle(null, "# Live Preview\n\nBody copy", "Fallback"),
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
});
