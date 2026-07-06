import { describe, expect, it } from "vitest";
import {
    KNOWN_STATUSES,
    isKnownStatus,
    normalizeDocumentStatus,
    statusDotColor,
    statusLabel,
    statusTone,
} from "./status";

describe("normalizeDocumentStatus", () => {
    it("returns null for non-string input", () => {
        expect(normalizeDocumentStatus(null)).toBeNull();
        expect(normalizeDocumentStatus(undefined)).toBeNull();
        expect(normalizeDocumentStatus(42)).toBeNull();
        expect(normalizeDocumentStatus(["draft"])).toBeNull();
        expect(normalizeDocumentStatus({})).toBeNull();
    });

    it("returns null for empty or whitespace-only input", () => {
        expect(normalizeDocumentStatus("")).toBeNull();
        expect(normalizeDocumentStatus("   ")).toBeNull();
        expect(normalizeDocumentStatus("\t\n")).toBeNull();
    });

    it("trims and lowercases", () => {
        expect(normalizeDocumentStatus("  Draft  ")).toBe("draft");
        expect(normalizeDocumentStatus("PUBLISHED")).toBe("published");
    });

    it("collapses spaces and hyphens to underscores", () => {
        expect(normalizeDocumentStatus("in review")).toBe("in_review");
        expect(normalizeDocumentStatus("in-review")).toBe("in_review");
        expect(normalizeDocumentStatus("in   review")).toBe("in_review");
        expect(normalizeDocumentStatus("in - review")).toBe("in_review");
        expect(normalizeDocumentStatus("In Review")).toBe("in_review");
    });

    it("aliases 'review' to 'in_review'", () => {
        expect(normalizeDocumentStatus("review")).toBe("in_review");
        expect(normalizeDocumentStatus("  Review ")).toBe("in_review");
    });

    it("returns unknown values normalized rather than dropping them", () => {
        expect(normalizeDocumentStatus("Needs Work")).toBe("needs_work");
        expect(normalizeDocumentStatus("custom-status")).toBe("custom_status");
    });
});

describe("isKnownStatus", () => {
    it("recognizes the canonical statuses", () => {
        for (const s of KNOWN_STATUSES) {
            expect(isKnownStatus(s)).toBe(true);
        }
    });

    it("rejects unknown values", () => {
        expect(isKnownStatus("needs_work")).toBe(false);
        expect(isKnownStatus("review")).toBe(false);
    });
});

describe("statusLabel", () => {
    it("labels known statuses", () => {
        expect(statusLabel("draft")).toBe("Draft");
        expect(statusLabel("in_review")).toBe("In review");
        expect(statusLabel("published")).toBe("Published");
        expect(statusLabel("deprecated")).toBe("Deprecated");
        expect(statusLabel("archived")).toBe("Archived");
    });

    it("renders unknown statuses with underscores as spaces", () => {
        expect(statusLabel("needs_work")).toBe("needs work");
        expect(statusLabel("custom")).toBe("custom");
    });
});

describe("statusTone", () => {
    it("maps known statuses to tones", () => {
        expect(statusTone("draft")).toBe("muted");
        expect(statusTone("in_review")).toBe("accent");
        expect(statusTone("published")).toBe("success");
        expect(statusTone("deprecated")).toBe("warning");
        expect(statusTone("archived")).toBe("muted");
    });

    it("falls back to muted for unknown statuses", () => {
        expect(statusTone("needs_work")).toBe("muted");
    });
});

describe("statusDotColor", () => {
    it("returns a color for each known status", () => {
        for (const s of KNOWN_STATUSES) {
            expect(statusDotColor(s)).toBeTruthy();
        }
    });

    it("uses green for published and accent for in_review", () => {
        expect(statusDotColor("published")).toBe("#22c55e");
        expect(statusDotColor("in_review")).toBe("var(--accent)");
    });

    it("falls back to a muted color for unknown statuses", () => {
        expect(statusDotColor("mystery")).toBe("var(--text-secondary)");
    });
});
