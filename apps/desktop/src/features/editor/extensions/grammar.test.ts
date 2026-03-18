import { describe, expect, it } from "vitest";
import { buildGrammarCacheKey } from "./grammar";

describe("grammar extension cache key", () => {
    const version = "doc:abc123";

    it("changes when the language changes", () => {
        expect(
            buildGrammarCacheKey("note-1", version, "en-US", ""),
        ).not.toEqual(buildGrammarCacheKey("note-1", version, "es-ES", ""));
    });

    it("changes when the server changes", () => {
        expect(
            buildGrammarCacheKey("note-1", version, "en-US", ""),
        ).not.toEqual(
            buildGrammarCacheKey(
                "note-1",
                version,
                "en-US",
                "http://localhost:8081",
            ),
        );
    });

    it("changes when the document version changes", () => {
        expect(
            buildGrammarCacheKey("note-1", "doc:a", "en-US", ""),
        ).not.toEqual(buildGrammarCacheKey("note-1", "doc:b", "en-US", ""));
    });

    it("treats blank server urls as the default server bucket", () => {
        expect(buildGrammarCacheKey("note-1", version, "en-US", "")).toEqual(
            buildGrammarCacheKey("note-1", version, "en-US", "   "),
        );
    });
});
