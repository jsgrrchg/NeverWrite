import { describe, expect, it } from "vitest";
import {
    parseFrontmatterRaw,
    serializeFrontmatterRaw,
} from "./FrontmatterPanel";

describe("Frontmatter helpers", () => {
    it("parses inline and list values from raw frontmatter", () => {
        expect(
            parseFrontmatterRaw(`---
title: Roadmap
tags:
  - project
  - planning
date: 2026-03-08
---
`),
        ).toEqual([
            { key: "title", value: "Roadmap" },
            { key: "tags", value: ["project", "planning"] },
            { key: "date", value: "2026-03-08" },
        ]);
    });

    it("serializes frontmatter entries and omits empty values", () => {
        expect(
            serializeFrontmatterRaw([
                { key: "title", value: "Roadmap" },
                { key: "tags", value: ["project", "planning"] },
                { key: "empty", value: "" },
                { key: "none", value: null },
            ]),
        ).toBe(`---
title: Roadmap
tags:
  - project
  - planning
---
`);
    });
});
