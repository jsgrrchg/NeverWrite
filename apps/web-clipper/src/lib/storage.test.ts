import { describe, expect, it } from "vitest";
import {
    createDefaultClipperSettings,
    normalizeClipperSettings,
} from "./storage";

describe("clipper storage", () => {
    it("uses the content-only default template", () => {
        expect(createDefaultClipperSettings().defaultTemplate).toBe(
            "{{content}}",
        );
    });

    it("migrates the legacy default template that duplicated the title", () => {
        const settings = normalizeClipperSettings({
            defaultTemplate: "# {{title}}\n\n{{content}}",
        });

        expect(settings.defaultTemplate).toBe("{{content}}");
    });
});
