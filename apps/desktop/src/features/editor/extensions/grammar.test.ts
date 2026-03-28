import { beforeEach, describe, expect, it } from "vitest";
import {
    buildGrammarCacheKey,
    getGrammarRateLimitedServerCountForTests,
    isGrammarServerRateLimited,
    markGrammarServerRateLimited,
    resetActiveGrammarDiagnosticsForTests,
    resetGrammarRateLimitsForTests,
    findGrammarDiagnosticsAt,
    setActiveGrammarDiagnosticsForTests,
    setCurrentActiveGrammarDiagnosticsNoteForTests,
} from "./grammar";

describe("grammar extension cache key", () => {
    const version = "doc:abc123";

    beforeEach(() => {
        resetGrammarRateLimitsForTests();
        resetActiveGrammarDiagnosticsForTests();
    });

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

    it("drops expired grammar rate-limit entries from the backing map", () => {
        const firstServer = "https://a.test";
        const secondServer = "https://b.test";

        markGrammarServerRateLimited(firstServer, 0);
        markGrammarServerRateLimited(secondServer, 15_000);

        expect(getGrammarRateLimitedServerCountForTests(15_000)).toBe(2);
        expect(isGrammarServerRateLimited(firstServer, 30_001)).toBe(false);
        expect(getGrammarRateLimitedServerCountForTests(30_001)).toBe(1);
        expect(isGrammarServerRateLimited(secondServer, 45_001)).toBe(false);
        expect(getGrammarRateLimitedServerCountForTests(45_001)).toBe(0);
    });

    it("treats expired servers as immediately reusable", () => {
        const server = "https://a.test";

        markGrammarServerRateLimited(server, 0);

        expect(isGrammarServerRateLimited(server, 29_999)).toBe(true);
        expect(isGrammarServerRateLimited(server, 30_001)).toBe(false);
    });

    it("drops diagnostics from previous notes when the active grammar note changes", () => {
        setCurrentActiveGrammarDiagnosticsNoteForTests("note-a");
        setActiveGrammarDiagnosticsForTests("note-a", [
            {
                from: 0,
                to: 4,
                message: "Issue A",
                replacements: [],
                severity: "warning",
            },
        ]);

        expect(findGrammarDiagnosticsAt("note-a", 2)).toHaveLength(1);

        setCurrentActiveGrammarDiagnosticsNoteForTests("note-b");

        expect(findGrammarDiagnosticsAt("note-a", 2)).toHaveLength(0);
    });

    it("ignores stale diagnostic writes for notes that are no longer active", () => {
        setCurrentActiveGrammarDiagnosticsNoteForTests("note-a");
        setActiveGrammarDiagnosticsForTests("note-a", [
            {
                from: 0,
                to: 4,
                message: "Issue A",
                replacements: [],
                severity: "warning",
            },
        ]);

        setCurrentActiveGrammarDiagnosticsNoteForTests("note-b");
        setActiveGrammarDiagnosticsForTests("note-a", [
            {
                from: 0,
                to: 4,
                message: "Stale issue",
                replacements: [],
                severity: "warning",
            },
        ]);

        expect(findGrammarDiagnosticsAt("note-a", 2)).toHaveLength(0);
    });

    it("clears all active diagnostics when grammar is disabled", () => {
        setCurrentActiveGrammarDiagnosticsNoteForTests("note-a");
        setActiveGrammarDiagnosticsForTests("note-a", [
            {
                from: 0,
                to: 4,
                message: "Issue A",
                replacements: [],
                severity: "warning",
            },
        ]);

        setCurrentActiveGrammarDiagnosticsNoteForTests(null);

        expect(findGrammarDiagnosticsAt("note-a", 2)).toHaveLength(0);
    });
});
