import { describe, expect, it } from "vitest";

import {
    getThemedCatppuccinIconBody,
    resolveFirstAvailableCatppuccinIcon,
} from "./catppuccin-icons";

describe("getThemedCatppuccinIconBody", () => {
    it("maps Catppuccin hex colors to theme-aware CSS variables", () => {
        expect(
            getThemedCatppuccinIconBody(
                '<path stroke="#cad3f5" fill="#8aadf4" />',
            ),
        ).toBe(
            '<path stroke="var(--catppuccin-icon-text)" fill="var(--catppuccin-icon-blue)" />',
        );
    });

    it("leaves unknown colors unchanged", () => {
        expect(getThemedCatppuccinIconBody('<path stroke="#123456" />')).toBe(
            '<path stroke="#123456" />',
        );
    });
});

describe("resolveFirstAvailableCatppuccinIcon", () => {
    it("uses the first icon that exists in the local Catppuccin set", () => {
        expect(
            resolveFirstAvailableCatppuccinIcon([
                "neverwrite-missing-icon",
                "drawio",
                "image",
            ]),
        ).toBe("drawio");
    });
});
